-- =============================================================
-- 11 视图：数据概览（公司级 / 园区级）、能源统计、预期收入
-- =============================================================

-- -------------------------------------------------------------
-- 园区概览
-- 出租率 = 已租面积 / 可出租面积（人工录入优先；未录入时按有效出租房源汇总）
-- 销售率 = 已售面积 / 可销售面积
-- has_rental / has_sale 用于前端决定是否显示对应饼图
-- -------------------------------------------------------------
create or replace view public.v_park_overview as
with ua as (
  select park_id,
    sum(case when is_rentable and status <> 'voided' and status <> 'sold' then area else 0 end) as rentable_area,
    sum(case when status = 'leased' then area else 0 end)                                       as leased_area,
    sum(case when is_saleable and status <> 'voided' then area else 0 end)                      as saleable_area,
    sum(case when status = 'sold' then area else 0 end)                                         as sold_area,
    sum(case when status = 'vacant' and is_rentable then area else 0 end)                       as vacant_area,
    count(*) filter (where status <> 'voided')                                                  as unit_count,
    sum(case when status <> 'voided' then usable_area else 0 end)                               as usable_area,
    sum(case when status <> 'voided' then shared_area else 0 end)                               as shared_area
  from public.units group by park_id
),
bl as (
  select park_id, count(*) as building_count, coalesce(sum(gfa),0) as gfa_sum
  from public.buildings group by park_id
),
cm as (   -- 当月水电费（按账单归属月汇总，含分摊损耗）
  select r.park_id,
    sum(case when m.meter_type = 'water'       then r.amount else 0 end) as water_amount_month,
    sum(case when m.meter_type = 'electricity' then r.amount else 0 end) as elec_amount_month,
    sum(case when m.meter_type = 'water'       then r.usage + r.loss_usage else 0 end) as water_usage_month,
    sum(case when m.meter_type = 'electricity' then r.usage + r.loss_usage else 0 end) as elec_usage_month
  from public.meter_readings r
  join public.meters m on m.id = r.meter_id
  where r.bill_month = date_trunc('month', current_date)::date
  group by r.park_id
)
select
  p.id as park_id, p.code, p.name, p.city, p.sort_order,
  p.land_area, p.parking_count,
  coalesce(bl.building_count, p.building_count) as building_count,
  p.gfa_above, p.gfa_below,
  (p.gfa_above + p.gfa_below) as gfa_total,
  coalesce(ua.usable_area,0)   as usable_area,
  coalesce(ua.shared_area,0)   as shared_area,
  coalesce(ua.unit_count,0)    as unit_count,
  coalesce(p.rentable_area,ua.rentable_area,0) as rentable_area,
  coalesce(ua.leased_area,0)   as leased_area,
  greatest(coalesce(p.rentable_area,ua.rentable_area,0) - coalesce(ua.leased_area,0),0) as vacant_area,
  coalesce(ua.saleable_area,0) as saleable_area,
  coalesce(ua.sold_area,0)     as sold_area,
  case when coalesce(p.rentable_area,ua.rentable_area,0) > 0
       then round(coalesce(ua.leased_area,0) / coalesce(p.rentable_area,ua.rentable_area,0) * 100, 2) else null end as occupancy_rate,
  case when coalesce(ua.saleable_area,0) > 0
       then round(ua.sold_area / ua.saleable_area * 100, 2)  else null end as sale_rate,
  (coalesce(p.rentable_area,ua.rentable_area,0) > 0) as has_rental,
  (coalesce(ua.saleable_area,0) > 0) as has_sale,
  coalesce(cm.water_amount_month,0) as water_amount_month,
  coalesce(cm.elec_amount_month,0)  as elec_amount_month,
  coalesce(cm.water_usage_month,0)  as water_usage_month,
  coalesce(cm.elec_usage_month,0)   as elec_usage_month
from public.parks p
left join ua on ua.park_id = p.id
left join bl on bl.park_id = p.id
left join cm on cm.park_id = p.id
where p.is_active;

alter view public.v_park_overview set (security_invoker = true);

-- -------------------------------------------------------------
-- 已收款汇总（按园区 / 费种 / 月，以实收 paid_at 为准）
-- -------------------------------------------------------------
create or replace view public.v_income_monthly as
select
  pay.park_id,
  c.charge_type,
  date_trunc('month', pay.paid_at)::date as month,
  sum(pay.amount) as amount
from public.payments pay
join public.charges c on c.id = pay.charge_id
group by pay.park_id, c.charge_type, date_trunc('month', pay.paid_at)::date;

alter view public.v_income_monthly set (security_invoker = true);

-- -------------------------------------------------------------
-- 公司级总览（数据概览模块顶部指标卡）
-- 累计 = 全部已收；当年 = 财年内已收
-- -------------------------------------------------------------
create or replace view public.v_company_overview as
with area as (
  select
    sum(o.gfa_total)      as total_gfa,
    sum(o.land_area)      as total_land_area,
    sum(o.rentable_area)  as rentable_area,
    sum(o.leased_area)    as leased_area,
    sum(o.saleable_area)  as saleable_area,
    sum(o.sold_area)      as sold_area,
    sum(o.parking_count)  as parking_count,
    sum(o.building_count) as building_count,
    count(*)              as park_count
  from public.v_park_overview o
),
inc as (
  select
    sum(case when c.charge_type = 'rent'         then pay.amount else 0 end) as rent_total,
    sum(case when c.charge_type = 'property_fee' then pay.amount else 0 end) as fee_total,
    sum(case when c.charge_type = 'rent'
              and pay.paid_at >= date_trunc('year', current_date)::date then pay.amount else 0 end) as rent_ytd,
    sum(case when c.charge_type = 'property_fee'
              and pay.paid_at >= date_trunc('year', current_date)::date then pay.amount else 0 end) as fee_ytd
  from public.payments pay
  join public.charges c on c.id = pay.charge_id
),
ovd as (
  select count(*) as overdue_count,
         coalesce(sum(balance),0) as overdue_amount,
         count(*) filter (where alert_level = 3) as critical_count
  from public.v_charges where alert_level >= 2
)
select
  coalesce(area.total_gfa,0)       as total_managed_area,
  coalesce(area.total_land_area,0) as total_land_area,
  coalesce(area.park_count,0)      as park_count,
  coalesce(area.building_count,0)  as building_count,
  coalesce(area.parking_count,0)   as parking_count,
  coalesce(inc.rent_total,0)       as rent_income_total,
  coalesce(inc.rent_ytd,0)         as rent_income_ytd,
  coalesce(inc.fee_total,0)        as fee_income_total,
  coalesce(inc.fee_ytd,0)          as fee_income_ytd,
  coalesce(area.rentable_area,0)   as rentable_area,
  coalesce(area.leased_area,0)     as leased_area,
  coalesce(area.saleable_area,0)   as saleable_area,
  coalesce(area.sold_area,0)       as sold_area,
  case when coalesce(area.rentable_area,0) > 0
       then round(area.leased_area / area.rentable_area * 100, 2) else 0 end as occupancy_rate,
  case when coalesce(area.saleable_area,0) > 0
       then round(area.sold_area / area.saleable_area * 100, 2)  else 0 end as sale_rate,
  coalesce(ovd.overdue_count,0)    as overdue_count,
  coalesce(ovd.overdue_amount,0)   as overdue_amount,
  coalesce(ovd.critical_count,0)   as critical_overdue_count
from area cross join inc cross join ovd;

alter view public.v_company_overview set (security_invoker = true);

-- -------------------------------------------------------------
-- 能源月度统计：本月及此前 5 个月（能源管理页两个柱状图数据源）
-- 按园区 + 租约 + 表类型 + 月 汇总
-- -------------------------------------------------------------
create or replace view public.v_energy_monthly as
select
  r.park_id,
  r.lease_id,
  m.meter_type,
  r.bill_month as month,
  sum(r.usage)                    as usage,
  sum(r.loss_usage)               as loss_usage,
  sum(r.usage + r.loss_usage)     as total_usage,
  sum(r.amount)                   as amount,
  count(*)                        as reading_count
from public.meter_readings r
join public.meters m on m.id = r.meter_id
where r.bill_month >= (date_trunc('month', current_date) - interval '5 months')::date
  and r.bill_month <= date_trunc('month', current_date)::date
group by r.park_id, r.lease_id, m.meter_type, r.bill_month;

alter view public.v_energy_monthly set (security_invoker = true);

-- -------------------------------------------------------------
-- 抄表卡片（能源管理页，每租户一卡；含上月读数自动带出）
-- -------------------------------------------------------------
create or replace view public.v_meter_cards as
select
  m.id as meter_id, m.park_id, m.meter_no, m.meter_type, m.multiplier,
  m.is_public, m.is_master, m.location, m.is_active,
  b.code as building_code, u.unit_no,
  m.lease_id, l.contract_no, pt.name as party_name,
  lastr.bill_month   as last_bill_month,
  lastr.curr_reading as last_reading,
  lastr.read_date    as last_read_date,
  coalesce(lastr.curr_reading, m.init_reading, 0) as prev_reading_for_next,
  cur.id             as current_reading_id,
  cur.curr_reading   as current_reading,
  cur.usage          as current_usage,
  cur.loss_usage     as current_loss,
  cur.unit_price     as current_price,
  cur.amount         as current_amount,
  coalesce(l.water_price, ps.water_price)             as default_water_price,
  coalesce(l.electricity_price, ps.electricity_price) as default_elec_price
from public.meters m
left join public.units     u  on u.id  = m.unit_id
left join public.buildings b  on b.id  = coalesce(m.building_id, u.building_id)
left join public.leases    l  on l.id  = m.lease_id
left join public.parties   pt on pt.id = l.party_id
left join public.park_settings ps on ps.park_id = m.park_id
left join lateral (
  select r.* from public.meter_readings r
  where r.meter_id = m.id and r.bill_month < date_trunc('month', current_date)::date
  order by r.bill_month desc limit 1) lastr on true
left join lateral (
  select r.* from public.meter_readings r
  where r.meter_id = m.id and r.bill_month = date_trunc('month', current_date)::date
  limit 1) cur on true;

alter view public.v_meter_cards set (security_invoker = true);

-- -------------------------------------------------------------
-- 预期收入（收款计划表已生成全生命周期，直接按月汇总）
-- 总经理看未来 12 个月预期租金/物业费
-- -------------------------------------------------------------
create or replace view public.v_expected_income as
select
  c.park_id,
  c.charge_type,
  c.bill_month as month,
  sum(c.amount)                                            as expected_amount,
  sum(c.paid_amount)                                       as received_amount,
  sum(c.amount - c.paid_amount)                            as outstanding_amount,
  count(*)                                                 as charge_count
from public.charges c
where c.status <> 'void'
group by c.park_id, c.charge_type, c.bill_month;

alter view public.v_expected_income set (security_invoker = true);
