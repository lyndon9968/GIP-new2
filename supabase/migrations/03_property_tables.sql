-- =============================================================
-- 03 物理资产：栋 / 房源 / 合并拆分台账
-- =============================================================

-- -------------------------------------------------------------
-- 栋
-- -------------------------------------------------------------
create table if not exists public.buildings (
  id             uuid primary key default gen_random_uuid(),
  park_id        uuid not null references public.parks(id) on delete cascade,
  code           text not null,                     -- 栋号，如 A1、3
  name           text,
  floors_above   int  not null default 1,           -- 地上层数
  floors_below   int  not null default 0,           -- 地下层数
  gfa            numeric(14,2) not null default 0,  -- 本栋建筑面积
  sort_order     int  not null default 0,
  remark         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (park_id, code)
);
create index if not exists idx_buildings_park on public.buildings(park_id);

create trigger trg_buildings_updated before update on public.buildings
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 房源
-- 编号规则：栋号 + 层(2位) + 序号(2位)，例 A1 + 03 + 05 => A10305
-- 合并/拆分产生的新房源沿用该规则，序号取"同栋同层历史最大值+1"，
-- 被注销编号不再复用（status='voided'）
-- -------------------------------------------------------------
create table if not exists public.units (
  id             uuid primary key default gen_random_uuid(),
  park_id        uuid not null references public.parks(id)     on delete cascade,
  building_id    uuid not null references public.buildings(id) on delete cascade,
  unit_no        text not null,                     -- 完整房号
  floor          int  not null,                     -- 层，地下用负数
  seq            int  not null,                     -- 同栋同层序号
  usable_area    numeric(12,2) not null default 0,  -- 使用面积
  shared_area    numeric(12,2) not null default 0,  -- 公摊面积
  area           numeric(12,2) generated always as (usable_area + shared_area) stored, -- 建筑面积
  purpose        unit_purpose not null default 'rent_or_sale',
  status         unit_status   not null default 'vacant',
  is_saleable    boolean generated always as (purpose in ('sale_only','rent_or_sale')) stored,
  is_rentable    boolean generated always as (purpose in ('rent_only','rent_or_sale')) stored,
  remark         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (park_id, unit_no)
);

create index if not exists idx_units_park     on public.units(park_id);
create index if not exists idx_units_building on public.units(building_id, floor, seq);
create index if not exists idx_units_status    on public.units(park_id, status);

create trigger trg_units_updated before update on public.units
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 合并 / 拆分台账：留痕，可追溯任一房源的来源与去向
-- -------------------------------------------------------------
create table if not exists public.unit_operations (
  id          uuid primary key default gen_random_uuid(),
  park_id     uuid not null references public.parks(id) on delete cascade,
  kind        unit_op_kind not null,
  op_date     date not null default current_date,
  operator_id uuid references public.profiles(id),
  reason      text,
  snapshot    jsonb,        -- 操作前后房源快照
  created_at  timestamptz not null default now()
);
create index if not exists idx_unit_ops_park on public.unit_operations(park_id, op_date desc);

create table if not exists public.unit_operation_items (
  id            bigserial primary key,
  operation_id  uuid not null references public.unit_operations(id) on delete cascade,
  unit_id       uuid not null references public.units(id) on delete cascade,
  role          text not null check (role in ('source','result')),  -- 被合并/被拆分 = source
  usable_area   numeric(12,2) not null default 0,
  shared_area   numeric(12,2) not null default 0,
  unit_no_snap  text                                 -- 操作当时的房号（source 注销后仍可查）
);
create index if not exists idx_unit_op_items_op   on public.unit_operation_items(operation_id);
create index if not exists idx_unit_op_items_unit on public.unit_operation_items(unit_id);