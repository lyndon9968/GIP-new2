// 用户管理：创建 / 删除 / 重置密码
// 需要 service_role，只能在服务端执行；调用者必须是 super_admin
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const json = (body, status = 200) => Response.json(body, { status })

// 用调用者的 JWT 校验其身份，确认是 super_admin
async function requireSuperAdmin(req) {
  const auth = req.headers.get('authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token) return { error: '未登录', status: 401 }

  const asUser = createClient(URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userRes, error: uErr } = await asUser.auth.getUser()
  if (uErr || !userRes?.user) return { error: '登录状态无效', status: 401 }

  const { data: profile } = await asUser
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', userRes.user.id)
    .single()

  if (!profile?.is_active || profile.role !== 'super_admin') {
    return { error: '仅超级管理员可执行此操作', status: 403 }
  }
  return { callerId: profile.id }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405)
  if (!URL || !ANON || !SERVICE) return json({ error: '服务端环境变量缺失' }, 500)

  const guard = await requireSuperAdmin(req)
  if (guard.error) return json({ error: guard.error }, guard.status)

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: '请求体格式错误' }, 400)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { action } = body

  try {
    if (action === 'create') {
      const { email, password, fullName, phone, role, parkIds } = body
      if (!email || !password) return json({ error: '邮箱与初始密码必填' }, 400)
      if (String(password).length < 8) return json({ error: '初始密码至少 8 位' }, 400)

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName || '', role: role || 'cs' },
      })
      if (error) return json({ error: error.message }, 400)

      const uid = data.user.id
      // 触发器已建档，这里补齐字段（角色以本次提交为准）
      await admin.from('profiles').update({
        full_name: fullName || '',
        phone: phone || null,
        email,
        role: role || 'cs',
        is_active: true,
        must_change_pwd: true,
        created_by: guard.callerId,
      }).eq('id', uid)

      if (Array.isArray(parkIds) && parkIds.length) {
        await admin.from('user_parks').insert(
          parkIds.map((pid) => ({ user_id: uid, park_id: pid, granted_by: guard.callerId }))
        )
      }

      await admin.from('audit_logs').insert({
        user_id: guard.callerId,
        action: 'user.create',
        entity: 'profiles',
        entity_id: uid,
        detail: { email, role: role || 'cs', parks: parkIds || [] },
      })

      return json({ ok: true, userId: uid })
    }

    if (action === 'delete') {
      const { userId } = body
      if (!userId) return json({ error: '缺少 userId' }, 400)
      if (userId === guard.callerId) return json({ error: '不能删除自己的账号' }, 400)

      const { data: target } = await admin
        .from('profiles').select('email, role').eq('id', userId).single()

      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) return json({ error: error.message }, 400)

      await admin.from('audit_logs').insert({
        user_id: guard.callerId,
        action: 'user.delete',
        entity: 'profiles',
        entity_id: userId,
        detail: { email: target?.email, role: target?.role },
      })

      return json({ ok: true })
    }

    if (action === 'reset_password') {
      const { userId, password } = body
      if (!userId || !password) return json({ error: '缺少参数' }, 400)
      if (String(password).length < 8) return json({ error: '密码至少 8 位' }, 400)

      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) return json({ error: error.message }, 400)

      await admin.from('profiles').update({ must_change_pwd: true }).eq('id', userId)
      await admin.from('audit_logs').insert({
        user_id: guard.callerId,
        action: 'user.reset_password',
        entity: 'profiles',
        entity_id: userId,
      })

      return json({ ok: true })
    }

    if (action === 'set_active') {
      const { userId, isActive } = body
      if (!userId) return json({ error: '缺少 userId' }, 400)
      if (userId === guard.callerId) return json({ error: '不能停用自己的账号' }, 400)

      const { error } = await admin
        .from('profiles').update({ is_active: !!isActive }).eq('id', userId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: `未知操作: ${action}` }, 400)
  } catch (e) {
    return json({ error: e.message || '服务端异常' }, 500)
  }
}
