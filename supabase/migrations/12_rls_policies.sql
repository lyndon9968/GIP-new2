-- =============================================================
-- 12 行级安全策略 (RLS)
--
-- 权限矩阵
-- ┌──────────────┬────────────┬──────┬──────────┬────────┐
-- │ 模块         │ super_admin│ pm   │ engineer │ cs     │
-- ├──────────────┼────────────┼──────┼──────────┼────────┤
-- │ 用户/授权    │ 增删改查   │ 查   │ 查(自己) │ 查(自己)│
-- │ 园区/楼栋    │ 增删改查   │ 改查 │ 查        │ 查     │
-- │ 园区参数     │ 增删改查   │ 改查 │ 查        │ 查     │
-- │ 房源         │ 增删改查   │ 全   │ 查        │ 增改查 │
-- │ 合并/拆分    │ 可         │ 可   │ 否        │ 可     │
-- │ 租户/租约    │ 增删改查   │ 全   │ 查        │ 增改查 │
-- │ 账单/收款确认│ 增删改查   │ 全   │ 查        │ 增改查 │
-- │ 水电表/抄表  │ 增删改查   │ 全   │ 增改查    │ 查     │
-- │ 系统设置     │ 增删改查   │ 查   │ 查        │ 查     │
-- │ 数据概览     │ 全部园区   │ 授权园区 │ 授权园区 │ 授权园区 │
-- └──────────────┴────────────┴──────┴──────────┴────────┘
-- 所有非 super_admin 用户只能看到 user_parks 中被授权的园区数据
-- =============================================================

alter table public.profiles        enable row level security;
alter table public.parks           enable row level security;
alter table public.park_settings   enable row level security;
alter table public.user_parks      enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_logs      enable row level security;
alter table public.buildings       enable row level security;
alter table public.units           enable row level security;
alter table public.unit_operations      enable row level security;
alter table public.unit_operation_items enable row level security;
alter table public.parties         enable row level security;
alter table public.leases          enable row level security;
alter table public.lease_units     enable row level security;
alter table public.lease_periods   enable row level security;
alter table public.lease_price_steps enable row level security;
alter table public.charges         enable row level security;
alter table public.charge_details  enable row level security;
alter table public.payments        enable row level security;
alter table public.attachments     enable row level security;
alter table public.meters          enable row level security;
alter table public.meter_readings  enable row level security;

-- -------------------------------------------------------------
-- profiles：本人可读改（限昵称/电话），super_admin 全权
-- -------------------------------------------------------------
drop policy if exists p_profiles_select on public.profiles;
create policy p_profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_super_admin());

drop policy if exists p_profiles_self_update on public.profiles;
create policy p_profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists p_profiles_admin_all on public.profiles;
create policy p_profiles_admin_all on public.profiles for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- -------------------------------------------------------------
-- user_parks：super_admin 分配；本人可查自己的授权
-- -------------------------------------------------------------
drop policy if exists p_user_parks_select on public.user_parks;
create policy p_user_parks_select on public.user_parks for select to authenticated
  using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists p_user_parks_admin on public.user_parks;
create policy p_user_parks_admin on public.user_parks for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- -------------------------------------------------------------
-- parks：授权可见；super_admin 增删，pm 可改本园区资料
-- -------------------------------------------------------------
drop policy if exists p_parks_select on public.parks;
create policy p_parks_select on public.parks for select to authenticated
  using (public.has_park(id));

drop policy if exists p_parks_admin on public.parks;
create policy p_parks_admin on public.parks for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists p_parks_pm_update on public.parks;
create policy p_parks_pm_update on public.parks for update to authenticated
  using (public.can_write(id, array['pm']::user_role[]))
  with check (public.can_write(id, array['pm']::user_role[]));

-- -------------------------------------------------------------
-- system_settings / audit_logs
-- -------------------------------------------------------------
drop policy if exists p_settings_select on public.system_settings;
create policy p_settings_select on public.system_settings for select to authenticated using (true);

drop policy if exists p_settings_admin on public.system_settings;
create policy p_settings_admin on public.system_settings for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists p_audit_select on public.audit_logs;
create policy p_audit_select on public.audit_logs for select to authenticated
  using (public.is_super_admin() or (park_id is not null and public.has_park(park_id)));

drop policy if exists p_audit_insert on public.audit_logs;
create policy p_audit_insert on public.audit_logs for insert to authenticated with check (true);

-- -------------------------------------------------------------
-- 含 park_id 的业务表：统一生成 select / insert / update / delete 策略
-- 读：授权园区即可读
-- 写：授权园区 且 角色在该表允许集合内（super_admin 始终可写）
-- -------------------------------------------------------------
do $$
declare
  t text; roles text;
  spec text[][] := array[
    ['park_settings',   'pm'],
    ['buildings',       'pm'],
    ['units',           'pm,cs'],
    ['unit_operations', 'pm,cs'],
    ['parties',         'pm,cs'],
    ['leases',          'pm,cs'],
    ['charges',         'pm,cs'],
    ['payments',        'pm,cs'],
    ['meters',          'pm,engineer'],
    ['meter_readings',  'pm,engineer'],
    ['attachments',     'pm,cs,engineer']
  ];
  i int;
begin
  for i in 1 .. array_length(spec, 1) loop
    t     := spec[i][1];
    roles := 'array[' || (select string_agg(quote_literal(x), ',')
                          from unnest(string_to_array(spec[i][2], ',')) x) || ']::user_role[]';

    execute format('drop policy if exists p_%1$s_sel on public.%1$s', t);
    execute format(
      'create policy p_%1$s_sel on public.%1$s for select to authenticated
         using (public.has_park(park_id))', t);

    execute format('drop policy if exists p_%1$s_ins on public.%1$s', t);
    execute format(
      'create policy p_%1$s_ins on public.%1$s for insert to authenticated
         with check (public.can_write(park_id, %2$s))', t, roles);

    execute format('drop policy if exists p_%1$s_upd on public.%1$s', t);
    execute format(
      'create policy p_%1$s_upd on public.%1$s for update to authenticated
         using (public.can_write(park_id, %2$s))
         with check (public.can_write(park_id, %2$s))', t, roles);

    execute format('drop policy if exists p_%1$s_del on public.%1$s', t);
    execute format(
      'create policy p_%1$s_del on public.%1$s for delete to authenticated
         using (public.can_write(park_id, %2$s))', t, roles);
  end loop;
end $$;

-- -------------------------------------------------------------
-- 子表（无 park_id）：权限继承父表
-- -------------------------------------------------------------
do $$
declare
  i int;
  -- 表名, 父表, 外键列, 允许写入角色
  spec text[][] := array[
    ['lease_units',      'leases',          'lease_id',     'pm,cs'],
    ['lease_periods',    'leases',          'lease_id',     'pm,cs'],
    ['lease_price_steps','leases',          'lease_id',     'pm,cs'],
    ['charge_details',   'charges',         'charge_id',    'pm,cs'],
    ['unit_operation_items','unit_operations','operation_id','pm,cs']
  ];
  t text; parent text; fk text; roles text; pred text;
begin
  for i in 1 .. array_length(spec, 1) loop
    t := spec[i][1]; parent := spec[i][2]; fk := spec[i][3];
    roles := 'array[' || (select string_agg(quote_literal(x), ',')
                          from unnest(string_to_array(spec[i][4], ',')) x) || ']::user_role[]';

    pred := format('exists (select 1 from public.%1$s pp where pp.id = %2$s and public.has_park(pp.park_id))',
                   parent, fk);

    execute format('drop policy if exists p_%1$s_sel on public.%1$s', t);
    execute format('create policy p_%1$s_sel on public.%1$s for select to authenticated using (%2$s)', t, pred);

    pred := format('exists (select 1 from public.%1$s pp where pp.id = %2$s and public.can_write(pp.park_id, %3$s))',
                   parent, fk, roles);

    execute format('drop policy if exists p_%1$s_ins on public.%1$s', t);
    execute format('create policy p_%1$s_ins on public.%1$s for insert to authenticated with check (%2$s)', t, pred);

    execute format('drop policy if exists p_%1$s_upd on public.%1$s', t);
    execute format('create policy p_%1$s_upd on public.%1$s for update to authenticated using (%2$s) with check (%2$s)', t, pred);

    execute format('drop policy if exists p_%1$s_del on public.%1$s', t);
    execute format('create policy p_%1$s_del on public.%1$s for delete to authenticated using (%2$s)', t, pred);
  end loop;
end $$;

-- -------------------------------------------------------------
-- 授权：authenticated 走 RLS；anon 不能读任何业务数据
-- 前端通过 Netlify Function 下发 anon key + 登录态，无需用户配置
-- -------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

revoke all on all tables in schema public from anon;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
