-- =============================================================
-- 14 园区可出租面积：人工录入优先，留空按房源汇总
-- 已上线项目只需执行本文件。可重复执行，不删除园区、房源或账单。
-- =============================================================
begin;

alter table public.parks
  add column if not exists rentable_area numeric(14,2)
    constraint parks_rentable_area_nonnegative check (rentable_area >= 0);

comment on column public.parks.rentable_area is
  '人工录入的可出租面积（㎡）；NULL 按有效可出租房源汇总，0 表示无出租物业';

-- 保持视图列名、顺序和权限，现有公司概览自动使用新统计口径。
create or replace view public.v_park_overview as
with ua as (
  select park_id,
    sum(case when is_rentable and status <> 'voided' and status <> 'sold' then area else 0 end) as rentable_area,
    sum(case when status = 'leased' then area else 0 end) as leased_area,
    sum(case when is_saleable and status <> 'voided' then area else 0 end) as saleable_area,
    sum(case when status = 'sold' then area else 0 end) as sold_area,
    count(*) filter (where status <> 'voided') as unit_count,
    sum(case when status <> 'voided' then usable_area else 0 end) as usable_area,
    sum(case when status <> 'voided' then shared_area else 0 end) as shared_area
  from public.units group by park_id
),
bl as (
  select park_id, count(*) as building_count, coalesce(sum(gfa),0) as gfa_sum
  from public.buildings group by park_id
),
cm as (
  select r.park_id,
    sum(case when m.meter_type = 'water' then r.amount else 0 end) as water_amount_month,
    sum(case when m.meter_type = 'electricity' then r.amount else 0 end) as elec_amount_month,
    sum(case when m.meter_type = 'water' then r.usage + r.loss_usage else 0 end) as water_usage_month,
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
  coalesce(ua.usable_area,0) as usable_area,
  coalesce(ua.shared_area,0) as shared_area,
  coalesce(ua.unit_count,0) as unit_count,
  coalesce(p.rentable_area,ua.rentable_area,0) as rentable_area,
  coalesce(ua.leased_area,0) as leased_area,
  greatest(coalesce(p.rentable_area,ua.rentable_area,0) - coalesce(ua.leased_area,0),0) as vacant_area,
  coalesce(ua.saleable_area,0) as saleable_area,
  coalesce(ua.sold_area,0) as sold_area,
  case when coalesce(p.rentable_area,ua.rentable_area,0) > 0
       then round(coalesce(ua.leased_area,0) / coalesce(p.rentable_area,ua.rentable_area,0) * 100, 2)
       else null end as occupancy_rate,
  case when coalesce(ua.saleable_area,0) > 0
       then round(ua.sold_area / ua.saleable_area * 100, 2) else null end as sale_rate,
  (coalesce(p.rentable_area,ua.rentable_area,0) > 0) as has_rental,
  (coalesce(ua.saleable_area,0) > 0) as has_sale,
  coalesce(cm.water_amount_month,0) as water_amount_month,
  coalesce(cm.elec_amount_month,0) as elec_amount_month,
  coalesce(cm.water_usage_month,0) as water_usage_month,
  coalesce(cm.elec_usage_month,0) as elec_usage_month
from public.parks p
left join ua on ua.park_id = p.id
left join bl on bl.park_id = p.id
left join cm on cm.park_id = p.id
where p.is_active;

alter view public.v_park_overview set (security_invoker = true);
notify pgrst, 'reload schema';
commit;

-- 执行成功后，可运行以下查询检查。尚未手填时 rentable_area 为 NULL。
-- select code, name, rentable_area from public.parks order by code;
-- select code, name, rentable_area, leased_area, occupancy_rate
--   from public.v_park_overview order by code;
