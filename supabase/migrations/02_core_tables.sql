-- =============================================================
-- 02 组织、用户、园区、系统设置
-- =============================================================

-- 通用 updated_at 触发器
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -------------------------------------------------------------
-- 用户档案：与 auth.users 一对一。无公开注册入口，
-- 由超级管理员通过 Netlify Function(service_role) 创建 auth 用户后写入本表。
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  phone         text,
  email         text,
  role          user_role not null default 'cs',
  is_active     boolean not null default true,
  must_change_pwd boolean not null default true,   -- 首次登录强制改密
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- auth.users 新增时自动建档（角色默认 cs，由管理员再调整）
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'cs')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created after insert on auth.users
  for each row execute function public.tg_handle_new_user();

-- -------------------------------------------------------------
-- 园区
-- -------------------------------------------------------------
create table if not exists public.parks (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,             -- 园区代码，如 GC01
  name              text not null,                    -- 园区名称
  city              text,
  address           text,
  land_area         numeric(14,2) not null default 0,  -- 占地面积 ㎡
  building_count    int          not null default 0,   -- 栋数（可由 buildings 自动汇总，此处为规划值）
  gfa_above         numeric(14,2) not null default 0,  -- 地上建筑面积 ㎡
  gfa_below         numeric(14,2) not null default 0,  -- 地下建筑面积 ㎡
  rentable_area     numeric(14,2) constraint parks_rentable_area_nonnegative check (rentable_area >= 0), -- 人工录入；NULL 按房源汇总
  parking_count     int          not null default 0,   -- 车位数
  is_active         boolean      not null default true,
  sort_order        int          not null default 0,
  remark            text,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);
comment on column public.parks.gfa_above is '地上建筑面积；总建筑面积 = gfa_above + gfa_below';
comment on column public.parks.rentable_area is '人工录入的可出租面积（㎡）；NULL 按有效可出租房源汇总，0 表示无出租物业';

create trigger trg_parks_updated before update on public.parks
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 园区参数（水电单价、损耗分摊、逾期规则等）
-- -------------------------------------------------------------
create table if not exists public.park_settings (
  park_id             uuid primary key references public.parks(id) on delete cascade,
  water_price         numeric(10,4) not null default 0,      -- 元/吨
  electricity_price   numeric(10,4) not null default 0,      -- 元/度
  water_loss_method   loss_alloc_method not null default 'none',
  water_loss_ratio    numeric(6,4)  not null default 0,      -- 固定损耗比例，如 0.05 = 5%
  elec_loss_method    loss_alloc_method not null default 'none',
  elec_loss_ratio     numeric(6,4)  not null default 0,
  utility_due_days    int  not null default 15,   -- 水电账单：抄表日 + N 天为应交日
  rent_due_advance_days int not null default 0,   -- 租金应交日 = 账期首日 - N 天（0=账期首日当天）
  overdue_alert_days  int  not null default 7,    -- 逾期超过 N 天进入警示红
  updated_at          timestamptz not null default now()
);

create trigger trg_park_settings_updated before update on public.park_settings
  for each row execute function public.tg_set_updated_at();

-- 建园区时自动建一条参数
create or replace function public.tg_park_defaults()
returns trigger language plpgsql as $$
begin
  insert into public.park_settings (park_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger trg_parks_defaults after insert on public.parks
  for each row execute function public.tg_park_defaults();

-- -------------------------------------------------------------
-- 用户 ↔ 园区 授权（一个用户可被授予多个园区）
-- super_admin 无需授权记录，默认全部园区
-- -------------------------------------------------------------
create table if not exists public.user_parks (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  park_id     uuid not null references public.parks(id)    on delete cascade,
  granted_by  uuid references public.profiles(id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, park_id)
);
create index if not exists idx_user_parks_park on public.user_parks(park_id);

-- -------------------------------------------------------------
-- 全局系统设置（键值对，前端设置页维护）
-- -------------------------------------------------------------
create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

insert into public.system_settings (key, value, description) values
  ('company_name',      '"谷川高科"'::jsonb,  '公司名称，显示在页头'),
  ('fiscal_year_start', '"01-01"'::jsonb,    '财年起始月日，用于"当年收入"统计'),
  ('currency',          '"CNY"'::jsonb,      '记账货币'),
  ('area_precision',    '2'::jsonb,          '面积小数位'),
  ('split_area_tolerance','0.01'::jsonb,     '拆分面积汇总校验容差 ㎡')
on conflict (key) do nothing;

-- -------------------------------------------------------------
-- 审计日志（增删改关键业务对象都写一条）
-- -------------------------------------------------------------
create table if not exists public.audit_logs (
  id          bigserial primary key,
  user_id     uuid references public.profiles(id),
  park_id     uuid references public.parks(id) on delete set null,
  action      text not null,          -- 'unit.merge' / 'payment.confirm' / 'user.delete' ...
  entity      text,                   -- 表名
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs(created_at desc);
create index if not exists idx_audit_park    on public.audit_logs(park_id, created_at desc);
