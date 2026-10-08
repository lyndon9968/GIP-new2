-- 如果 13_storage_seed.sql 已经执行过，运行本脚本同步超级管理员档案邮箱。
-- 只更新 super_admin 档案；邮箱来源于对应的 Supabase Auth 用户。
update public.profiles as p
   set email = u.email
  from auth.users as u
 where p.id = u.id
   and p.role = 'super_admin'
   and p.email is distinct from u.email;
