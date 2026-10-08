-- =============================================================
-- 09 能源函数：上期读数自动带入 / 金额计算 / 自动出账 / 损耗分摊
-- =============================================================

-- -------------------------------------------------------------
-- 抄表写入前：自动带入上期读数、计算用量与金额
-- 上期读数 = 该表上一期(bill_month 更早)的 curr_reading，无则取 init_reading（默认 0）
-- -------------------------------------------------------------
create or replace function public.tg_reading_prepare()
returns trigger language plpgsql security definer set search_path = public as $$
declare m record; v_prev numeric(14,3); v_prev_date date;
begin
  select * into m from public.meters where id = new.meter_id;
  if not found then raise exception '表不存在'; end if;

  new.park_id    := m.park_id;
  new.multiplier := coalesce(nullif(new.multiplier, 0), m.multiplier, 1);
  if new.lease_id is null then new.lease_id := m.lease_id; end if;

  -- 上期读数：仅当调用方未显式提供（为 0 或 null）时自动带入
  if coalesce(new.prev_reading, 0) = 0 then
    select r.curr_reading, r.read_date into v_prev, v_prev_date
    from public.meter_readings r
    where r.meter_id = new.meter_id
      and r.bill_month < new.bill_month
    order by r.bill_month desc limit 1;

    new.prev_reading := coalesce(v_prev, m.init_reading, 0);
    if new.period_start is null then
      new.period_start := coalesce(v_prev_date, date_trunc('month', new.bill_month)::date);
    end if;
  end if;

  if new.period_start is null then
    new.period_start := date_trunc('month', new.bill_month)::date;
  end if;

  new.bill_month := date_trunc('month', new.bill_month)::date;
  new.usage  := round(greatest(new.curr_reading - new.prev_reading, 0) * new.multiplier, 3);
  new.amount := round((new.usage + coalesce(new.loss_usage,0)) * coalesce(new.unit_price,0), 2);
  return new;
end $$;

create trigger trg_readings_prepare before insert or update on public.meter_readings
  for each row execute function public.tg_reading_prepare();

-- -------------------------------------------------------------
-- 抄表落库后：自动生成/更新对应水电账单
-- 公共表(is_public)不直接出账，其用量通过损耗分摊进入各租户账单
-- 应交日期 = 抄表日 + park_settings.utility_due_days
-- -------------------------------------------------------------
create or replace function public.tg_reading_to_charge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m record; v_type charge_type; v_due_days int; v_charge uuid;
begin
  select * into m from public.meters where id = new.meter_id;
  if m.is_public or m.is_master or new.lease_id is null then
    return new;
  end if;

  v_type := case m.meter_type when 'water' then 'water'::charge_type
                              else 'electricity'::charge_type end;

  select coalesce(utility_due_days, 15) into v_due_days
  from public.park_settings where park_id = new.park_id;

  select id into v_charge from public.charges
  where reading_id = new.id and charge_type = v_type limit 1;

  if v_charge is null then
    insert into public.charges (park_id, lease_id, charge_type, period_start, period_end,
                                bill_month, due_date, seq_no, amount, reading_id, auto_generated)
    values (new.park_id, new.lease_id, v_type, new.period_start, new.read_date,
            new.bill_month, new.read_date + coalesce(v_due_days,15), 1,
            new.amount, new.id, true);
  else
    update public.charges
       set amount       = new.amount,
           period_start = new.period_start,
           period_end   = new.read_date,
           bill_month   = new.bill_month,
           due_date     = new.read_date + coalesce(v_due_days,15),
           lease_id     = new.lease_id
     where id = v_charge;
  end if;

  return new;
end $$;

create trigger trg_readings_to_charge after insert or update on public.meter_readings
  for each row execute function public.tg_reading_to_charge();

-- -------------------------------------------------------------
-- 损耗分摊
-- 损耗量 = 总表用量 - Σ租户表用量（若无总表，则用 损耗比例 × Σ租户用量）
--          + 公共表用量（走廊、停车场等，一并计入待分摊池）
-- 分摊方式：by_area 按计租建筑面积比例 / by_usage 按用量比例 / none 不分摊
-- 分摊结果写入 meter_readings.loss_usage，直接加到各租户账单
-- 前端在"能源管理"页按园区+月份+表类型调用一次即可
-- -------------------------------------------------------------
create or replace function public.allocate_energy_loss(
  p_park       uuid,
  p_bill_month date,
  p_type       meter_type
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_bill_month)::date;
  v_method loss_alloc_method; v_ratio numeric;
  v_master numeric := 0; v_tenant numeric := 0; v_public numeric := 0;
  v_loss numeric := 0; v_base numeric := 0;
  r record;
begin
  if not public.can_write(p_park, array['pm','engineer']::user_role[]) then
    raise exception '无权在该园区执行损耗分摊';
  end if;

  select case when p_type = 'water' then water_loss_method else elec_loss_method end,
         case when p_type = 'water' then water_loss_ratio  else elec_loss_ratio  end
    into v_method, v_ratio
  from public.park_settings where park_id = p_park;

  if v_method is null or v_method = 'none' then return 0; end if;

  select coalesce(sum(r2.usage),0) into v_master
  from public.meter_readings r2 join public.meters m on m.id = r2.meter_id
  where r2.park_id = p_park and r2.bill_month = v_month
    and m.meter_type = p_type and m.is_master;

  select coalesce(sum(r2.usage),0) into v_public
  from public.meter_readings r2 join public.meters m on m.id = r2.meter_id
  where r2.park_id = p_park and r2.bill_month = v_month
    and m.meter_type = p_type and m.is_public and not m.is_master;

  select coalesce(sum(r2.usage),0) into v_tenant
  from public.meter_readings r2 join public.meters m on m.id = r2.meter_id
  where r2.park_id = p_park and r2.bill_month = v_month
    and m.meter_type = p_type and not m.is_public and not m.is_master
    and r2.lease_id is not null;

  if v_tenant <= 0 then return 0; end if;

  if v_master > 0 then
    v_loss := greatest(v_master - v_tenant, 0);
  else
    v_loss := round(v_tenant * coalesce(v_ratio,0), 3) + v_public;
  end if;

  if v_loss <= 0 then
    update public.meter_readings r2 set loss_usage = 0
    from public.meters m
    where m.id = r2.meter_id and r2.park_id = p_park and r2.bill_month = v_month
      and m.meter_type = p_type and not m.is_public and not m.is_master;
    return 0;
  end if;

  -- 分摊基数
  if v_method = 'by_area' then
    select coalesce(sum(lu.area),0) into v_base
    from public.meter_readings r2
    join public.meters m on m.id = r2.meter_id
    join public.lease_units lu on lu.lease_id = r2.lease_id
    where r2.park_id = p_park and r2.bill_month = v_month
      and m.meter_type = p_type and not m.is_public and not m.is_master
      and r2.lease_id is not null;
  else
    v_base := v_tenant;
  end if;

  if v_base <= 0 then return 0; end if;

  for r in
    select r2.id,
           case when v_method = 'by_area'
                then coalesce((select sum(lu.area) from public.lease_units lu
                               where lu.lease_id = r2.lease_id), 0)
                else r2.usage end as weight
    from public.meter_readings r2
    join public.meters m on m.id = r2.meter_id
    where r2.park_id = p_park and r2.bill_month = v_month
      and m.meter_type = p_type and not m.is_public and not m.is_master
      and r2.lease_id is not null
  loop
    update public.meter_readings
       set loss_usage = round(v_loss * r.weight / v_base, 3)
     where id = r.id;   -- before-update 触发器会重算 amount，after 触发器会同步账单
  end loop;

  insert into public.audit_logs (user_id, park_id, action, entity, detail)
  values (auth.uid(), p_park, 'energy.allocate_loss', 'meter_readings',
          jsonb_build_object('month', v_month, 'type', p_type, 'loss', v_loss, 'method', v_method));

  return v_loss;
end $$;
