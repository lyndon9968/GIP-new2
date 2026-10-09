import { useState, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { usePageCache } from '../lib/PageCache'
import { useAuth } from '../lib/AuthContext'
import { ROLE_LABEL } from '../lib/format'
import { getAppName } from '../lib/supabase'

const NAV = [
  { to: '/', ico: '▤', label: '数据概览', end: true },
  { to: '/units', ico: '▦', label: '房源管理' },
  { to: '/leases', ico: '▧', label: '租约管理' },
  { to: '/energy', ico: '◍', label: '能源管理' },
  { to: '/settings', ico: '⚙', label: '系统设置' },
]

const TITLES = {
  '/': '数据概览',
  '/units': '房源管理',
  '/leases': '租约管理',
  '/energy': '能源管理',
  '/settings': '系统设置',
}

export default function Layout({ children }) {
  const { profile, signOut, reload } = useAuth()
  const { refresh, busy } = usePageCache()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const refreshingRef = useRef(false)
  const [drawer, setDrawer] = useState(false)
  const loc = useLocation()
  const path = loc.pathname.replace(/\/$/, '') || '/'
  const pageBusy = refreshing || busy[path]
  const title = TITLES[loc.pathname] || '园区管理'
  const refreshCurrent = async () => {
    if (pageBusy || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true); setRefreshError('')
    try {
      // Revalidate park/role access before refreshing the current page.
      await reload()
      refresh(path)
    } catch (ex) {
      setRefreshError(`刷新失败：${ex.message}`)
    } finally { refreshingRef.current = false; setRefreshing(false) }
  }

  const nav = (
    <nav onClick={() => setDrawer(false)}>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end}>
          <span className="ico" aria-hidden="true">{n.ico}</span>
          {n.label}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="app">
      {drawer ? <div className="drawer-mask" onClick={() => setDrawer(false)} /> : null}

      <aside className={`sidebar${drawer ? ' open' : ''}`}>
        <div className="logo">
          <img className="brand-logo" src="/goaltry-logo.png" alt="谷川高科 GOALTRY" />
          <span className="brand-title">{getAppName()}</span>
          <small>工业园区管理系统</small>
        </div>
        {nav}
        <div className="foot">
          <div className="who">{profile?.full_name || profile?.email || '用户'}</div>
          <div className="role">{ROLE_LABEL[profile?.role] || ''}</div>
          <button onClick={signOut}>退出登录</button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setDrawer(true)} aria-label="打开菜单">☰</button>
          <h1>{title}</h1>
          <span className="hint page-cache-hint">切换页面保留数据</span>
          <button className="btn sm" onClick={refreshCurrent} disabled={pageBusy}>
            {pageBusy ? '刷新中…' : '刷新'}
          </button>
        </header>
        <div className="content">
          {refreshError && <div className="err" role="alert">{refreshError}</div>}
          {children}
        </div>
      </div>

      <nav className="mobile-nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <span className="ico" aria-hidden="true">{n.ico}</span>
            {n.label.replace('管理', '').replace('数据', '')}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

// 园区选择器，非 super_admin 只看到授权园区
export function ParkPicker({ value, onChange, allowAll = false, label = '园区' }) {
  const { parks } = useAuth()
  return (
    <div style={{ minWidth: 172 }}>
      {label ? <label className="f">{label}</label> : null}
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {allowAll ? <option value="">全部园区</option> : null}
        {parks.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  )
}
