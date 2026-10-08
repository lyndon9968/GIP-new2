# 部署到 Netlify

## 1. Supabase 准备

- 确认数据库迁移已全部成功执行；已创建 Auth 超级管理员，并关闭 Email 公开注册。
- 在 Supabase Storage 确认存在私有桶 `gip-files`。
- 为 Supabase 项目配置允许的站点 URL / Redirect URLs（Netlify 生产域名及本地开发地址）。
- 如初始化脚本已执行，运行 `supabase/fixes/20261008_sync_admin_profile_email.sql` 同步管理员档案邮箱。

## 2. Netlify 环境变量

在 Netlify 项目 → Site configuration → Environment variables 中设置：

| 变量 | 值 | 作用 |
|---|---|---|
| `SUPABASE_URL` | Supabase 项目 URL | 服务端下发连接配置 |
| `SUPABASE_ANON_KEY` | Supabase `anon`（legacy）key | 登录用户经 RLS 访问数据；`/api/config` 会下发给浏览器 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role`（legacy）key | 仅 Netlify Functions 使用，绝不能放进前端或提交到代码库 |
| `APP_NAME` | `谷川高科`（可选） | 页面品牌名称 |

设置变量后触发一次新部署。不要将这些值写进 `.env` 并提交，也不要把 service role key 发给普通用户。
当前项目代码按 Supabase 旧密钥名称实现；先用 Dashboard 的 `anon` 和 `service_role` 两个旧 key 完成部署。
Supabase 正迁移到 publishable/secret key，并计划在 2026 年底弃用旧 key；切换前应先更新并测试项目代码，
不要现在就关闭旧 key。

## 3. 发布

将此项目导入 Netlify（连接 Git 仓库），构建设置由 `netlify.toml` 提供：

- Build command：`npm run build`
- Publish directory：`dist`
- Functions directory：`netlify/functions`

注意：`npm run preview` 只运行 Vite 静态预览，不会运行 `/api/config` 等 Netlify Functions，
因此不能用它验证登录或 Supabase 连接。本地完整预览请运行 `npm run netlify:dev`；需先安装 Netlify CLI：

```powershell
npm install --global netlify-cli
netlify env:import .env.local
npm run netlify:dev
```

`.env.local` 只保存在本机，至少包含上述三个 Supabase 环境变量；不要提交该文件。

## 4. 上线前验收

1. 使用总经理账号登录并完成首次改密；确认园区、房源、租约页面能读取数据。
2. 创建一个测试用户，验证园区授权、停用、删除和重置密码。
3. 用工程人员手机打开抄表页，录入测试读数并上传凭证，确认照片可查看。
4. 用客服账号验证房源可录入、租金/物业费收款权限符合预期，但不能修改系统设置或用户权限。
5. 确认 Storage 桶为私有，附件通过短期签名 URL 查看；检查 Netlify 部署日志不包含密钥。

项目可在本地通过 `npm run build` 构建。数据库脚本仍需在 Supabase 项目中按 `supabase/README.md` 验证；本地没有数据库环境，不能把前端构建成功等同于端到端验收通过。
