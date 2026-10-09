import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from '../components/Modal'
import { area, num } from '../lib/format'

const PARK_DRAFT_KEY = 'gip-new-park-draft'

function readParkDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(PARK_DRAFT_KEY) || 'null')
    return draft?.type === 'new' && draft.form ? draft.form : null
  } catch {
    return null
  }
}

function clearParkDraft() {
  try { sessionStorage.removeItem(PARK_DRAFT_KEY) } catch { /* storage may be unavailable */ }
}

function emptyParkForm() {
  return {
    code: '', name: '', city: '', address: '', land_area: '', gfa_above: '', gfa_below: '',
    parking_count: '', building_count: '', sort_order: 0, is_active: true, remark: '',
  }
}

export default function ParksPanel() {
  const { isSuper, reload } = useAuth()
  const [list, setList] = useState([])
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [dlg, setDlg] = useState(() => readParkDraft() ? { type: 'park', draft: true } : null)

  const load = async () => {
    setLoading(true)
    const [p, s] = await Promise.all([
      sb().from('parks').select('*').order('sort_order').order('code'),
      sb().from('park_settings').select('*'),
    ])
    if (p.error) setErr(p.error.message)
    setList(p.data || [])
    const o = {}
    for (const x of s.data || []) o[x.park_id] = x
    setSettings(o)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const done = (m) => {
    clearParkDraft()
    setMsg(m); setDlg(null); load(); reload()
    setTimeout(() => setMsg(''), 4000)
  }

  const openNewPark = () => {
    try {
      if (!readParkDraft()) sessionStorage.setItem(PARK_DRAFT_KEY, JSON.stringify({ type: 'new', form: {} }))
    } catch { /* keep the form usable when browser storage is unavailable */ }
    setDlg({ type: 'park', draft: true })
  }

  const closeParkDialog = () => {
    if (!dlg?.row) clearParkDraft()
    setDlg(null)
  }

  return (
    <>
      <div className="card">
        <div className="card-h">
          <h3>园区与参数</h3>
          {isSuper && (
            <button className="btn primary" onClick={openNewPark}>+ 新增园区</button>
          )}
        </div>

        {err ? <div className="card-b"><div className="err">{err}</div></div> : null}
        {msg ? <div className="card-b"><div className="ok-msg">{msg}</div></div> : null}

        {loading ? <div className="loading">加载中…</div> : list.length === 0 ? (
          <div className="empty">尚未创建园区</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>代码</th><th>名称</th><th>城市</th>
                  <th className="num">占地 ㎡</th><th className="num">地上 ㎡</th><th className="num">地下 ㎡</th>
                  <th className="num">车位</th><th className="num">水价</th><th className="num">电价</th>
                  <th>损耗分摊</th><th style={{ width: 140 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const s = settings[p.id] || {}
                  return (
                    <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.55 }}>
                      <td><strong>{p.code}</strong></td>
                      <td>{p.name}</td>
                      <td>{p.city || '—'}</td>
                      <td className="num">{area(p.land_area)}</td>
                      <td className="num">{area(p.gfa_above)}</td>
                      <td className="num">{area(p.gfa_below)}</td>
                      <td className="num">{num(p.parking_count)}</td>
                      <td className="num">{Number(s.water_price || 0).toFixed(2)}</td>
                      <td className="num">{Number(s.electricity_price || 0).toFixed(2)}</td>
                      <td>{lossLabel(s)}</td>
                      <td>
                        <div className="row" style={{ gap: 5 }}>
                          <button className="btn sm" onClick={() => setDlg({ type: 'park', row: p })}>资料</button>
                          <button className="btn sm" onClick={() => setDlg({ type: 'set', row: p, s })}>参数</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dlg?.type === 'park' && (
        <ParkDialog row={dlg.row} isSuper={isSuper} onClose={closeParkDialog}
                    onDone={() => done('园区资料已保存')} />
      )}
      {dlg?.type === 'set' && (
        <SettingsDialog park={dlg.row} s={dlg.s} onClose={() => setDlg(null)}
                        onDone={() => done('园区参数已保存')} />
      )}
    </>
  )
}

function lossLabel(s) {
  const w = { none: '不分摊', by_area: '按面积', by_usage: '按用量' }
  return (
    <span className="hint">
      水 {w[s.water_loss_method] || '—'} · 电 {w[s.elec_loss_method] || '—'}
    </span>
  )
}

function ParkDialog({ row, isSuper, onClose, onDone }) {
  const editing = !!row
  const [f, setF] = useState(() => ({
    code: row?.code || '', name: row?.name || '', city: row?.city || '',
    address: row?.address || '',
    land_area: row?.land_area ?? '', gfa_above: row?.gfa_above ?? '', gfa_below: row?.gfa_below ?? '',
    parking_count: row?.parking_count ?? '', building_count: row?.building_count ?? '',
    sort_order: row?.sort_order ?? 0, is_active: row?.is_active ?? true, remark: row?.remark || '',
    ...(!row ? (readParkDraft() || {}) : {}),
  }))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const updateField = (key, value) => {
    const next = { ...f, [key]: value }
    setF(next)
    if (!editing) {
      try { sessionStorage.setItem(PARK_DRAFT_KEY, JSON.stringify({ type: 'new', form: next })) }
      catch { /* keep editing even when browser storage is unavailable */ }
    }
  }

  const save = async () => {
    setErr('')
    if (!f.code.trim()) return setErr('园区代码必填')
    if (!f.name.trim()) return setErr('园区名称必填')

    const payload = {
      code: f.code.trim(), name: f.name.trim(),
      city: f.city || null, address: f.address || null,
      land_area: Number(f.land_area) || 0,
      gfa_above: Number(f.gfa_above) || 0,
      gfa_below: Number(f.gfa_below) || 0,
      parking_count: Number(f.parking_count) || 0,
      building_count: Number(f.building_count) || 0,
      sort_order: Number(f.sort_order) || 0,
      is_active: !!f.is_active,
      remark: f.remark || null,
    }

    setBusy(true)
    const { error } = editing
      ? await sb().from('parks').update(payload).eq('id', row.id)
      : await sb().from('parks').insert(payload)
    setBusy(false)
    if (error) return setErr(error.message)
    if (!editing) clearParkDraft()
    onDone()
  }

  return (
    <Modal title={editing ? `编辑园区 ${row.name}` : '新增园区'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </>
    }>
      <div className="frow">
        <div>
          <label className="f">园区代码 *</label>
          <input value={f.code} onChange={(e) => updateField('code', e.target.value)}
                 placeholder="GC01" disabled={editing && !isSuper} />
        </div>
        <div>
          <label className="f">园区名称 *</label>
          <input value={f.name} onChange={(e) => updateField('name', e.target.value)}
                 placeholder="谷川科技园一期" />
        </div>
        <div>
          <label className="f">城市</label>
          <input value={f.city} onChange={(e) => updateField('city', e.target.value)} />
        </div>
      </div>

      <div className="fgroup mt">
        <label className="f">详细地址</label>
        <input value={f.address} onChange={(e) => updateField('address', e.target.value)} />
      </div>

      <div className="frow">
        <div>
          <label className="f">占地面积 ㎡</label>
          <input type="number" step="0.01" value={f.land_area}
                 onChange={(e) => updateField('land_area', e.target.value)} />
        </div>
        <div>
          <label className="f">地上建筑面积 ㎡</label>
          <input type="number" step="0.01" value={f.gfa_above}
                 onChange={(e) => updateField('gfa_above', e.target.value)} />
        </div>
        <div>
          <label className="f">地下建筑面积 ㎡</label>
          <input type="number" step="0.01" value={f.gfa_below}
                 onChange={(e) => updateField('gfa_below', e.target.value)} />
        </div>
      </div>

      <div className="frow mt">
        <div>
          <label className="f">车位数</label>
          <input type="number" value={f.parking_count}
                 onChange={(e) => updateField('parking_count', e.target.value)} />
        </div>
        <div>
          <label className="f">规划栋数</label>
          <input type="number" value={f.building_count}
                 onChange={(e) => updateField('building_count', e.target.value)} />
          <div className="hint">概览优先显示已录入楼栋数</div>
        </div>
        <div>
          <label className="f">排序</label>
          <input type="number" value={f.sort_order}
                 onChange={(e) => updateField('sort_order', e.target.value)} />
        </div>
      </div>

      <div className="row mt">
        <label className="row" style={{ gap: 6, fontSize: 13.5 }}>
          <input type="checkbox" style={{ width: 16 }} checked={f.is_active}
                 onChange={(e) => updateField('is_active', e.target.checked)} />
          启用（停用后不在概览中显示）
        </label>
      </div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

// 园区参数：水电单价、损耗分摊、逾期规则
function SettingsDialog({ park, s, onClose, onDone }) {
  const [f, setF] = useState({
    water_price: s?.water_price ?? 0,
    electricity_price: s?.electricity_price ?? 0,
    water_loss_method: s?.water_loss_method || 'none',
    water_loss_ratio: ((s?.water_loss_ratio ?? 0) * 100).toFixed(2),
    elec_loss_method: s?.elec_loss_method || 'none',
    elec_loss_ratio: ((s?.elec_loss_ratio ?? 0) * 100).toFixed(2),
    utility_due_days: s?.utility_due_days ?? 15,
    overdue_alert_days: s?.overdue_alert_days ?? 7,
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true); setErr('')
    const { error } = await sb().from('park_settings').upsert({
      park_id: park.id,
      water_price: Number(f.water_price) || 0,
      electricity_price: Number(f.electricity_price) || 0,
      water_loss_method: f.water_loss_method,
      water_loss_ratio: (Number(f.water_loss_ratio) || 0) / 100,
      elec_loss_method: f.elec_loss_method,
      elec_loss_ratio: (Number(f.elec_loss_ratio) || 0) / 100,
      utility_due_days: Number(f.utility_due_days) || 15,
      overdue_alert_days: Number(f.overdue_alert_days) || 7,
    })
    setBusy(false)
    if (error) return setErr(error.message)
    onDone()
  }

  return (
    <Modal title={`园区参数 · ${park.name}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </>
    }>
      <div className="sec-title">水电单价（租约可单独覆盖）</div>
      <div className="frow">
        <div>
          <label className="f">水费单价 元/吨</label>
          <input type="number" step="0.0001" value={f.water_price}
                 onChange={(e) => setF({ ...f, water_price: e.target.value })} />
        </div>
        <div>
          <label className="f">电费单价 元/度</label>
          <input type="number" step="0.0001" value={f.electricity_price}
                 onChange={(e) => setF({ ...f, electricity_price: e.target.value })} />
        </div>
      </div>

      <div className="sec-title">损耗分摊</div>
      <div className="frow">
        <div>
          <label className="f">水损耗分摊方式</label>
          <select value={f.water_loss_method}
                  onChange={(e) => setF({ ...f, water_loss_method: e.target.value })}>
            <option value="none">不分摊</option>
            <option value="by_area">按建筑面积比例</option>
            <option value="by_usage">按各租户用量比例</option>
          </select>
        </div>
        <div>
          <label className="f">水固定损耗比例 %</label>
          <input type="number" step="0.01" value={f.water_loss_ratio}
                 disabled={f.water_loss_method === 'none'}
                 onChange={(e) => setF({ ...f, water_loss_ratio: e.target.value })} />
        </div>
      </div>

      <div className="frow mt">
        <div>
          <label className="f">电损耗分摊方式</label>
          <select value={f.elec_loss_method}
                  onChange={(e) => setF({ ...f, elec_loss_method: e.target.value })}>
            <option value="none">不分摊</option>
            <option value="by_area">按建筑面积比例</option>
            <option value="by_usage">按各租户用量比例</option>
          </select>
        </div>
        <div>
          <label className="f">电固定损耗比例 %</label>
          <input type="number" step="0.01" value={f.elec_loss_ratio}
                 disabled={f.elec_loss_method === 'none'}
                 onChange={(e) => setF({ ...f, elec_loss_ratio: e.target.value })} />
        </div>
      </div>

      <div className="hint">
        装了总表时，损耗量 = 总表用量 − 各租户用量之和，比例设置不生效；
        没装总表则按上面的固定比例估算，再加上公共区域表的用量，一并分摊到各租户账单。
      </div>

      <div className="sec-title">账期与预警</div>
      <div className="frow">
        <div>
          <label className="f">水电账单应交天数</label>
          <input type="number" value={f.utility_due_days}
                 onChange={(e) => setF({ ...f, utility_due_days: e.target.value })} />
          <div className="hint">抄表日 + N 天为应交日期</div>
        </div>
        <div>
          <label className="f">警示红阈值（天）</label>
          <input type="number" value={f.overdue_alert_days}
                 onChange={(e) => setF({ ...f, overdue_alert_days: e.target.value })} />
          <div className="hint">逾期超过该天数，租约卡片闪烁警示</div>
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}
