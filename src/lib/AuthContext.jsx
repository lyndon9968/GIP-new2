import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from './supabase'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [parks, setParks] = useState([])
  const [loading, setLoading] = useState(true)
  const currentUser = useRef(null)
  const profileRequest = useRef(0)

  const loadProfile = useCallback(async (uid) => {
    const request = ++profileRequest.current
    if (!uid) {
      setProfile(null)
      setParks([])
      return
    }
    // RLS 已按授权过滤，super_admin 自然拿到全部园区
    const [p, pk] = await Promise.all([
      sb().from('profiles').select('id, full_name, email, phone, role, is_active, must_change_pwd').eq('id', uid).single(),
      sb().from('parks').select('id, code, name, city').eq('is_active', true).order('sort_order').order('code'),
    ])
    if (request !== profileRequest.current || currentUser.current !== uid) return null
    if (p.error) throw new Error(p.error.message)
    if (pk.error) throw new Error(pk.error.message)
    setProfile(p.data || null)
    setParks(pk.data || [])
    return p.data
  }, [])

  useEffect(() => {
    let alive = true
    let pendingTimer
    let authEventId = 0

    const { data: sub } = sb().auth.onAuthStateChange((evt, s) => {
      if (!alive) return
      const uid = s?.user?.id || null
      const sameUser = uid && uid === currentUser.current
      setSession(s)
      // Supabase may emit SIGNED_IN on tab focus and TOKEN_REFRESHED regularly.
      // Neither event should tear down pages or discard data/drafts for this user.
      if (sameUser && ['SIGNED_IN', 'TOKEN_REFRESHED'].includes(evt)) return
      const eventId = ++authEventId
      window.clearTimeout(pendingTimer)
      currentUser.current = uid
      if (!sameUser) {
        setProfile(null); setParks([])
        setLoading(!!uid)
      }
      if (!uid) { ++profileRequest.current; return }

      // Do not call Supabase again inside onAuthStateChange. Auth callbacks run
      // under the auth lock; defer profile queries until this callback returns.
      pendingTimer = window.setTimeout(() => {
        loadProfile(uid)
          .catch(() => {
            if (alive && eventId === authEventId && currentUser.current === uid) {
              setProfile(null)
              setParks([])
            }
          })
          .finally(() => {
            if (alive && eventId === authEventId) setLoading(false)
          })
      }, 0)
    })

    return () => {
      alive = false
      ++profileRequest.current
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
      const { error } = await sb().auth.signOut()
      if (error) throw new Error(error.message)
      currentUser.current = null
      ++profileRequest.current
      setSession(null)
      setProfile(null)
      setParks([])
      try { sessionStorage.removeItem('gip-new-park-draft') } catch { /* unavailable storage */ }
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
