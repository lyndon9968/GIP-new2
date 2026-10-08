-- =============================================================
-- 谷川高科 工业园区管理系统 (GIP)
-- 01 扩展与枚举类型
-- 在 Supabase SQL Editor 中按文件编号顺序执行
-- =============================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- 用户角色
do $$ begin
  create type user_role as enum (
    'super_admin',   -- 总经理/超级管理员：全部园区、全部权限
    'pm',            -- 物业经理：授权园区内全部业务权限
    'engineer',      -- 工程人员：抄表、房源查看
    'cs'             -- 客服：房源与租约可录入
  );
exception when duplicate_object then null; end $$;

-- 房源存储状态（派生状态见 v_unit_status）
do $$ begin
  create type unit_status as enum (
    'vacant',        -- 空置
    'leased',        -- 已租
    'sold',          -- 已售
    'reserved',      -- 预留/锁定
    'voided'         -- 已注销（因合并或拆分）
  );
exception when duplicate_object then null; end $$;

-- 房源可经营属性
do $$ begin
  create type unit_purpose as enum (
    'rent_only',     -- 仅可出租
    'sale_only',     -- 仅可销售
    'rent_or_sale',  -- 可租可售
    'self_use',      -- 自用/办公
    'common'         -- 公共区域（不计出租率）
  );
exception when duplicate_object then null; end $$;

-- 主体类型：租户 / 已售物业业主
do $$ begin
  create type party_kind as enum ('tenant', 'owner');
exception when duplicate_object then null; end $$;

-- 合约类型
do $$ begin
  create type lease_kind as enum (
    'rental',        -- 租赁合同：租金 + 物业费 + 水电
    'ownership'      -- 已售物业服务合同：物业费 + 水电，无租金
  );
exception when duplicate_object then null; end $$;

-- 合约状态
do $$ begin
  create type lease_status as enum (
    'draft',         -- 草稿（未生成收款计划）
    'active',        -- 履约中
    'expired',       -- 到期
    'terminated'     -- 提前终止
  );
exception when duplicate_object then null; end $$;

-- 合约内特殊期间类型（起止完全由录入人自由设定，可重叠）
do $$ begin
  create type lease_period_kind as enum ('fitout', 'rent_free');
exception when duplicate_object then null; end $$;

-- 费用类型
do $$ begin
  create type charge_type as enum (
    'rent',          -- 租金
    'property_fee',  -- 物业费
    'water',         -- 水费
    'electricity',   -- 电费
    'deposit',       -- 押金
    'other'          -- 其它（违约金、维修分摊等）
  );
exception when duplicate_object then null; end $$;

-- 账单状态
do $$ begin
  create type charge_status as enum (
    'unpaid',        -- 未收
    'partial',       -- 部分收款
    'paid',          -- 已收（前端"确认收款"后置为此状态）
    'waived',        -- 免收（免租期/装修期减免，金额为 0 也生成便于预期收入统计）
    'void'           -- 作废
  );
exception when duplicate_object then null; end $$;

-- 收款方式
do $$ begin
  create type payment_method as enum ('bank_transfer', 'cash', 'cheque', 'alipay', 'wechat', 'other');
exception when duplicate_object then null; end $$;

-- 表类型
do $$ begin
  create type meter_type as enum ('water', 'electricity');
exception when duplicate_object then null; end $$;

-- 损耗分摊方式（园区级可配置）
do $$ begin
  create type loss_alloc_method as enum (
    'none',          -- 不分摊
    'by_area',       -- 按建筑面积比例分摊
    'by_usage'       -- 按各租户用量比例分摊
  );
exception when duplicate_object then null; end $$;

-- 房源变更操作类型
do $$ begin
  create type unit_op_kind as enum ('merge', 'split');
exception when duplicate_object then null; end $$;

-- 附件业务归属
do $$ begin
  create type attachment_owner as enum (
    'lease', 'payment', 'meter_reading', 'party', 'unit', 'charge'
  );
exception when duplicate_object then null; end $$;

