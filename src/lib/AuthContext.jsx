import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { sb } from './supabase'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [parks, setParks] = useState([])
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(async (uid) => {
    if (!uid) {
      setProfile(null)
      setParks([])
      return
    }
    const { data: p } = await sb()
      .from('profiles')
      .select('id, full_name, email, phone, role, is_active, must_change_pwd')
      .eq('id', uid)
      .single()

    setProfile(p || null)

    // RLS 已按授权过滤，super_admin 自然拿到全部园区
    const { data: pk } = await sb()
      .from('parks')
      .select('id, code, name, city')
      .eq('is_active', true)
      .order('sort_order')
      .order('code')

    setParks(pk || [])
  }, [])

  useEffect(() => {
    let alive = true
    let pendingTimer
    let authEventId = 0

    const { data: sub } = sb().auth.onAuthStateChange((_evt, s) => {
      if (!alive) return
      const eventId = ++authEventId
      window.clearTimeout(pendingTimer)
      setSession(s)
      setLoading(true)

      // Do not call Supabase again inside onAuthStateChange. Auth callbacks run
      // under the auth lock; defer profile queries until this callback returns.
      pendingTimer = window.setTimeout(() => {
        loadProfile(s?.user?.id)
          .catch(() => {
            setProfile(null)
            setParks([])
          })
          .finally(() => {
            if (alive && eventId === authEventId) setLoading(false)
          })
      }, 0)
    })

    return () => {
      alive = false
      window.clearTimeout(pendingTimer)
      sub?.subscription?.unsubscribe()
    }
  }, [loadProfile])

  const role = profile?.role || null
  const isSuper = role === 'super_admin'

  // 权限矩阵，与数据库 RLS 保持一致
  const can = {
    manageUsers: isSuper,
    editPark: isSuper || role === 'pm',
    editUnit: isSuper || role === 'pm' || role === 'cs',
    mergeSplit: isSuper || role === 'pm' || role === 'cs',
    editLease: isSuper || role === 'pm' || role === 'cs',
    confirmPayment: isSuper || role === 'pm' || role === 'cs',
    editMeter: isSuper || role === 'pm' || role === 'engineer',
    readMeter: isSuper || role === 'pm' || role === 'engineer',
    editSettings: isSuper,
  }

  const value = {
    session,
    user: session?.user || null,
    profile,
    parks,
    role,
    isSuper,
    can,
    loading,
    reload: () => loadProfile(session?.user?.id),
    signIn: async (email, password) => {
      const { error } = await sb().auth.signInWithPassword({ email, password })
      if (error) throw new Error(mapAuthError(error.message))
    },
    signOut: async () => {
      await sb().auth.signOut()
      setProfile(null)
      setParks([])
    },
    changePassword: async (password) => {
      const { error } = await sb().auth.updateUser({ password })
      if (error) throw new Error(error.message)
      await sb().from('profiles').update({ must_change_pwd: false }).eq('id', profile.id)
      await loadProfile(profile.id)
    },
  }

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

function mapAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return '邮箱或密码不正确'
  if (/email not confirmed/i.test(msg)) return '账号尚未激活，请联系管理员'
  if (/too many requests/i.test(msg)) return '尝试次数过多，请稍后再试'
  return msg
}
