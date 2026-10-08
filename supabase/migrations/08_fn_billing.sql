-- =============================================================
-- 08 计费函数：收款计划生成 / 收款确认 / 状态同步
-- =============================================================

-- -------------------------------------------------------------
-- 某租约在 [d1,d2] 区间内被减免的天数
-- p_kind: 'rent' 看 waive_rent，'fee' 看 waive_fee
-- 多段可重叠，用日期展开去重，避免重复扣减
-- -------------------------------------------------------------
create or replace function public.waived_days(
  p_lease uuid, d1 date, d2 date, p_kind text
) returns int
language sql stable security definer set search_path = public as $$
  select count(distinct d)::int
  from public.lease_periods lp
  cross join generate_series(
        greatest(lp.start_date, d1),
        least(lp.end_date,   d2),
        interval '1 day') g(d)
  where lp.lease_id = p_lease
    and lp.start_date <= d2 and lp.end_date >= d1
    and ((p_kind = 'rent' and lp.waive_rent) or (p_kind = 'fee' and lp.waive_fee));
$$;

-- -------------------------------------------------------------
-- 取某日适用单价（阶梯优先，否则用合约基准）
-- -------------------------------------------------------------
create or replace function public.price_on(p_lease uuid, d date, p_kind text)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v numeric; l record;
begin
  select case when p_kind = 'rent' then s.rent_price else s.fee_price end into v
  from public.lease_price_steps s
  where s.lease_id = p_lease and d between s.start_date and s.end_date
    and case when p_kind = 'rent' then s.rent_price else s.fee_price end is not null
  order by s.start_date desc limit 1;

  if v is not null then return v; end if;

  select rent_price, fee_price into l from public.leases where id = p_lease;
  return case when p_kind = 'rent' then coalesce(l.rent_price,0) else coalesce(l.fee_price,0) end;
end $$;

-- -------------------------------------------------------------
-- 生成收款计划表（全生命周期）
-- 租金   = Σ 每自然月( 计租面积 × 单价[元/㎡/天] × 该月计费天数 )
-- 物业费 = Σ 每自然月( 计租面积 × 单价[元/㎡/月] × 该月计费天数 / 该月自然天数 )
-- 免租/装修期减免的天数不计费；金额为 0 的账期仍生成记录(status='waived')，
-- 以便"未来一年预期收入"表连续可读。
-- ownership 合约(已售物业) rent_price=0，只产生物业费。
-- p_regenerate=true 时先删除未收款的自动账单再重建（已收款账单保留）。
-- -------------------------------------------------------------
create or replace function public.generate_lease_schedule(
  p_lease uuid,
  p_regenerate boolean default false
) returns int
language plpgsql security definer set search_path = public as $$
declare
  l record;
  v_area numeric(14,2);
  v_cycle_start date; v_cycle_end date;
  v_m date; v_m_end date;
  v_dim int; v_days int; v_wv int;
  v_price numeric; v_amt numeric(14,2); v_total numeric(14,2);
  v_due date; v_seq int; v_charge uuid;
  v_count int := 0;
  v_kind text; v_ctype charge_type; v_cycle int;
begin
  select * into l from public.leases where id = p_lease;
  if not found then raise exception '租约不存在'; end if;

  if not public.can_write(l.park_id, array['pm','cs']::user_role[]) then
    raise exception '无权在该园区生成收款计划';
  end if;

  select coalesce(sum(area), 0) into v_area from public.lease_units where lease_id = p_lease;
  if v_area <= 0 then raise exception '请先为租约关联房源并确认计租面积'; end if;

  if p_regenerate then
    delete from public.charges
     where lease_id = p_lease
       and charge_type in ('rent','property_fee')
       and auto_generated
       and paid_amount = 0;
  end if;

  -- 依次处理 租金 与 物业费
  foreach v_kind in array array['rent','fee']::text[] loop
    v_ctype := case when v_kind = 'rent' then 'rent'::charge_type else 'property_fee'::charge_type end;
    v_cycle := case when v_kind = 'rent' then l.rent_cycle_months else l.fee_cycle_months end;

    -- ownership 合约不产生租金
    if v_kind = 'rent' and l.lease_kind = 'ownership' then
      continue;
    end if;

    v_seq := 0;
    v_cycle_start := l.start_date;

    while v_cycle_start <= l.end_date loop
      v_seq := v_seq + 1;
      -- 账期结束日：起始日 + N 个月 - 1 天，且不超过租约结束日
      v_cycle_end := least((v_cycle_start + (v_cycle || ' month')::interval - interval '1 day')::date,
                           l.end_date);
      v_total := 0;

      -- 已有收款的账期不重算，避免覆盖财务已确认数据
      if exists (select 1 from public.charges c
                 where c.lease_id = p_lease and c.charge_type = v_ctype
                   and c.period_start = v_cycle_start and c.paid_amount > 0) then
        v_cycle_start := (v_cycle_start + (v_cycle || ' month')::interval)::date;
        continue;
      end if;

      -- 应交日：账期首日提前 due_advance_days 天（滚动，随租约起始日）
      v_due := v_cycle_start - coalesce(l.due_advance_days, 0);

      insert into public.charges (park_id, lease_id, charge_type, period_start, period_end,
                                  bill_month, due_date, seq_no, amount, status, auto_generated)
      values (l.park_id, p_lease, v_ctype, v_cycle_start, v_cycle_end,
              date_trunc('month', v_cycle_start)::date, v_due, v_seq, 0, 'unpaid', true)
      on conflict (lease_id, charge_type, period_start) where charge_type in ('rent','property_fee')
      do update set period_end = excluded.period_end,
                    due_date   = excluded.due_date,
                    seq_no     = excluded.seq_no
      returning id into v_charge;

      delete from public.charge_details where charge_id = v_charge;

      -- 按自然月拆分
      v_m := date_trunc('month', v_cycle_start)::date;
      while v_m <= v_cycle_end loop
        v_m_end := least((date_trunc('month', v_m) + interval '1 month - 1 day')::date, v_cycle_end);
        v_dim   := public.days_in_month(v_m);
        v_days  := (v_m_end - greatest(v_m, v_cycle_start)) + 1;
        v_wv    := public.waived_days(p_lease, greatest(v_m, v_cycle_start), v_m_end, v_kind);
        v_price := public.price_on(p_lease, greatest(v_m, v_cycle_start), v_kind);

        if v_kind = 'rent' then
          v_amt := round(v_area * v_price * (v_days - v_wv), 2);
        else
          v_amt := round(v_area * v_price * (v_days - v_wv) / v_dim, 2);
        end if;

        insert into public.charge_details (charge_id, month, days_in_month, billable_days,
                                          waived_days, area, unit_price, amount)
        values (v_charge, v_m, v_dim, v_days - v_wv, v_wv, v_area, v_price, v_amt);

        v_total := v_total + v_amt;
        v_m := (date_trunc('month', v_m) + interval '1 month')::date;
      end loop;

      update public.charges
         set amount = v_total,
             status = case when v_total = 0 then 'waived'::charge_status
                           else status end
       where id = v_charge;

      v_count := v_count + 1;
      v_cycle_start := (v_cycle_start + (v_cycle || ' month')::interval)::date;
    end loop;
  end loop;

  update public.leases
     set schedule_generated_at = now(),
         status = case when status = 'draft' then 'active'::lease_status else status end
   where id = p_lease;

  insert into public.audit_logs (user_id, park_id, action, entity, entity_id, detail)
  values (auth.uid(), l.park_id, 'lease.generate_schedule', 'leases', p_lease::text,
          jsonb_build_object('charges', v_count, 'regenerate', p_regenerate));

  return v_count;
end $$;

-- -------------------------------------------------------------
-- 账单状态同步：paid_amount 变化时自动置 unpaid/partial/paid
-- -------------------------------------------------------------
create or replace function public.tg_charge_sync_status()
returns trigger language plpgsql as $$
begin
  if new.status = 'void' then return new; end if;

  if new.amount = 0 then
    new.status := 'waived';
  elsif new.paid_amount <= 0 then
    new.status := 'unpaid';
  elsif new.paid_amount + 0.005 >= new.amount then
    new.status := 'paid';
  else
    new.status := 'partial';
  end if;
  return new;
end $$;

create trigger trg_charges_sync before insert or update of amount, paid_amount
  on public.charges
  for each row execute function public.tg_charge_sync_status();

-- -------------------------------------------------------------
-- 收款流水变动后重算 charges.paid_amount
-- -------------------------------------------------------------
create or replace function public.tg_payment_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_charge uuid;
begin
  v_charge := coalesce(new.charge_id, old.charge_id);
  update public.charges c
     set paid_amount = coalesce((select sum(p.amount) from public.payments p
                                 where p.charge_id = v_charge), 0)
   where c.id = v_charge;
  return coalesce(new, old);
end $$;

create trigger trg_payments_rollup after insert or update or delete on public.payments
  for each row execute function public.tg_payment_rollup();

-- -------------------------------------------------------------
-- 确认收款（前端"确认收款"按钮调用）
-- p_voucher_path: Supabase Storage 中银行回单/收据路径，可为空
-- -------------------------------------------------------------
create or replace function public.confirm_payment(
  p_charge_id    uuid,
  p_amount       numeric default null,      -- 空 = 全额收款（应交 - 已收）
  p_paid_at      date default current_date,
  p_method       payment_method default 'bank_transfer',
  p_reference_no text default null,
  p_voucher_path text default null,
  p_remark       text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; v_amt numeric(14,2); v_pay uuid;
begin
  select * into c from public.charges where id = p_charge_id;
  if not found then raise exception '账单不存在'; end if;

  if not public.can_write(c.park_id, array['pm','cs']::user_role[]) then
    raise exception '无权确认该园区收款';
  end if;

  v_amt := coalesce(p_amount, c.amount - c.paid_amount);
  if v_amt <= 0 then raise exception '本次收款金额必须大于 0（当前应收余额 %）', c.amount - c.paid_amount; end if;

  insert into public.payments (charge_id, park_id, amount, paid_at, method,
                               reference_no, confirmed_by, remark)
  values (p_charge_id, c.park_id, v_amt, p_paid_at, p_method,
          p_reference_no, auth.uid(), p_remark)
  returning id into v_pay;

  if p_voucher_path is not null then
    insert into public.attachments (park_id, owner_type, owner_id, path,
                                    category, uploaded_by)
    values (c.park_id, 'payment', v_pay::text, p_voucher_path, 'bank_receipt', auth.uid());
  end if;

  insert into public.audit_logs (user_id, park_id, action, entity, entity_id, detail)
  values (auth.uid(), c.park_id, 'payment.confirm', 'charges', p_charge_id::text,
          jsonb_build_object('amount', v_amt, 'method', p_method, 'reference_no', p_reference_no));

  return v_pay;
end $$;
