-- =============================================================
-- 06 能源：水电表 / 抄表记录
-- =============================================================

-- -------------------------------------------------------------
-- 水表 / 电表
-- 归属由园区经理指定：绑定房源+租约(租户表) 或 标记为公共表(is_public)
-- is_master=true 表示园区/楼栋总表，用于计算损耗
-- 一个租户可对应多块表；多个房源共用一块表也支持
-- -------------------------------------------------------------
create table if not exists public.meters (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  meter_no      text not null,                       -- 水表号 / 电表号
  meter_type    meter_type not null,
  building_id   uuid references public.buildings(id) on delete set null,
  unit_id       uuid references public.units(id)     on delete set null,
  lease_id      uuid references public.leases(id)    on delete set null,  -- 当前计费归属租约
  is_public     boolean not null default false,      -- 公共区域表（走廊、停车场等）
  is_master     boolean not null default false,      -- 总表（园区/楼栋进线表）
  multiplier    numeric(10,4) not null default 1,    -- 倍率（互感器）
  init_reading  numeric(14,3) not null default 0,    -- 建表初始读数
  location      text,
  is_active     boolean not null default true,
  remark        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (park_id, meter_no)
);
create index if not exists idx_meters_park  on public.meters(park_id, meter_type);
create index if not exists idx_meters_lease on public.meters(lease_id);
create index if not exists idx_meters_unit  on public.meters(unit_id);

create trigger trg_meters_updated before update on public.meters
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 抄表记录
-- 支持任意时间录入，必须记录本期起始日与抄表日；
-- prev_reading 自动取该表上一期 curr_reading（无则取 init_reading，默认 0）；
-- 漏抄次月补录时按"补录所属月份"(bill_month)计费。
-- -------------------------------------------------------------
create table if not exists public.meter_readings (
  id            bigserial primary key,
  park_id       uuid not null references public.parks(id)  on delete cascade,
  meter_id      uuid not null references public.meters(id) on delete cascade,
  lease_id      uuid references public.leases(id) on delete set null,  -- 抄表时归属租约（快照）
  bill_month    date not null,                       -- 归属月份（当月1日）
  period_start  date not null,                       -- 本期起始日（上期抄表日）
  read_date     date not null,                       -- 本期抄表日
  prev_reading  numeric(14,3) not null default 0,    -- 上月读数（自动获取）
  curr_reading  numeric(14,3) not null default 0,    -- 本次读数
  raw_usage     numeric(14,3) generated always as
                  (greatest(curr_reading - prev_reading, 0)) stored,   -- 表差
  multiplier    numeric(10,4) not null default 1,
  usage         numeric(14,3) not null default 0,    -- 计费用量 = 表差 × 倍率
  loss_usage    numeric(14,3) not null default 0,    -- 分摊损耗用量（由分摊函数写入）
  unit_price    numeric(10,4) not null default 0,    -- 手动输入单价
  amount        numeric(14,2) not null default 0,    -- 自动计算 =(usage+loss_usage)×unit_price
  read_by       uuid references public.profiles(id),
  remark        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (read_date >= period_start),
  unique (meter_id, bill_month)
);
create index if not exists idx_readings_park  on public.meter_readings(park_id, bill_month);
create index if not exists idx_readings_meter on public.meter_readings(meter_id, bill_month desc);
create index if not exists idx_readings_lease on public.meter_readings(lease_id, bill_month);

create trigger trg_readings_updated before update on public.meter_readings
  for each row execute function public.tg_set_updated_at();

-- charges.reading_id 外键（charges 建于 05，此处补上）
alter table public.charges
  drop constraint if exists charges_reading_id_fkey;
alter table public.charges
  add constraint charges_reading_id_fkey
  foreign key (reading_id) references public.meter_readings(id) on delete set null;
