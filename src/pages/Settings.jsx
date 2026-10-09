import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import UsersPanel from './SettingsUsers'
import ParksPanel from './SettingsParks'
import MyAccount from './SettingsAccount'
import { CachedPage } from '../lib/PageCache'

export default function Settings() {
  const { isSuper, can } = useAuth()
  const tabs = [
    ...(isSuper ? [{ k: 'users', t: '用户与权限' }] : []),
    ...(can.editPark ? [{ k: 'parks', t: '园区与参数' }] : []),
    { k: 'me', t: '我的账号' },
  ]
  const [tab, setTab] = useState(tabs[0].k)

  return (
    <>
      <div className="seg mb">
        {tabs.map((x) => (
          <button key={x.k} className={tab === x.k ? 'on' : ''} onClick={() => setTab(x.k)}>{x.t}</button>
        ))}
      </div>

      {isSuper && <CachedPage active={tab === 'users'}><UsersPanel /></CachedPage>}
      {can.editPark && <CachedPage active={tab === 'parks'}><ParksPanel /></CachedPage>}
      <CachedPage active={tab === 'me'}><MyAccount /></CachedPage>
    </>
  )
}
