-- =============================================================
-- 05 账单 / 明细 / 收款 / 附件
-- =============================================================

-- -------------------------------------------------------------
-- 应收单（收款计划表）
-- 签约后由 generate_lease_schedule() 一次性生成全生命周期记录，
-- 因此"未来一年预期收入"可直接查表，无需逐月录入。
-- -------------------------------------------------------------
create table if not exists public.charges (
  id             uuid primary key default gen_random_uuid(),
  park_id        uuid not null references public.parks(id)  on delete cascade,
  lease_id       uuid not null references public.leases(id) on delete cascade,
  charge_type    charge_type not null,

  period_start   date not null,      -- 计费期间起
  period_end     date not null,      -- 计费期间止
  bill_month     date not null,      -- 归属月份（当月1日），用于概览按月汇总
  due_date       date not null,      -- 应交日期
  seq_no         int  not null default 1,   -- 第几期

  amount         numeric(14,2) not null default 0,   -- 应交金额
  paid_amount    numeric(14,2) not null default 0,   -- 已收金额（由 payments 触发器汇总）
  status         charge_status not null default 'unpaid',

  reading_id     bigint,             -- 水电账单关联的抄表记录（05 后由 06 补外键）
  auto_generated boolean not null default true,
  remark         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (period_end >= period_start)
);

create index if not exists idx_charges_lease  on public.charges(lease_id, charge_type, period_start);
create index if not exists idx_charges_park   on public.charges(park_id, bill_month);
create index if not exists idx_charges_due    on public.charges(due_date) where status in ('unpaid','partial');
create index if not exists idx_charges_month  on public.charges(park_id, charge_type, bill_month);
-- 同一租约同类型同期间唯一（水电按抄表另开一条，故排除）
create unique index if not exists uq_charges_period
  on public.charges(lease_id, charge_type, period_start)
  where charge_type in ('rent','property_fee');

create trigger trg_charges_updated before update on public.charges
  for each row execute function public.tg_set_updated_at();

-- -------------------------------------------------------------
-- 账单明细：按自然月拆分，体现"当月天数"与免租扣减，便于对账
-- 租金 = Σ(面积 × 单价 × 该月计费天数)   单价 元/㎡/天
-- 物业费 = Σ(面积 × 单价 × 该月计费天数 / 该月自然天数)  单价 元/㎡/月
-- -------------------------------------------------------------
create table if not exists public.charge_details (
  id            bigserial primary key,
  charge_id     uuid not null references public.charges(id) on delete cascade,
  month         date not null,          -- 该自然月1日
  days_in_month int  not null,          -- 自然月天数
  billable_days int  not null,          -- 实际计费天数（已扣免租/装修减免）
  waived_days   int  not null default 0,
  area          numeric(12,2) not null default 0,
  unit_price    numeric(12,4) not null default 0,
  amount        numeric(14,2) not null default 0,
  remark        text
);
create index if not exists idx_charge_details_charge on public.charge_details(charge_id, month);

-- -------------------------------------------------------------
-- 收款记录（"确认收款"按钮写这里，charges.paid_amount 由触发器汇总）
-- -------------------------------------------------------------
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  charge_id     uuid not null references public.charges(id) on delete cascade,
  park_id       uuid not null references public.parks(id)   on delete cascade,
  amount        numeric(14,2) not null check (amount <> 0),
  paid_at       date not null default current_date,
  method        payment_method not null default 'bank_transfer',
  reference_no  text,                       -- 银行回单号/流水号
  confirmed_by  uuid references public.profiles(id),
  confirmed_at  timestamptz not null default now(),
  remark        text
);
create index if not exists idx_payments_charge on public.payments(charge_id);
create index if not exists idx_payments_park   on public.payments(park_id, paid_at);

-- -------------------------------------------------------------
-- 附件：凭证永久保存于 Supabase Storage，本表存路径与元数据
-- storage 路径约定：{park_id}/{owner_type}/{owner_id}/{uuid}.{ext}
-- -------------------------------------------------------------
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  park_id      uuid not null references public.parks(id) on delete cascade,
  owner_type   attachment_owner not null,
  owner_id     text not null,             -- 关联业务主键（uuid 或 bigint 转文本）
  bucket       text not null default 'gip-files',
  path         text not null,             -- Storage 对象路径
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  category     text,                      -- 'contract' | 'meter_photo' | 'bank_receipt' | ...
  uploaded_by  uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_attachments_owner on public.attachments(owner_type, owner_id);
create index if not exists idx_attachments_park  on public.attachments(park_id, created_at desc);
