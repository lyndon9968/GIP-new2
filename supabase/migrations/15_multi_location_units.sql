-- =============================================================
-- 15 整栋、多层、跨栋房源；同园区跨栋跨层合并，保留租约及账单
-- 按 14 → 15 顺序执行。增量升级，不删除既有房源、租约或账单。
-- =============================================================
begin;

alter table public.units add column if not exists locations jsonb not null default '[]'::jsonb;
comment on column public.units.locations is
  '房源覆盖位置 [{building_id:uuid,floor:int}]；面积是整体面积，不按楼层重复计入。building_id/floor 作为编号锚点';

create or replace function public.tg_validate_unit_locations()
returns trigger language plpgsql set search_path = public as $$
declare v_item jsonb; v_park uuid; v_building uuid; v_floor int;
begin
  if jsonb_typeof(new.locations) is distinct from 'array' then
    raise exception '房源覆盖位置必须是数组';
  end if;
  if jsonb_array_length(new.locations) = 0 then
    new.locations := jsonb_build_array(jsonb_build_object('building_id',new.building_id,'floor',new.floor));
  end if;
  for v_item in select value from jsonb_array_elements(new.locations) loop
    if v_item->>'building_id' is null or v_item->>'floor' is null then
      raise exception '每个覆盖位置必须填写楼栋和楼层';
    end if;
    v_building := (v_item->>'building_id')::uuid;
    v_floor := (v_item->>'floor')::int;
    select park_id into v_park from public.buildings where id = v_building;
    if v_park is null or v_park <> new.park_id then
      raise exception '房源覆盖的所有楼栋必须属于同一园区';
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(new.locations) x
                 where (x->>'building_id')::uuid = new.building_id and (x->>'floor')::int = new.floor) then
    raise exception '覆盖位置必须包含房源编号所属的楼栋和楼层';
  end if;
  select jsonb_agg(jsonb_build_object('building_id',q.building_id,'floor',q.floor) order by q.code,q.floor)
    into new.locations
  from (select distinct b.id as building_id,b.code,(x->>'floor')::int as floor
        from jsonb_array_elements(new.locations) x
        join public.buildings b on b.id=(x->>'building_id')::uuid) q;
  return new;
end $$;

drop trigger if exists trg_units_locations on public.units;
create trigger trg_units_locations before insert or update of locations,building_id,floor,park_id on public.units
  for each row execute function public.tg_validate_unit_locations();

update public.units set locations=jsonb_build_array(jsonb_build_object('building_id',building_id,'floor',floor))
where locations='[]'::jsonb;

create or replace function public.unit_location_rows(p_unit uuid)
returns table(building_id uuid,floor int,building_code text)
language sql stable set search_path = public as $$
  select b.id,(x->>'floor')::int,b.code
  from public.units u
  cross join lateral jsonb_array_elements(u.locations) x
  join public.buildings b on b.id=(x->>'building_id')::uuid
  where u.id=p_unit
  order by b.code,(x->>'floor')::int;
$$;

create or replace function public.unit_location_label(p_unit uuid)
returns text language sql stable set search_path = public as $$
  select string_agg(building_code||'栋 '||case when floor<0 then 'B'||abs(floor)::text else floor::text end||'层','、'
                    order by building_code,floor)
  from public.unit_location_rows(p_unit);
$$;

-- 新增合同关联与合并共用房源行锁，避免并发把新合同挂到已注销房源。
create or replace function public.tg_validate_lease_unit_source()
returns trigger language plpgsql set search_path = public as $$
declare u record; l record;
begin
  select * into u from public.units where id=new.unit_id for key share;
  select * into l from public.leases where id=new.lease_id;
  if u.park_id is distinct from l.park_id then raise exception '租约和房源必须属于同一园区'; end if;
  if l.status in ('active','draft') and u.status='voided' then
    raise exception '已注销房源不能关联新租约，请选择合并或拆分后的新房源';
  end if;
  return new;
end $$;
drop trigger if exists trg_lease_units_source on public.lease_units;
create trigger trg_lease_units_source before insert or update of unit_id,lease_id on public.lease_units
  for each row execute function public.tg_validate_lease_unit_source();

create or replace function public.merge_units(
  p_unit_ids uuid[], p_purpose unit_purpose default null, p_reason text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_park uuid; v_bld uuid; v_floor int; v_locations jsonb;
  v_usable numeric(12,2); v_shared numeric(12,2); v_purpose unit_purpose; v_status unit_status;
  v_new_no text; v_seq int; v_new_id uuid; v_op uuid; v_cnt int;
  v_lease uuid; v_contract_usable numeric(12,2); v_contract_shared numeric(12,2);
  v_snapshot jsonb;
begin
  if coalesce(cardinality(p_unit_ids),0)<2 then raise exception '合并至少需要两个房源'; end if;
  if array_position(p_unit_ids,null) is not null or
     (select count(distinct x) from unnest(p_unit_ids) x)<>cardinality(p_unit_ids) then
    raise exception '请选择不同且有效的房源';
  end if;
  perform 1 from public.units where id=any(p_unit_ids) order by id for update;
  select count(*) into v_cnt from public.units where id=any(p_unit_ids);
  if v_cnt<>cardinality(p_unit_ids) then raise exception '存在不存在的房源'; end if;
  if (select count(distinct park_id) from public.units where id=any(p_unit_ids))<>1 then
    raise exception '只能合并同一园区的房源';
  end if;
  select park_id,purpose,status into v_park,v_purpose,v_status from public.units where id=p_unit_ids[1];
  if not coalesce(public.can_write(v_park,array['pm','cs']::user_role[]),false) then
    raise exception '无权在该园区操作房源';
  end if;
  if v_status not in ('vacant','leased') or
     exists(select 1 from public.units where id=any(p_unit_ids) and status<>v_status) then
    raise exception '请选择全部空置或全部已租的房源；已售、预留、已注销或混合状态不能直接合并';
  end if;
  select count(distinct lu.lease_id) into v_cnt from public.lease_units lu
  join public.leases l on l.id=lu.lease_id and l.status in ('active','draft')
  where lu.unit_id=any(p_unit_ids);
  if v_cnt>1 then raise exception '所选房源关联不同租约，不能直接合并；同一租户可用一份租约关联多个房源'; end if;
  if v_cnt=1 then
    select lu.lease_id into v_lease from public.lease_units lu
    join public.leases l on l.id=lu.lease_id and l.status in ('active','draft')
    where lu.unit_id=any(p_unit_ids) limit 1;
    perform 1 from public.leases where id=v_lease for update;
    if (select count(*) from public.lease_units where lease_id=v_lease and unit_id=any(p_unit_ids))<>cardinality(p_unit_ids) then
      raise exception '所选房源必须全部关联同一份租约，不能混合已签约和未签约房源';
    end if;
    if exists(select 1 from public.leases where id=v_lease and lease_kind<>'rental') then
      raise exception '已售物业服务合同关联的房源不能合并';
    end if;
    select sum(usable_area),sum(shared_area) into v_contract_usable,v_contract_shared
    from public.lease_units where lease_id=v_lease and unit_id=any(p_unit_ids);
  end if;
  if exists(select 1 from public.meters m join public.leases l on l.id=m.lease_id and l.status in ('active','draft')
            where m.unit_id=any(p_unit_ids) and m.lease_id is distinct from v_lease) then
    raise exception '所选房源的水电表关联其他租约，请先核对表具归属';
  end if;
  select sum(usable_area),sum(shared_area) into v_usable,v_shared from public.units where id=any(p_unit_ids);
  v_purpose:=coalesce(p_purpose,v_purpose);
  if p_purpose is null and exists(select 1 from public.units where id=any(p_unit_ids) and purpose<>v_purpose) then
    raise exception '所选房源经营属性不一致，请先统一经营属性';
  end if;
  select jsonb_agg(jsonb_build_object('building_id',q.building_id,'floor',q.floor) order by q.building_code,q.floor)
    into v_locations from (select distinct r.* from unnest(p_unit_ids) ids(id)
                          cross join lateral public.unit_location_rows(ids.id) r) q;
  select (x->>'building_id')::uuid,(x->>'floor')::int into v_bld,v_floor
  from jsonb_array_elements(v_locations) with ordinality t(x,n) order by n limit 1;
  perform 1 from public.buildings where id in
    (select (x->>'building_id')::uuid from jsonb_array_elements(v_locations) x) order by id for update;
  select n.unit_no,n.seq into v_new_no,v_seq from public.next_unit_no(v_bld,v_floor) n;
  v_snapshot:=jsonb_build_object(
    'sources',(select jsonb_agg(to_jsonb(u)) from public.units u where id=any(p_unit_ids)),
    'lease_units',(select coalesce(jsonb_agg(to_jsonb(lu)),'[]'::jsonb) from public.lease_units lu
                   where lease_id=v_lease and unit_id=any(p_unit_ids)),
    'meters',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.meters m where unit_id=any(p_unit_ids)));
  insert into public.units(park_id,building_id,unit_no,floor,seq,usable_area,shared_area,purpose,status,locations,remark)
  values(v_park,v_bld,v_new_no,v_floor,v_seq,v_usable,v_shared,v_purpose,v_status,v_locations,'由跨栋/跨层房源合并生成')
  returning id into v_new_id;
  if v_lease is not null then
    insert into public.lease_units(lease_id,unit_id,usable_area,shared_area)
    values(v_lease,v_new_id,v_contract_usable,v_contract_shared);
    delete from public.lease_units where lease_id=v_lease and unit_id=any(p_unit_ids);
  end if;
  update public.meters set unit_id=v_new_id where unit_id=any(p_unit_ids);
  insert into public.unit_operations(park_id,kind,operator_id,reason,snapshot)
  values(v_park,'merge',auth.uid(),p_reason,v_snapshot||jsonb_build_object('result',v_new_id,'new_unit_no',v_new_no))
  returning id into v_op;
  insert into public.unit_operation_items(operation_id,unit_id,role,usable_area,shared_area,unit_no_snap)
  select v_op,id,'source',usable_area,shared_area,unit_no from public.units where id=any(p_unit_ids);
  insert into public.unit_operation_items(operation_id,unit_id,role,usable_area,shared_area,unit_no_snap)
  values(v_op,v_new_id,'result',v_usable,v_shared,v_new_no);
  update public.units set status='voided',remark=coalesce(remark||' / ','')||'已合并至 '||v_new_no where id=any(p_unit_ids);
  insert into public.audit_logs(user_id,park_id,action,entity,entity_id,detail)
  values(auth.uid(),v_park,'unit.merge','units',v_new_id::text,
         jsonb_build_object('sources',p_unit_ids,'new_unit_no',v_new_no,'locations',v_locations,'lease_id',v_lease));
  return v_new_id;
end $$;

create or replace function public.split_unit(p_unit_id uuid,p_children jsonb,p_reason text default null)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  u record; c jsonb; v_item jsonb; v_locations jsonb; v_source_keys text[]; v_child_keys text[];
  v_sum_u numeric:=0; v_sum_s numeric:=0; v_tol numeric; v_bld uuid; v_floor int;
  v_new_no text; v_seq int; v_new_id uuid; v_op uuid; v_ids uuid[]:='{}'; v_u numeric; v_s numeric;
begin
  select * into u from public.units where id=p_unit_id for update;
  if not found then raise exception '房源不存在'; end if;
  if not coalesce(public.can_write(u.park_id,array['pm','cs']::user_role[]),false) then raise exception '无权在该园区操作房源'; end if;
  if u.status<>'vacant' then raise exception '仅空置房源可拆分'; end if;
  if exists(select 1 from public.lease_units lu join public.leases l on l.id=lu.lease_id
            where lu.unit_id=u.id and l.status in ('active','draft')) then
    raise exception '房源已关联租约，请先处理租约后再拆分';
  end if;
  if exists(select 1 from public.meters where unit_id=u.id) then raise exception '请先调整该房源的表具归属后再拆分'; end if;
  if jsonb_typeof(p_children) is distinct from 'array' or jsonb_array_length(p_children)<2 then
    raise exception '拆分至少需要两个子房源';
  end if;
  select coalesce((select (value#>>'{}')::numeric from public.system_settings where key='split_area_tolerance'),0.01) into v_tol;
  select array_agg((x->>'building_id')||'#'||(x->>'floor') order by (x->>'building_id')||'#'||(x->>'floor'))
    into v_source_keys from jsonb_array_elements(u.locations) x;
  v_child_keys:='{}';
  for c in select value from jsonb_array_elements(p_children) loop
    v_u:=round(coalesce((c->>'usable_area')::numeric,0),2); v_s:=round(coalesce((c->>'shared_area')::numeric,0),2);
    if v_u<=0 or v_s<0 or v_u::text='NaN' or v_s::text='NaN' then raise exception '子房源使用面积须大于0，公摊面积不能为负数'; end if;
    v_sum_u:=v_sum_u+v_u; v_sum_s:=v_sum_s+v_s;
    v_locations:=coalesce(c->'locations',case when jsonb_array_length(u.locations)=1 then u.locations else '[]'::jsonb end);
    if jsonb_typeof(v_locations) is distinct from 'array' or jsonb_array_length(v_locations)=0 then
      raise exception '跨栋/多层房源拆分时，每个子房源必须选择覆盖位置';
    end if;
    for v_item in select value from jsonb_array_elements(v_locations) loop
      if not coalesce((v_item->>'building_id')||'#'||(v_item->>'floor')=any(v_source_keys),false) then
        raise exception '子房源的位置必须来自拆分前房源';
      end if;
      v_child_keys:=array_append(v_child_keys,(v_item->>'building_id')||'#'||(v_item->>'floor'));
    end loop;
  end loop;
  if abs(v_sum_u-u.usable_area)>v_tol or abs(v_sum_s-u.shared_area)>v_tol then
    raise exception '子房源使用面积及公摊面积汇总必须分别等于拆分前面积';
  end if;
  if not v_source_keys<@v_child_keys then raise exception '子房源必须覆盖拆分前的全部楼栋和楼层'; end if;
  perform 1 from public.buildings where id in(select (x->>'building_id')::uuid from jsonb_array_elements(u.locations) x)
    order by id for update;
  insert into public.unit_operations(park_id,kind,operator_id,reason,snapshot)
  values(u.park_id,'split',auth.uid(),p_reason,jsonb_build_object('source',to_jsonb(u),'children',p_children)) returning id into v_op;
  insert into public.unit_operation_items(operation_id,unit_id,role,usable_area,shared_area,unit_no_snap)
  values(v_op,u.id,'source',u.usable_area,u.shared_area,u.unit_no);
  for c in select value from jsonb_array_elements(p_children) loop
    v_locations:=coalesce(c->'locations',u.locations);
    select b.id,(x->>'floor')::int into v_bld,v_floor from jsonb_array_elements(v_locations) x
      join public.buildings b on b.id=(x->>'building_id')::uuid order by b.code,(x->>'floor')::int limit 1;
    select n.unit_no,n.seq into v_new_no,v_seq from public.next_unit_no(v_bld,v_floor) n;
    insert into public.units(park_id,building_id,unit_no,floor,seq,usable_area,shared_area,purpose,status,locations,remark)
    values(u.park_id,v_bld,v_new_no,v_floor,v_seq,round((c->>'usable_area')::numeric,2),round(coalesce((c->>'shared_area')::numeric,0),2),
           coalesce((c->>'purpose')::unit_purpose,u.purpose),'vacant',v_locations,coalesce(c->>'remark','由 '||u.unit_no||' 拆分生成'))
    returning id into v_new_id;
    v_ids:=array_append(v_ids,v_new_id);
    insert into public.unit_operation_items(operation_id,unit_id,role,usable_area,shared_area,unit_no_snap)
    values(v_op,v_new_id,'result',round((c->>'usable_area')::numeric,2),round(coalesce((c->>'shared_area')::numeric,0),2),v_new_no);
  end loop;
  update public.units set status='voided',remark=coalesce(remark||' / ','')||'已拆分' where id=u.id;
  insert into public.audit_logs(user_id,park_id,action,entity,entity_id,detail)
  values(auth.uid(),u.park_id,'unit.split','units',u.id::text,jsonb_build_object('source_unit_no',u.unit_no,'results',v_ids));
  return v_ids;
end $$;

revoke all on function public.merge_units(uuid[],unit_purpose,text) from public,anon;
revoke all on function public.split_unit(uuid,jsonb,text) from public,anon;
revoke all on function public.unit_location_rows(uuid) from public,anon;
revoke all on function public.unit_location_label(uuid) from public,anon;
grant execute on function public.merge_units(uuid[],unit_purpose,text) to authenticated;
grant execute on function public.split_unit(uuid,jsonb,text) to authenticated;
grant execute on function public.unit_location_rows(uuid) to authenticated;
grant execute on function public.unit_location_label(uuid) to authenticated;

-- 下方更新展示视图，保留已有列顺序和 security_invoker。
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
  end as display_status,
  (select coalesce(jsonb_agg(jsonb_build_object(
    'building_id', r.building_id, 'building_code', r.building_code, 'floor', r.floor)
    order by r.building_code, r.floor), '[]'::jsonb)
   from public.unit_location_rows(u.id) r) as locations
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
  (select string_agg(public.unit_location_label(u.id) || ' ' || u.unit_no, '、'
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


notify pgrst, 'reload schema';
commit;

