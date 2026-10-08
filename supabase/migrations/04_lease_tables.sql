-- =============================================================
-- 04 主体与合约：parties / leases / lease_units
--    lease_periods(免租期·装修期) / lease_price_steps(阶梯租金)
-- =============================================================

-- -------------------------------------------------------------
-- 主体：租户 与 已售物业业主 统一存放
-- -------------------------------------------------------------
create table if not exists public.parties (
  id             uuid primary key default gen_random_uuid(),
  park_id        uuid not null references public.parks(id) on delete cascade,
  kind           party_kind not null default 'tenant',
  name           text not null,                     -- 企业名称 / 业主名称
  short_name     text,
  contact_name   text,
  contact_phone  text,
  contact_email  text,
  tax_no         text,                              -- 统一社会信用代码
  industry       text,
  bank_name      text,
  bank_account   text,
  is_active      boolean not null default true,
  remark         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_parties_park on public.parties(park_id, kind);

create trigger trg_parties_updated before update on public.parties
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 合约
-- lease_kind='rental'    租赁合同：租金 + 物业费 + 水电
-- lease_kind='ownership' 已售物业服务合同：物业费 + 水电（rent_price 置 0）
-- -------------------------------------------------------------
create table if not exists public.leases (
  id                uuid primary key default gen_random_uuid(),
  park_id           uuid not null references public.parks(id)    on delete cascade,
  party_id          uuid not null references public.parties(id)  on delete restrict,
  contract_no       text not null,
  lease_kind        lease_kind   not null default 'rental',
  status            lease_status not null default 'draft',

  start_date        date not null,                     -- 租约起始日
  end_date          date not null,                     -- 租约结束日
  check (end_date >= start_date),

  -- 计价：租金 元/㎡/天，物业费 元/㎡/月
  rent_price        numeric(12,4) not null default 0,
  fee_price         numeric(12,4) not null default 0,

  -- 账期：默认季度，支持自定义。物业费周期与租金一致（可单独覆盖）
  rent_cycle_months int not null default 3 check (rent_cycle_months between 1 and 12),
  fee_cycle_months  int not null default 3 check (fee_cycle_months  between 1 and 12),
  -- 应交日 = 账期首日 - 提前天数（滚动，随 start_date 走，不固定每月1日）
  due_advance_days  int not null default 0,

  -- 押金
  deposit_amount    numeric(14,2) not null default 0,
  deposit_months    numeric(6,2)  not null default 0,   -- 折合几个月租金，仅备注用

  -- 水电单价覆盖（为空则取园区参数）
  water_price       numeric(10,4),
  electricity_price numeric(10,4),

  schedule_generated_at timestamptz,                    -- 收款计划生成时间
  signed_date       date,
  remark            text,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (park_id, contract_no)
);
create index if not exists idx_leases_park   on public.leases(park_id, status);
create index if not exists idx_leases_party  on public.leases(party_id);

create trigger trg_leases_updated before update on public.leases
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 合约 ↔ 房源（一约多房）。面积默认取房源面积，允许按合同约定覆盖
-- -------------------------------------------------------------
create table if not exists public.lease_units (
  id           bigserial primary key,
  lease_id     uuid not null references public.leases(id) on delete cascade,
  unit_id      uuid not null references public.units(id)  on delete restrict,
  usable_area  numeric(12,2) not null default 0,   -- 计租使用面积
  shared_area  numeric(12,2) not null default 0,   -- 计租公摊面积
  area         numeric(12,2) generated always as (usable_area + shared_area) stored,
  unique (lease_id, unit_id)
);
create index if not exists idx_lease_units_unit on public.lease_units(unit_id);

-- 新增关联时，若未填面积则自动带入房源面积
create or replace function public.tg_lease_unit_fill_area()
returns trigger language plpgsql as $$
declare u record;
begin
  if coalesce(new.usable_area,0) = 0 and coalesce(new.shared_area,0) = 0 then
    select usable_area, shared_area into u from public.units where id = new.unit_id;
    new.usable_area := coalesce(u.usable_area,0);
    new.shared_area := coalesce(u.shared_area,0);
  end if;
  return new;
end $$;

create trigger trg_lease_units_fill before insert on public.lease_units
  for each row execute function public.tg_lease_unit_fill_area();

-- -------------------------------------------------------------
-- 免租期 / 装修期：起止完全自由设定，可重叠、可多段
-- waive_rent / waive_fee 分别控制是否减免租金、物业费（每户可不同）
-- -------------------------------------------------------------
create table if not exists public.lease_periods (
  id          bigserial primary key,
  lease_id    uuid not null references public.leases(id) on delete cascade,
  kind        lease_period_kind not null,
  start_date  date not null,
  end_date    date not null,
  waive_rent  boolean not null default true,
  waive_fee   boolean not null default false,
  remark      text,
  check (end_date >= start_date)
);
create index if not exists idx_lease_periods_lease on public.lease_periods(lease_id);

-- -------------------------------------------------------------
-- 阶梯租金/阶梯物业费：按日期段覆盖 leases 上的基准单价
-- 未配置时全程使用 leases.rent_price / fee_price
-- -------------------------------------------------------------
create table if not exists public.lease_price_steps (
  id          bigserial primary key,
  lease_id    uuid not null references public.leases(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  rent_price  numeric(12,4),      -- 元/㎡/天，null = 沿用基准
  fee_price   numeric(12,4),      -- 元/㎡/月，null = 沿用基准
  remark      text,
  check (end_date >= start_date)
);
create index if not exists idx_price_steps_lease on public.lease_price_steps(lease_id, start_date);
