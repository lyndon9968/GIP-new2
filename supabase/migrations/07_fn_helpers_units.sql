-- =============================================================
-- 07 辅助函数（权限判定）+ 房源合并/拆分
-- =============================================================

-- 当前用户角色
create or replace function public.current_role_of()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active;
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and is_active and role = 'super_admin');
$$;

-- 是否有权访问某园区（super_admin 默认全部）
create or replace function public.has_park(p_park uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or exists (select 1 from public.user_parks up
                 join public.profiles pf on pf.id = up.user_id and pf.is_active
                 where up.user_id = auth.uid() and up.park_id = p_park);
$$;

-- 角色是否在允许集合内
create or replace function public.role_in(p_roles user_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role_of() = any(p_roles);
$$;

-- 写权限：园区可访问 且 角色在允许集合内
create or replace function public.can_write(p_park uuid, p_roles user_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or (public.has_park(p_park) and public.current_role_of() = any(p_roles));
$$;

-- 自然月天数
create or replace function public.days_in_month(d date)
returns int language sql immutable as $$
  select extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::int;
$$;

-- -------------------------------------------------------------
-- 生成下一个房号：栋号 + 层(2位) + 序号(2位)
-- 序号取同栋同层历史最大值+1（含已注销房源，编号不复用）
-- -------------------------------------------------------------
create or replace function public.next_unit_no(p_building uuid, p_floor int)
returns table(unit_no text, seq int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_code text;
  v_seq  int;
begin
  select b.code into v_code from public.buildings b where b.id = p_building;
  if v_code is null then
    raise exception '楼栋不存在: %', p_building;
  end if;

  select coalesce(max(u.seq), 0) + 1 into v_seq
  from public.units u
  where u.building_id = p_building and u.floor = p_floor;

  return query select
    v_code
      || case when p_floor < 0 then 'B' else '' end
      || lpad(abs(p_floor)::text, 2, '0')
      || lpad(v_seq::text, 2, '0'),
    v_seq;
end $$;

-- -------------------------------------------------------------
-- 合并房源：源房源必须同栋同层且均为空置；合并后源编号注销，生成新编号
-- 返回新房源 id
-- -------------------------------------------------------------
create or replace function public.merge_units(
  p_unit_ids uuid[],
  p_purpose  unit_purpose default null,
  p_reason   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_park uuid; v_bld uuid; v_floor int;
  v_usable numeric(12,2); v_shared numeric(12,2);
  v_new_no text; v_seq int; v_new_id uuid; v_op uuid;
  v_purpose unit_purpose;
  v_cnt int;
begin
  if array_length(p_unit_ids, 1) < 2 then
    raise exception '合并至少需要两个房源';
  end if;

  select count(*) into v_cnt from public.units where id = any(p_unit_ids);
  if v_cnt <> array_length(p_unit_ids, 1) then
    raise exception '存在不存在的房源';
  end if;

  select min(park_id), min(building_id), min(floor),
         sum(usable_area), sum(shared_area)
    into v_park, v_bld, v_floor, v_usable, v_shared
  from public.units where id = any(p_unit_ids);

  if (select count(distinct building_id) from public.units where id = any(p_unit_ids)) > 1
     or (select count(distinct floor) from public.units where id = any(p_unit_ids)) > 1 then
    raise exception '仅支持同一栋、同一层的房源合并';
  end if;

  if exists (select 1 from public.units where id = any(p_unit_ids) and status <> 'vacant') then
    raise exception '仅空置房源可合并（存在已租/已售/已注销房源）';
  end if;

  if not public.can_write(v_park, array['pm','cs']::user_role[]) then
    raise exception '无权在该园区操作房源';
  end if;

  select purpose into v_purpose from public.units where id = p_unit_ids[1];
  v_purpose := coalesce(p_purpose, v_purpose);

  select n.unit_no, n.seq into v_new_no, v_seq from public.next_unit_no(v_bld, v_floor) n;

  insert into public.units (park_id, building_id, unit_no, floor, seq,
                            usable_area, shared_area, purpose, status, remark)
  values (v_park, v_bld, v_new_no, v_floor, v_seq,
          v_usable, v_shared, v_purpose, 'vacant',
          '由房源合并生成')
  returning id into v_new_id;

  insert into public.unit_operations (park_id, kind, operator_id, reason, snapshot)
  values (v_park, 'merge', auth.uid(), p_reason,
          jsonb_build_object('sources', p_unit_ids, 'result', v_new_id, 'new_unit_no', v_new_no))
  returning id into v_op;

  insert into public.unit_operation_items (operation_id, unit_id, role, usable_area, shared_area, unit_no_snap)
  select v_op, u.id, 'source', u.usable_area, u.shared_area, u.unit_no
  from public.units u where u.id = any(p_unit_ids);

  insert into public.unit_operation_items (operation_id, unit_id, role, usable_area, shared_area, unit_no_snap)
  values (v_op, v_new_id, 'result', v_usable, v_shared, v_new_no);

  update public.units
     set status = 'voided',
         remark = coalesce(remark || ' / ', '') || '已合并至 ' || v_new_no
   where id = any(p_unit_ids);

  insert into public.audit_logs (user_id, park_id, action, entity, entity_id, detail)
  values (auth.uid(), v_park, 'unit.merge', 'units', v_new_id::text,
          jsonb_build_object('sources', p_unit_ids, 'new_unit_no', v_new_no));

  return v_new_id;
end $$;

-- -------------------------------------------------------------
-- 拆分房源：子房源面积手动指定，系统校验汇总 = 拆分前面积（容差见 system_settings）
-- p_children 形如 [{"usable_area":100,"shared_area":20,"purpose":"rent_only","remark":"x"}, ...]
-- 返回新房源 id 数组
-- -------------------------------------------------------------
create or replace function public.split_unit(
  p_unit_id  uuid,
  p_children jsonb,
  p_reason   text default null
) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  u record; c jsonb;
  v_sum_u numeric(14,2) := 0; v_sum_s numeric(14,2) := 0;
  v_tol numeric := 0.01;
  v_new_no text; v_seq int; v_new_id uuid; v_op uuid;
  v_ids uuid[] := '{}';
begin
  select * into u from public.units where id = p_unit_id;
  if not found then raise exception '房源不存在'; end if;
  if u.status <> 'vacant' then raise exception '仅空置房源可拆分（当前状态：%）', u.status; end if;
  if jsonb_array_length(p_children) < 2 then raise exception '拆分至少需要两个子房源'; end if;

  if not public.can_write(u.park_id, array['pm','cs']::user_role[]) then
    raise exception '无权在该园区操作房源';
  end if;

  select coalesce((value #>> '{}')::numeric, 0.01) into v_tol
  from public.system_settings where key = 'split_area_tolerance';

  for c in select * from jsonb_array_elements(p_children) loop
    v_sum_u := v_sum_u + coalesce((c->>'usable_area')::numeric, 0);
    v_sum_s := v_sum_s + coalesce((c->>'shared_area')::numeric, 0);
  end loop;

  if abs(v_sum_u - u.usable_area) > v_tol then
    raise exception '子房源使用面积汇总 % 与拆分前 % 不一致', v_sum_u, u.usable_area;
  end if;
  if abs(v_sum_s - u.shared_area) > v_tol then
    raise exception '子房源公摊面积汇总 % 与拆分前 % 不一致', v_sum_s, u.shared_area;
  end if;

  insert into public.unit_operations (park_id, kind, operator_id, reason, snapshot)
  values (u.park_id, 'split', auth.uid(), p_reason,
          jsonb_build_object('source', p_unit_id, 'source_unit_no', u.unit_no, 'children', p_children))
  returning id into v_op;

  insert into public.unit_operation_items (operation_id, unit_id, role, usable_area, shared_area, unit_no_snap)
  values (v_op, u.id, 'source', u.usable_area, u.shared_area, u.unit_no);

  for c in select * from jsonb_array_elements(p_children) loop
    select n.unit_no, n.seq into v_new_no, v_seq from public.next_unit_no(u.building_id, u.floor) n;

    insert into public.units (park_id, building_id, unit_no, floor, seq,
                              usable_area, shared_area, purpose, status, remark)
    values (u.park_id, u.building_id, v_new_no, u.floor, v_seq,
            coalesce((c->>'usable_area')::numeric, 0),
            coalesce((c->>'shared_area')::numeric, 0),
            coalesce((c->>'purpose')::unit_purpose, u.purpose),
            'vacant',
            coalesce(c->>'remark', '由 ' || u.unit_no || ' 拆分生成'))
    returning id into v_new_id;

    v_ids := v_ids || v_new_id;

    insert into public.unit_operation_items (operation_id, unit_id, role, usable_area, shared_area, unit_no_snap)
    values (v_op, v_new_id,'result',
            coalesce((c->>'usable_area')::numeric, 0),
            coalesce((c->>'shared_area')::numeric, 0), v_new_no);
  end loop;

  update public.units
     set status = 'voided',
         remark = coalesce(remark || ' / ', '') || '已拆分'
   where id = p_unit_id;

  insert into public.audit_logs (user_id, park_id, action, entity, entity_id, detail)
  values (auth.uid(), u.park_id, 'unit.split', 'units', p_unit_id::text,
          jsonb_build_object('source_unit_no', u.unit_no, 'results', v_ids));

  return v_ids;
end $$;
