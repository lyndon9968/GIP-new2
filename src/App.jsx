import { BrowserRouter, Navigate, useLocation } from 'react-router-dom'
import { CachedPage, PageCacheProvider } from './lib/PageCache'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import Dashboard from './pages/Dashboard'
import Units from './pages/Units'
import Leases from './pages/Leases'
import Energy from './pages/Energy'
import Settings from './pages/Settings'

function Gate() {
  const { session, profile, parks, loading, signOut } = useAuth()

  if (loading) return <div className="loading" style={{ paddingTop: 80 }}>加载中…</div>
  if (!session) return <Login />

  // 登录成功但档案缺失或被停用
  if (!profile) {
    return (
      <div className="login-wrap">
        <div className="login-box">
          <div className="lg">
            <h2>账号未开通</h2>
            <p>该账号尚未配置权限，请联系超级管理员</p>
          </div>
          <button className="btn block" onClick={signOut}>退出登录</button>
        </div>
      </div>
    )
  }
  if (!profile.is_active) {
    return (
      <div className="login-wrap">
        <div className="login-box">
          <div className="lg">
            <h2>账号已停用</h2>
            <p>请联系超级管理员恢复访问</p>
          </div>
          <button className="btn block" onClick={signOut}>退出登录</button>
        </div>
      </div>
    )
  }
  if (profile.must_change_pwd) return <ChangePassword />

  const accessKey = `${session.user.id}:${profile.role}:${parks.map((p) => p.id).sort().join(',')}`
  return <PageCacheProvider key={accessKey}>
    <Layout><WorkspacePages /></Layout>
  </PageCacheProvider>
}

const PAGES = [
  { path: '/', component: Dashboard }, { path: '/units', component: Units },
  { path: '/leases', component: Leases }, { path: '/energy', component: Energy },
  { path: '/settings', component: Settings },
]

function WorkspacePages() {
  const { pathname } = useLocation()
  const path = pathname.replace(/\/$/, '') || '/'
  return <>
    {PAGES.map(({ path: route, component: Page }) => <CachedPage key={route} path={route} active={path === route}>
      <Page />
    </CachedPage>)}
    {!PAGES.some((p) => p.path === path) && <Navigate to="/" replace />}
  </>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  )
}
