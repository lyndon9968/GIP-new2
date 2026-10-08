-- =============================================================
-- 10 视图：房源状态机 / 账单预警 / 租约卡片
-- 所有视图使用 security_invoker，RLS 按调用者身份生效
-- =============================================================

-- -------------------------------------------------------------
-- 租约生效/失效时同步房源状态
-- -------------------------------------------------------------
create or replace function public.refresh_unit_status(p_lease uuid)
returns void language plpgsql security definer set search_path = public as $$
declare l record;
begin
  select * into l from public.leases where id = p_lease;
  if not found then return; end if;

  if l.status = 'active' then
    update public.units u
       set status = case when l.lease_kind = 'ownership' then 'sold'::unit_status
                         else 'leased'::unit_status end
     where u.id in (select unit_id from public.lease_units where lease_id = p_lease)
       and u.status not in ('voided');
  elsif l.status in ('expired','terminated') then
    update public.units u
       set status = 'vacant'
     where u.id in (select unit_id from public.lease_units where lease_id = p_lease)
       and u.status = 'leased'
       and not exists (
         select 1 from public.lease_units lu2
         join public.leases l2 on l2.id = lu2.lease_id
         where lu2.unit_id = u.id and l2.id <> p_lease and l2.status = 'active');
  end if;
end $$;

create or replace function public.tg_lease_status_units()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_unit_status(new.id);
  return new;
end $$;

create trigger trg_leases_units_status after insert or update of status on public.leases
  for each row execute function public.tg_lease_status_units();

-- -------------------------------------------------------------
-- 账单卡片：逾期天数（次日起算）与预警等级
-- alert_level 0 正常/未到期  1 今日到期或7日内到期  2 逾期1-6天  3 逾期≥7天(警示红闪烁)
-- -------------------------------------------------------------
create or replace view public.v_charges as
select
  c.*,
  l.contract_no,
  l.lease_kind,
  p.name  as party_name,
  p.kind  as party_kind,
  pk.name as park_name,
  greatest(0, current_date - c.due_date) as overdue_days,
  (c.amount - c.paid_amount)             as balance,
  case
    when c.status in ('paid','waived','void') then 0
    when current_date - c.due_date >= coalesce(ps.overdue_alert_days, 7) then 3
    when current_date - c.due_date >= 1 then 2
    when c.due_date - current_date between 0 and 7 then 1
    else 0
  end as alert_level
from public.charges c
join public.leases  l  on l.id  = c.lease_id
join public.parties p  on p.id  = l.party_id
join public.parks   pk on pk.id = c.park_id
left join public.park_settings ps on ps.park_id = c.park_id;

alter view public.v_charges set (security_invoker = true);

-- -------------------------------------------------------------
-- 房源状态机：存储状态 + 派生状态
-- display_status: sold(已售) / fitout(装修中) / overdue(欠费中)
--                 / leased(已租) / reserved(预留) / vacant(空置) / voided(已注销)
-- 优先级：voided > sold > overdue > fitout > leased > reserved > vacant
-- -------------------------------------------------------------
create or replace view public.v_unit_status as
with active_lease as (
  select lu.unit_id, l.id as lease_id, l.contract_no, l.lease_kind,
         l.start_date, l.end_date, l.party_id, pt.name as party_name,
         lu.usable_area as lease_usable, lu.shared_area as lease_shared, lu.area as lease_area
  from public.lease_units lu
  join public.leases  l  on l.id = lu.lease_id and l.status = 'active'
  join public.parties pt on pt.id = l.party_id
),
lease_flags as (
  select l.id as lease_id,
         exists (select 1 from public.lease_periods lp
                  where lp.lease_id = l.id and lp.kind = 'fitout'
                    and current_date between lp.start_date and lp.end_date) as in_fitout,
         coalesce((select max(greatest(0, current_date - c.due_date))
                     from public.charges c
                    where c.lease_id = l.id
                      and c.status in ('unpaid','partial')), 0) as max_overdue_days
  from public.leases l where l.status = 'active'
),
flags as (
  select al.unit_id,
         bool_or(lf.in_fitout)                     as in_fitout,
         bool_or(lf.max_overdue_days > 0)          as has_overdue,
         max(lf.max_overdue_days)                  as max_overdue_days
  from active_lease al
  join lease_flags lf on lf.lease_id = al.lease_id
  group by al.unit_id
)
select
  u.id, u.park_id, u.building_id, b.code as building_code, pk.name as park_name,
  u.unit_no, u.floor, u.seq,
  u.usable_area, u.shared_area, u.area,
  u.purpose, u.status, u.is_rentable, u.is_saleable, u.remark,
  al.lease_id, al.contract_no, al.lease_kind, al.party_id, al.party_name,
  al.start_date as lease_start, al.end_date as lease_end,
  coalesce(f.in_fitout, false)  as in_fitout,
  coalesce(f.has_overdue, false) as has_overdue,
  coalesce(f.max_overdue_days, 0) as max_overdue_days,
  case
    when u.status = 'voided'  then 'voided'
    when u.status = 'sold'    then case when coalesce(f.has_overdue,false) then 'sold_overdue' else 'sold' end
    when coalesce(f.has_overdue,false) then 'overdue'
    when coalesce(f.in_fitout,false)   then 'fitout'
    when u.status = 'leased'   then 'leased'
    when u.status = 'reserved' then 'reserved'
    else 'vacant'
  end as display_status
from public.units u
join public.buildings b on b.id = u.building_id
join public.parks    pk on pk.id = u.park_id
left join active_lease al on al.unit_id = u.id
left join flags        f  on f.unit_id  = u.id;

alter view public.v_unit_status set (security_invoker = true);

-- -------------------------------------------------------------
-- 租约卡片（租约管理模块主数据源，一张卡一行）
-- 含房源清单、单价、起止、免租/装修期、本期应交租金/物业费/水费/电费及应交日与逾期
-- -------------------------------------------------------------
create or replace view public.v_lease_cards as
select
  l.id as lease_id, l.park_id, pk.name as park_name,
  l.contract_no, l.lease_kind, l.status,
  pt.id as party_id, pt.name as party_name, pt.kind as party_kind,
  pt.contact_name, pt.contact_phone,
  l.start_date, l.end_date, l.rent_price, l.fee_price,
  l.rent_cycle_months, l.fee_cycle_months, l.due_advance_days,
  l.deposit_amount,
  coalesce(l.water_price, ps.water_price)             as water_price,
  coalesce(l.electricity_price, ps.electricity_price) as electricity_price,

  -- 房源清单
  (select string_agg(b.code || '栋 ' || u.floor || 'F ' || u.unit_no, '、'
                     order by b.code, u.floor, u.unit_no)
     from public.lease_units lu
     join public.units u     on u.id = lu.unit_id
     join public.buildings b on b.id = u.building_id
    where lu.lease_id = l.id) as unit_list,
  (select coalesce(sum(lu.usable_area),0) from public.lease_units lu where lu.lease_id = l.id) as usable_area,
  (select coalesce(sum(lu.shared_area),0) from public.lease_units lu where lu.lease_id = l.id) as shared_area,
  (select coalesce(sum(lu.area),0)        from public.lease_units lu where lu.lease_id = l.id) as total_area,

  -- 免租期 / 装修期（月数为展示用，实际按自由设定的起止日计算）
  (select coalesce(sum((lp.end_date - lp.start_date + 1)::numeric / 30.0), 0)
     from public.lease_periods lp where lp.lease_id = l.id and lp.kind = 'rent_free') as rent_free_months,
  (select coalesce(sum((lp.end_date - lp.start_date + 1)::numeric / 30.0), 0)
     from public.lease_periods lp where lp.lease_id = l.id and lp.kind = 'fitout')    as fitout_months,

  -- 本期应交（各费种取最早未结清账单）
  r.amount as rent_due_amount,   r.due_date as rent_due_date,   r.overdue_days as rent_overdue_days,   r.alert_level as rent_alert,
  f.amount as fee_due_amount,    f.due_date as fee_due_date,    f.overdue_days as fee_overdue_days,    f.alert_level as fee_alert,
  w.amount as water_due_amount,  w.due_date as water_due_date,  w.overdue_days as water_overdue_days,  w.alert_level as water_alert,
  e.amount as elec_due_amount,   e.due_date as elec_due_date,   e.overdue_days as elec_overdue_days,   e.alert_level as elec_alert,
  r.id as rent_charge_id, f.id as fee_charge_id, w.id as water_charge_id, e.id as elec_charge_id,

  greatest(coalesce(r.alert_level,0), coalesce(f.alert_level,0),
           coalesce(w.alert_level,0), coalesce(e.alert_level,0)) as max_alert_level,
  (select coalesce(sum(c.amount - c.paid_amount), 0) from public.charges c
    where c.lease_id = l.id and c.status in ('unpaid','partial')) as total_balance,
  (select coalesce(max(greatest(0, current_date - c.due_date)), 0) from public.charges c
    where c.lease_id = l.id and c.status in ('unpaid','partial')) as max_overdue_days
from public.leases l
join public.parties pt on pt.id = l.party_id
join public.parks   pk on pk.id = l.park_id
left join public.park_settings ps on ps.park_id = l.park_id
left join lateral (select * from public.v_charges c where c.lease_id = l.id and c.charge_type='rent'
                    and c.status in ('unpaid','partial') order by c.due_date limit 1) r on true
left join lateral (select * from public.v_charges c where c.lease_id = l.id and c.charge_type='property_fee'
                    and c.status in ('unpaid','partial') order by c.due_date limit 1) f on true
left join lateral (select * from public.v_charges c where c.lease_id = l.id and c.charge_type='water'
                    and c.status in ('unpaid','partial') order by c.due_date limit 1) w on true
left join lateral (select * from public.v_charges c where c.lease_id = l.id and c.charge_type='electricity'
                    and c.status in ('unpaid','partial') order by c.due_date limit 1) e on true;

alter view public.v_lease_cards set (security_invoker = true);
