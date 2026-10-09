import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { ROLE_LABEL } from '../lib/format'
import { useManualRefresh } from '../lib/PageCache'

// 所有用户都可以在这里改密码和联系方式
export default function MyAccount() {
  const { profile, parks, isSuper, changePassword, reload } = useAuth()
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [info, setInfo] = useState({ full_name: profile.full_name || '', phone: profile.phone || '' })
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useManualRefresh(async () => {
    try {
      const fresh = await reload()
      if (fresh) setInfo({ full_name: fresh.full_name || '', phone: fresh.phone || '' })
    } catch (ex) { setErr(ex.message) }
  })

  const savePwd = async () => {
    setErr(''); setMsg('')
    if (p1.length < 8) return setErr('密码至少 8 位')
    if (p1 !== p2) return setErr('两次输入的密码不一致')
    setBusy(true)
    try {
      await changePassword(p1)
      setP1(''); setP2('')
      setMsg('密码已更新')
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  const saveInfo = async () => {
    setErr(''); setMsg('')
    setBusy(true)
    const { error } = await sb().from('profiles').update({
      full_name: info.full_name, phone: info.phone || null,
    }).eq('id', profile.id)
    setBusy(false)
    if (error) return setErr(error.message)
    reload()
    setMsg('资料已更新')
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))' }}>
      <div className="card">
        <div className="card-h"><h3>我的资料</h3></div>
        <div className="card-b">
          <div className="kv mb">
            <div><div className="k">登录邮箱</div><div className="v">{profile.email}</div></div>
            <div><div className="k">角色</div><div className="v">{ROLE_LABEL[profile.role]}</div></div>
            <div>
              <div className="k">授权园区</div>
              <div className="v" style={{ fontSize: 13 }}>
                {isSuper ? '全部园区' : parks.map((p) => p.name).join('、') || '未分配'}
              </div>
            </div>
          </div>

          <div className="frow">
            <div>
              <label className="f">姓名</label>
              <input value={info.full_name} onChange={(e) => setInfo({ ...info, full_name: e.target.value })} />
            </div>
            <div>
              <label className="f">联系电话</label>
              <input value={info.phone} onChange={(e) => setInfo({ ...info, phone: e.target.value })} />
            </div>
          </div>

          <button className="btn mt" onClick={saveInfo} disabled={busy}>保存资料</button>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>修改密码</h3></div>
        <div className="card-b">
          <div className="fgroup">
            <label className="f">新密码</label>
            <input type="password" value={p1} autoComplete="new-password"
                   onChange={(e) => setP1(e.target.value)} />
            <div className="hint">至少 8 位，建议含字母与数字</div>
          </div>
          <div className="fgroup">
            <label className="f">确认新密码</label>
            <input type="password" value={p2} autoComplete="new-password"
                   onChange={(e) => setP2(e.target.value)} />
          </div>

          {err ? <div className="err">{err}</div> : null}
          {msg ? <div className="ok-msg">{msg}</div> : null}

          <button className="btn primary" onClick={savePwd} disabled={busy}>
            {busy ? '保存中…' : '修改密码'}
          </button>
        </div>
      </div>
    </div>
  )
}
