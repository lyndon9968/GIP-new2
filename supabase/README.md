# 谷川高科 工业园区管理系统 — 数据库

## 执行顺序

在 Supabase 控制台 → SQL Editor 中，按编号依次执行（一个文件一次，不要合并）：

| # | 文件 | 内容 |
|---|------|------|
| 01 | `01_extensions_enums.sql` | 扩展、全部枚举类型 |
| 02 | `02_core_tables.sql` | 用户档案、园区、园区参数、用户授权、系统设置、审计日志 |
| 03 | `03_property_tables.sql` | 楼栋、房源、合并拆分台账 |
| 04 | `04_lease_tables.sql` | 租户/业主、合约、合约房源、免租装修期、阶梯租金 |
| 05 | `05_billing_tables.sql` | 应收单、账单明细、收款记录、附件 |
| 06 | `06_energy_tables.sql` | 水电表、抄表记录 |
| 07 | `07_fn_helpers_units.sql` | 权限判定函数、房号生成、合并 / 拆分 |
| 08 | `08_fn_billing.sql` | 收款计划生成、状态同步、确认收款 |
| 09 | `09_fn_energy.sql` | 上期读数自动带入、自动出账、损耗分摊 |
| 10 | `10_views_units_leases.sql` | 房源状态机视图、账单预警视图、租约卡片视图 |
| 11 | `11_views_dashboard.sql` | 公司/园区概览、能源统计、预期收入 |
| 12 | `12_rls_policies.sql` | 行级安全策略、权限矩阵、授权 |
| 13 | `13_storage_seed.sql` | Storage 桶与策略、初始超级管理员 |
| 14 | `14_park_rentable_area.sql` | 人工录入可出租面积、园区和公司出租率统计 |
| 15 | `15_multi_location_units.sql` | 整栋、多层、跨栋房源；合并、拆分及租约展示升级 |

## 已上线项目：支持跨栋／跨层房源

已执行 01–14 的项目，只执行完整的 `migrations/15_multi_location_units.sql`，
不要重跑前面的建表脚本。先升级数据库，再发布前端；本脚本可重复执行。
脚本会为旧房源补上原来的单层位置，不会猜测或自动扩大到整栋。

在“房源管理 → 新增房源／编辑”选择“单层／多层／整栋”：
整栋使用楼栋登记的全部地上和地下楼层，请先确认楼栋层数；
面积填写整体总面积，不按楼层数相乘。已有 A、B 房源若实际上各为三层整栋，
分别编辑为“整栋”即可；不要把不同客户的 A、B 房源合并。

合并支持同园区跨栋、跨层，全部空置或全部已租、经营属性一致。
已租房源须全部未关联租约，或全部关联同一份租赁合同；不同合同、
混合已签约与未签约、已售、预留、注销房源不允许直接合并。
数据库还会校验草稿租约和表具归属，所有更改在同一事务完成。
同合同合并保留计租面积（含合同手动覆盖值）、账单、收款、抄表及凭证，
表具转到新房源但保留原安装楼栋。历史已结束合同仍引用旧房源。

原房号注销，新房号按首个覆盖位置（栋号、楼层排序）生成，编号不复用。
列表、合同卡片及表具选择显示完整覆盖位置，栋号筛选匹配任一覆盖楼栋。
跨栋／多层房源拆分时，要为每个子房源选择原位置，合计覆盖所有原位置，
使用面积和公摊面积分别校验；已关联当前租约或表具时必须先处理归属。

## 已上线项目：增加可出租面积字段

已经执行过 01–13 的项目，只需在 SQL Editor 中运行完整的
`migrations/14_park_rentable_area.sql`，不要重跑建表脚本。
先执行此 SQL，再发布新前端。在“系统设置 → 园区与参数 → 资料”中
填写已有园区的“可出租面积（㎡）”，保存后概览和出租率会采用该数值。
留空表示按房源自动汇总；填写 0 表示无出租物业。新增园区同样支持此字段，
切换页面后草稿会保留该字段。

## 执行 13 之前必须做的两件事

1. **Authentication → Users → Add user**，勾选 `Auto Confirm User`，创建总经理账号。
2. 在 `13_storage_seed.sql` 中把 `v_admin_email` 默认值改成上一步创建的真实邮箱（只改这一处）。

执行完 13 之后，去 **Authentication → Providers → Email** 关闭 `Enable email signups`，
彻底封掉公开注册。之后所有用户由超级管理员在系统内创建。

如果 13 已经执行过，运行 `supabase/fixes/20261008_sync_admin_profile_email.sql`，
可将超级管理员档案邮箱与其 Auth 登录邮箱同步。

## 前端调用约定

用户不接触 URL 和 API Key。Netlify Function 从环境变量下发 anon key：

```
SUPABASE_URL              # Netlify 环境变量，不进前端代码
SUPABASE_ANON_KEY         # 由 /api/config 下发给浏览器
SUPABASE_SERVICE_ROLE_KEY # 仅服务端使用，用于创建/删除用户
```

`anon` 角色对业务表无任何权限，数据访问全部走登录后的 `authenticated` 身份 + RLS。
创建用户、删除用户、重置密码必须走 Netlify Function（需要 service_role），
不能在浏览器里调。

## 关键业务函数

```sql
-- 签约后生成全生命周期收款计划（第二个参数 true = 重算未收款账期）
select public.generate_lease_schedule('<lease_id>'::uuid, false);

-- 确认收款（金额留空 = 全额）
select public.confirm_payment('<charge_id>'::uuid, null, current_date,
                              'bank_transfer', '回单号', '<storage路径>', null);

-- 合并房源（同园区、可跨栋跨层；均空置或同合同已租），返回新房源 id
select public.merge_units(array['<id1>','<id2>']::uuid[]);

-- 拆分房源，子面积汇总须等于拆分前面积
select public.split_unit('<unit_id>'::uuid,
  '[{"usable_area":100,"shared_area":20},{"usable_area":80,"shared_area":16}]'::jsonb);

-- 水电损耗分摊（按园区+月份+表类型，抄表录完后执行一次）
select public.allocate_energy_loss('<park_id>'::uuid, date_trunc('month',current_date)::date, 'water');
```

## 计算规则备忘

- **租金**：`Σ 每自然月(计租面积 × 元/㎡/天 × 该月计费天数)`，按自然月实际天数
- **物业费**：`Σ 每自然月(计租面积 × 元/㎡/月 × 该月计费天数 ÷ 该月自然天数)`
- **应交日**：账期首日 − `leases.due_advance_days`，随租约起始日滚动，非固定每月 1 日
- **逾期天数**：`current_date − due_date`，次日起算（当天为 0）
- **预警等级**：0 正常 / 1 七日内到期 / 2 逾期 1–6 天 / 3 逾期 ≥7 天（警示红）
- **免租与装修期**：起止自由设定、可重叠、可多段，`waive_rent` 与 `waive_fee` 分别控制
  是否减免租金和物业费；重叠天数已去重，不会重复扣减
- **房源编号**：栋号 + 层(2位) + 序号(2位)，地下层加 `B`，如 `A10305`、`A1B0102`。
  序号取同栋同层历史最大值 +1，注销编号不复用
- **已售物业**：作为 `lease_kind='ownership'` 的合约管理，无租金，物业费与水电费的
  出账、逾期、收款确认与租赁物业完全一致

## 验证范围

14、15 增量脚本已在本地 PostgreSQL 兼容运行时 PGlite 中执行验证，15 同时验证了
重复升级、跨栋跨层合并、同合同计租面积和账单保留、拆分位置及面积校验、园区权限。
这不是线上 Supabase 验证；执行前建议备份，在测试项目中先运行。Storage 桶等
Supabase 专属功能不在本地数据库验证范围内。
