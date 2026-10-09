import { useEffect, useState, useRef } from 'react'
import { useManualRefresh } from '../lib/PageCache'
import { sb, callApi } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal, { ConfirmDialog } from '../components/Modal'
import { ROLE_LABEL } from '../lib/format'

// 用户管理：创建 / 删除 / 停用 / 重置密码 / 分配园区
export default function UsersPanel() {
  const { profile, parks } = useAuth()
  const [users, setUsers] = useState([])
  const [grants, setGrants] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [dlg, setDlg] = useState(null)
  const requestId = useRef(0)

  const load = async () => {
    const request = ++requestId.current
    setLoading(true); setErr('')
    try {
      const [u, g] = await Promise.all([
        sb().from('profiles').select('*').order('role').order('full_name'),
        sb().from('user_parks').select('user_id, park_id'),
      ])
      if (request !== requestId.current) return
      if (u.error) throw new Error(u.error.message)
      if (g.error) throw new Error(g.error.message)
      setUsers(u.data || [])
      setGrants(g.data || [])
    } catch (ex) {
      if (request === requestId.current) setErr(ex.message)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }

  useEffect(() => { load(); return () => { ++requestId.current } }, [])
  useManualRefresh(load, loading)

  const parksOf = (uid) => grants.filter((g) => g.user_id === uid)
    .map((g) => parks.find((p) => p.id === g.park_id)?.name)
    .filter(Boolean)

  const done = (m) => { setMsg(m); setDlg(null); load(); setTimeout(() => setMsg(''), 4000) }

  const act = async (body, okMsg) => {
    setErr(''); setMsg('')
    try {
      await callApi('admin-users', body)
      done(okMsg)
    } catch (ex) {
      setErr(ex.message)
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-h">
          <h3>用户与权限</h3>
          <button className="btn primary" onClick={() => setDlg({ type: 'new' })}>+ 新增用户</button>
        </div>

        {err ? <div className="card-b"><div className="err">{err}</div></div> : null}
        {msg ? <div className="card-b"><div className="ok-msg">{msg}</div></div> : null}

        <div className="tbl-wrap">
          {loading ? <div className="loading">加载中…</div> : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>姓名</th><th>邮箱</th><th>电话</th><th>角色</th>
                  <th>授权园区</th><th>状态</th><th style={{ width: 220 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === profile.id
                  const ps = parksOf(u.id)
                  return (
                    <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                      <td><strong>{u.full_name || '—'}</strong>{self ? <span className="hint"> （我）</span> : null}</td>
                      <td>{u.email}</td>
                      <td>{u.phone || '—'}</td>
                      <td><span className="tag">{ROLE_LABEL[u.role]}</span></td>
                      <td>
                        {u.role === 'super_admin'
                          ? <span className="hint">全部园区</span>
                          : ps.length ? ps.join('、') : <span className="hint" style={{ color: '#d63a3a' }}>未分配</span>}
                      </td>
                      <td>
                        <span className={`tag ${u.is_active ? 'paid' : 'voided'}`}>
                          {u.is_active ? '正常' : '已停用'}
                        </span>
                        {u.must_change_pwd ? <span className="tag unpaid">待改密</span> : null}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 5 }}>
                          <button className="btn sm" onClick={() => setDlg({ type: 'grant', user: u })}
                                  disabled={u.role === 'super_admin'}>园区</button>
                          <button className="btn sm" onClick={() => setDlg({ type: 'role', user: u })}
                                  disabled={self}>角色</button>
                          <button className="btn sm" onClick={() => setDlg({ type: 'pwd', user: u })}>密码</button>
                          {!self && (
                            <>
                              <button className="btn sm"
                                      onClick={() => act(
                                        { action: 'set_active', userId: u.id, isActive: !u.is_active },
                                        u.is_active ? '用户已停用' : '用户已启用')}>
                                {u.is_active ? '停用' : '启用'}
                              </button>
                              <button className="btn sm danger"
                                      onClick={() => setDlg({ type: 'del', user: u })}>删除</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card-b">
          <div className="hint">
            角色权限：物业经理拥有授权园区的全部业务权限；工程人员可抄表、查看房源；
            客服可录入房源与租约、确认收款。超级管理员不受园区限制。
          </div>
        </div>
      </div>

      {dlg?.type === 'new' && (
        <NewUser parks={parks} onClose={() => setDlg(null)}
                 onSubmit={(body) => act({ action: 'create', ...body }, '用户已创建')} />
      )}
      {dlg?.type === 'grant' && (
        <GrantParks user={dlg.user} parks={parks}
                    current={grants.filter((g) => g.user_id === dlg.user.id).map((g) => g.park_id)}
                    onClose={() => setDlg(null)} onDone={() => done('园区授权已更新')} />
      )}
      {dlg?.type === 'role' && (
        <ChangeRole user={dlg.user} onClose={() => setDlg(null)} onDone={() => done('角色已更新')} />
      )}
      {dlg?.type === 'pwd' && (
        <ResetPwd user={dlg.user} onClose={() => setDlg(null)}
                  onSubmit={(pw) => act(
                    { action: 'reset_password', userId: dlg.user.id, password: pw }, '密码已重置')} />
      )}
      {dlg?.type === 'del' && (
        <ConfirmDialog
          title="删除用户" danger onClose={() => setDlg(null)}
          onConfirm={() => act({ action: 'delete', userId: dlg.user.id }, '用户已删除')}
          message={
            <>
              确定删除用户 <strong>{dlg.user.full_name || dlg.user.email}</strong>？
              <div className="hint mt">
                登录账号与园区授权将一并移除，不可恢复。该用户此前的操作记录会保留在审计日志中。
                若只是暂时停止访问，用「停用」更合适。
              </div>
            </>
          }
        />
      )}
    </>
  )
}

function NewUser({ parks, onClose, onSubmit }) {
  const [f, setF] = useState({
    email: '', password: '', fullName: '', phone: '', role: 'cs', parkIds: [],
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = (id) => setF({
    ...f,
    parkIds: f.parkIds.includes(id) ? f.parkIds.filter((x) => x !== id) : [...f.parkIds, id],
  })

  const submit = async () => {
    setErr('')
    if (!f.email.trim()) return setErr('邮箱必填')
    if (f.password.length < 8) return setErr('初始密码至少 8 位')
    if (f.role !== 'super_admin' && !f.parkIds.length) return setErr('请至少分配一个园区')
    setBusy(true)
    try {
      await onSubmit({ ...f, email: f.email.trim() })
    } catch (ex) {
      setErr(ex.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="新增用户" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? '创建中…' : '创建用户'}
        </button>
      </>
    }>
      <div className="frow">
        <div>
          <label className="f">登录邮箱 *</label>
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
        <div>
          <label className="f">姓名</label>
          <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        </div>
      </div>

      <div className="frow mt">
        <div>
          <label className="f">初始密码 *</label>
          <input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <div className="hint">至少 8 位。用户首次登录会被要求修改</div>
        </div>
        <div>
          <label className="f">联系电话</label>
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <div>
          <label className="f">角色 *</label>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {f.role !== 'super_admin' && (
        <>
          <div className="sec-title">分配园区 *</div>
          <div className="row">
            {parks.map((p) => (
              <label key={p.id} className="row" style={{ gap: 6, fontSize: 14 }}>
                <input type="checkbox" style={{ width: 16 }} checked={f.parkIds.includes(p.id)}
                       onChange={() => toggle(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
          <div className="hint mt">用户只能看到并操作被授权园区的数据</div>
        </>
      )}

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function GrantParks({ user, parks, current, onClose, onDone }) {
  const [sel, setSel] = useState(current)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true); setErr('')
    // 全量替换该用户的授权
    const del = await sb().from('user_parks').delete().eq('user_id', user.id)
    if (del.error) { setErr(del.error.message); setBusy(false); return }
    if (sel.length) {
      const ins = await sb().from('user_parks').insert(
        sel.map((pid) => ({ user_id: user.id, park_id: pid }))
      )
      if (ins.error) { setErr(ins.error.message); setBusy(false); return }
    }
    setBusy(false)
    onDone()
  }

  return (
    <Modal title={`分配园区 · ${user.full_name || user.email}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </>
    }>
      {parks.length === 0 ? <div className="empty">尚未创建园区</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {parks.map((p) => (
            <label key={p.id} className="row" style={{ gap: 8, fontSize: 14.5 }}>
              <input type="checkbox" style={{ width: 16 }} checked={sel.includes(p.id)}
                     onChange={() => setSel(sel.includes(p.id)
                       ? sel.filter((x) => x !== p.id) : [...sel, p.id])} />
              {p.name} <span className="hint">{p.code}</span>
            </label>
          ))}
        </div>
      )}
      <div className="hint mt">可授予一个或多个园区。取消全部授权后该用户看不到任何业务数据。</div>
      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function ChangeRole({ user, onClose, onDone }) {
  const [role, setRole] = useState(user.role)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true); setErr('')
    const { error } = await sb().from('profiles').update({ role }).eq('id', user.id)
    setBusy(false)
    if (error) return setErr(error.message)
    onDone()
  }

  return (
    <Modal title={`修改角色 · ${user.full_name || user.email}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </>
    }>
      <div className="fgroup">
        <label className="f">角色</label>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="hint">
        物业经理：授权园区内全部业务权限<br />
        工程人员：抄表录入、房源查看<br />
        客服：房源与租约录入、确认收款<br />
        超级管理员：不受园区限制，可管理用户
      </div>
      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function ResetPwd({ user, onClose, onSubmit }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (pw.length < 8) return setErr('密码至少 8 位')
    setBusy(true)
    try {
      await onSubmit(pw)
    } catch (ex) {
      setErr(ex.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`重置密码 · ${user.full_name || user.email}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? '提交中…' : '重置密码'}
        </button>
      </>
    }>
      <div className="fgroup">
        <label className="f">新密码</label>
        <input value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="hint">请把新密码线下告知该用户，其下次登录会被要求再次修改</div>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}
