-- =============================================================
-- 16 单个房源删除保护和审计
-- 增量脚本，可重复执行。不会删除任何已有数据。
-- 无关联记录的房源可删除，不按空置/已租状态限制。
-- 必须先执行本脚本，再发布显示全部删除入口的新前端。
-- =============================================================
begin;

-- 在数据库中校验，而不是只靠前端判断，防止绕过界面或误删历史。
-- SECURITY DEFINER 仅用于完整检查关联记录及写审计；调用方 DELETE 仍受 units 的 RLS 约束。
create or replace function public.tg_guard_unit_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists(select 1 from public.lease_units where unit_id=old.id) then
    raise exception using errcode='23503', message='该房源已关联租约或物业服务合同（含历史合同），不能删除。请保留房源及合同记录。';
  end if;
  if exists(select 1 from public.meters where unit_id=old.id) then
    raise exception using errcode='23503', message='该房源已关联水电表，不能删除。请先在能源管理中核对并调整表具归属，抄表记录不会自动删除。';
  end if;
  if exists(select 1 from public.unit_operation_items where unit_id=old.id) then
    raise exception using errcode='23503', message='该房源存在合并或拆分台账，不能删除。请保留房源用于追溯历史，已注销房源默认不显示。';
  end if;
  if exists(select 1 from public.attachments where owner_type='unit' and owner_id=old.id::text) then
    raise exception using errcode='23503', message='该房源已关联凭证附件，不能删除。凭证及对应房源须保留。';
  end if;
  insert into public.audit_logs(user_id,park_id,action,entity,entity_id,detail)
  values(auth.uid(),old.park_id,'unit.delete','units',old.id::text,
         jsonb_build_object('unit_no',old.unit_no,'before',to_jsonb(old)));
  return old;
end $$;

drop trigger if exists trg_units_safe_delete on public.units;
create trigger trg_units_safe_delete before delete on public.units
  for each row execute function public.tg_guard_unit_delete();

-- 附件是多态关联，没有普通外键。上传房源凭证时锁定父房源，
-- 避免删除检查后又并发插入指向已删除房源的附件元数据。
create or replace function public.tg_validate_unit_attachment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit record;
begin
  if new.owner_type='unit' then
    select id,park_id into v_unit from public.units where id::text=new.owner_id for key share;
    if not found then
      raise exception using errcode='23503',message='房源不存在或已被删除，不能关联凭证附件。';
    end if;
    if new.park_id<>v_unit.park_id then
      raise exception using errcode='23503',message='房源凭证的园区与房源所属园区不一致。';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_attachments_unit_source on public.attachments;
create trigger trg_attachments_unit_source before insert or update of owner_type,owner_id,park_id on public.attachments
  for each row execute function public.tg_validate_unit_attachment();

revoke all on function public.tg_guard_unit_delete() from public,anon;
revoke all on function public.tg_validate_unit_attachment() from public,anon;
grant execute on function public.tg_guard_unit_delete() to authenticated;
grant execute on function public.tg_validate_unit_attachment() to authenticated;

-- 前端只调用此入口；未升级数据库时会明确报错，不退回无保护的删除。
create or replace function public.delete_unit(p_unit_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_unit record;
begin
  select id,park_id into v_unit from public.units where id=p_unit_id for update;
  if not found then
    raise exception using errcode='P0002',message='该房源不存在或已被删除，请刷新列表。';
  end if;
  if not coalesce(public.can_write(v_unit.park_id,array['pm','cs']::user_role[]),false) then
    raise exception using errcode='42501',message='你没有删除该园区房源的权限。';
  end if;
  delete from public.units where id=p_unit_id;
  return p_unit_id;
end $$;
revoke all on function public.delete_unit(uuid) from public,anon;
grant execute on function public.delete_unit(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
