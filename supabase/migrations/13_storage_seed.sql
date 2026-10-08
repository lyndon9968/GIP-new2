-- =============================================================
-- 13 Storage 存储桶 + 初始超级管理员 + 示例园区
-- =============================================================

-- -------------------------------------------------------------
-- 凭证存储桶（私有，通过签名 URL 访问）
-- 路径约定：{park_id}/{owner_type}/{owner_id}/{文件名}
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gip-files', 'gip-files', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 按路径首段(park_id)校验园区权限
drop policy if exists p_storage_read on storage.objects;
create policy p_storage_read on storage.objects for select to authenticated
using (
  bucket_id = 'gip-files'
  and public.has_park(nullif(split_part(name, '/', 1), '')::uuid)
);

drop policy if exists p_storage_write on storage.objects;
create policy p_storage_write on storage.objects for insert to authenticated
with check (
  bucket_id = 'gip-files'
  and public.can_write(nullif(split_part(name, '/', 1), '')::uuid,
                       array['pm','cs','engineer']::user_role[])
);

drop policy if exists p_storage_update on storage.objects;
create policy p_storage_update on storage.objects for update to authenticated
using (
  bucket_id = 'gip-files'
  and public.can_write(nullif(split_part(name, '/', 1), '')::uuid,
                       array['pm','cs','engineer']::user_role[])
);

-- 凭证永久保存：仅 super_admin 可删除
drop policy if exists p_storage_delete on storage.objects;
create policy p_storage_delete on storage.objects for delete to authenticated
using (bucket_id = 'gip-files' and public.is_super_admin());

-- =============================================================
-- 初始超级管理员
-- 步骤：
--   1) Supabase 控制台 → Authentication → Users → Add user
--      勾选 Auto Confirm User，填邮箱与初始密码
--   2) 回到 SQL Editor，把下面邮箱改成你刚建的账号，执行这段
--   3) 首次登录后系统会要求改密（must_change_pwd）
-- 无公开注册入口：其余用户全部由超级管理员在"系统设置"里创建
-- =============================================================
do $$
declare v_uid uuid;
begin
  select id into v_uid from auth.users
   where email = 'chenlaiyuan@zhaoshang.net'      -- ← 改成你的邮箱
   limit 1;

  if v_uid is null then
    raise notice '未找到该邮箱的 auth 用户，请先在控制台创建后重跑本段';
  else
    insert into public.profiles (id, full_name, email, role, is_active, must_change_pwd)
    values (v_uid, '总经理', 'admin@guchuan.com', 'super_admin', true, true)
    on conflict (id) do update
      set role = 'super_admin', is_active = true, full_name = excluded.full_name;
    raise notice '超级管理员已就绪: %', v_uid;
  end if;
end $$;

-- =============================================================
-- 关闭公开注册（也请在控制台 Authentication → Providers 里
-- 关闭 "Enable email signups"，双重保险）
-- =============================================================

-- -------------------------------------------------------------
-- 可选：示例园区（验证通过后可删除这一段）
-- -------------------------------------------------------------
-- insert into public.parks (code, name, city, land_area, gfa_above, gfa_below, parking_count)
-- values ('GC01', '谷川科技园一期', '深圳', 52000, 86000, 14000, 320)
-- on conflict (code) do nothing;
