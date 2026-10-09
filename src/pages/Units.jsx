import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { ParkPicker } from '../components/Layout'
import Modal, { ConfirmDialog } from '../components/Modal'
import { area, STATUS_LABEL, PURPOSE_LABEL, floorLabel } from '../lib/format'

export default function Units() {
  const { parks, can } = useAuth()
  const [parkId, setParkId] = useState('')
  const [rows, setRows] = useState([])
  const [buildings, setBuildings] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [sel, setSel] = useState([])
  const [filter, setFilter] = useState({ building: '', status: '', kw: '' })
  const [dlg, setDlg] = useState(null) // {type, payload}

  useEffect(() => {
    if (!parkId && parks.length) setParkId(parks[0].id)
  }, [parks, parkId])

  const load = useCallback(async () => {
    if (!parkId) return
    setLoading(true)
    setErr('')
    try {
      const [u, b] = await Promise.all([
        sb().from('v_unit_status').select('*').eq('park_id', parkId)
          .order('building_code').order('floor').order('unit_no'),
        sb().from('buildings').select('*').eq('park_id', parkId).order('sort_order').order('code'),
      ])
      if (u.error) throw new Error(u.error.message)
      if (b.error) throw new Error(b.error.message)
      setRows(u.data || [])
      setBuildings(b.data || [])
      setSel([])
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setLoading(false)
    }
  }, [parkId])

  useEffect(() => { load() }, [load])

  const shown = useMemo(() => rows.filter((r) => {
    if (filter.building && r.building_id !== filter.building) return false
    if (filter.status && r.display_status !== filter.status) return false
    if (filter.kw) {
      const k = filter.kw.toLowerCase()
      if (!`${r.unit_no} ${r.party_name || ''}`.toLowerCase().includes(k)) return false
    }
    return true
  }), [rows, filter])

  const selRows = rows.filter((r) => sel.includes(r.id))
  const done = (m) => { setMsg(m); setDlg(null); load(); setTimeout(() => setMsg(''), 4000) }

  return (
    <>
      <div className="card mb">
        <div className="card-b">
          <div className="row">
            <ParkPicker value={parkId} onChange={setParkId} />
            <div style={{ minWidth: 130 }}>
              <label className="f">栋号</label>
              <select value={filter.building} onChange={(e) => setFilter({ ...filter, building: e.target.value })}>
                <option value="">全部</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.code} 栋</option>)}
              </select>
            </div>
            <div style={{ minWidth: 130 }}>
              <label className="f">状态</label>
              <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                <option value="">全部</option>
                {['vacant', 'leased', 'fitout', 'overdue', 'sold', 'sold_overdue', 'reserved', 'voided']
                  .map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 150, flex: 1 }}>
              <label className="f">搜索房号 / 租户</label>
              <input value={filter.kw} onChange={(e) => setFilter({ ...filter, kw: e.target.value })}
                     placeholder="A10305 或 某某公司" />
            </div>
          </div>

          <div className="row mt">
            {can.editUnit && (
              <>
                <button className="btn primary" onClick={() => setDlg({ type: 'unit' })}
                        disabled={!buildings.length}>+ 新增房源</button>
                <button className="btn" onClick={() => setDlg({ type: 'building' })}
                        disabled={!parkId || loading}>+ 新增楼栋</button>
              </>
            )}
            {can.mergeSplit && (
              <>
                <button className="btn" disabled={sel.length < 2}
                        onClick={() => setDlg({ type: 'merge' })}>合并（已选 {sel.length}）</button>
                <button className="btn" disabled={sel.length !== 1}
                        onClick={() => setDlg({ type: 'split', payload: selRows[0] })}>拆分</button>
              </>
            )}
            <div className="spacer" />
            <span className="hint">共 {shown.length} 间</span>
          </div>

          <div className="legend-inline mt">
            {[['vacant', '#c8d0dd'], ['leased', '#15925f'], ['fitout', '#d98212'],
              ['overdue', '#d63a3a'], ['sold', '#7a5cc4']].map(([k, c]) => (
              <span key={k}><i style={{ background: c }} />{STATUS_LABEL[k]}</span>
            ))}
          </div>
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
      {msg ? <div className="ok-msg">{msg}</div> : null}

      <div className="card">
        <div className="tbl-wrap">
          {loading ? <div className="loading">加载中…</div> : (
            <UnitTable rows={shown} sel={sel} setSel={setSel} canSelect={can.mergeSplit}
                       canEdit={can.editUnit} onEdit={(r) => setDlg({ type: 'unit', payload: r })}
                       onDelete={(r) => setDlg({ type: 'del', payload: r })} />
          )}
        </div>
      </div>

      {dlg?.type === 'building' && (
        <BuildingDialog parkId={parkId} buildings={buildings} onRefresh={load}
                        onClose={() => setDlg(null)} onDone={() => done('楼栋已保存')} />
      )}
      {dlg?.type === 'unit' && (
        <UnitDialog parkId={parkId} buildings={buildings} row={dlg.payload}
                    onClose={() => setDlg(null)} onDone={() => done('房源已保存')} />
      )}
      {dlg?.type === 'merge' && (
        <MergeDialog rows={selRows} onClose={() => setDlg(null)} onDone={(no) => done(`合并完成，新房号 ${no}`)} />
      )}
      {dlg?.type === 'split' && (
        <SplitDialog row={dlg.payload} onClose={() => setDlg(null)} onDone={(n) => done(`拆分完成，生成 ${n} 间`)} />
      )}
      {dlg?.type === 'del' && (
        <DeleteUnit row={dlg.payload} onClose={() => setDlg(null)} onDone={() => done('房源已删除')} />
      )}
    </>
  )
}

function UnitTable({ rows, sel, setSel, canSelect, canEdit, onEdit, onDelete }) {
  if (!rows.length) return <div className="empty">没有符合条件的房源</div>

  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])

  return (
    <table className="tbl">
      <thead>
        <tr>
          {canSelect ? <th style={{ width: 34 }} /> : null}
          <th>栋号</th><th>层</th><th>房号</th>
          <th className="num">建筑面积</th><th className="num">使用面积</th><th className="num">公摊面积</th>
          <th>属性</th><th>状态</th><th>租户 / 业主</th><th>逾期</th>
          {canEdit ? <th style={{ width: 100 }}>操作</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={`st-${r.display_status}${sel.includes(r.id) ? ' sel' : ''}`}>
            {canSelect ? (
              <td>
                <input type="checkbox" style={{ width: 16 }} checked={sel.includes(r.id)}
                       disabled={r.display_status === 'voided'}
                       onChange={() => toggle(r.id)} aria-label={`选择 ${r.unit_no}`} />
              </td>
            ) : null}
            <td>{r.building_code}</td>
            <td>{floorLabel(r.floor)}</td>
            <td><strong>{r.unit_no}</strong></td>
            <td className="num">{area(r.area)}</td>
            <td className="num">{area(r.usable_area)}</td>
            <td className="num">{area(r.shared_area)}</td>
            <td><span className="hint">{PURPOSE_LABEL[r.purpose]}</span></td>
            <td><span className={`tag ${r.display_status}`}>{STATUS_LABEL[r.display_status]}</span></td>
            <td>{r.party_name || '—'}</td>
            <td>
              {r.max_overdue_days > 0
                ? <span style={{ color: '#d63a3a', fontWeight: 600 }}>{r.max_overdue_days} 天</span>
                : '—'}
            </td>
            {canEdit ? (
              <td>
                <div className="row" style={{ gap: 5 }}>
                  <button className="btn sm" onClick={() => onEdit(r)}>编辑</button>
                  {r.display_status === 'vacant' && (
                    <button className="btn sm danger" onClick={() => onDelete(r)}>删除</button>
                  )}
                </div>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BuildingDialog({ parkId, buildings, onRefresh, onClose, onDone }) {
  const [f, setF] = useState({ code: '', name: '', floors_above: 1, floors_below: 0, gfa: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)

  const duplicateMessage = (code) => `该园区已存在“${code}”栋，不能重复新增。若要为该楼栋添加房源，请关闭此窗口，在“新增房源”中选择“${code}”栋；若是另一栋楼，请使用不同栋号。`

  const save = async () => {
    if (submitting.current) return
    const code = f.code.trim()
    if (!parkId) return setErr('请先选择园区')
    if (!code) return setErr('栋号必填')
    if (buildings.some((b) => b.code === code)) return setErr(duplicateMessage(code))
    submitting.current = true
    setBusy(true); setErr('')
    try {
      const { error } = await sb().from('buildings').insert({
        park_id: parkId,
        code,
        name: f.name.trim() || null,
        floors_above: Number(f.floors_above) || 1,
        floors_below: Number(f.floors_below) || 0,
        gfa: Number(f.gfa) || 0,
      })
      if (error?.code === '23505') {
        setErr(duplicateMessage(code))
        await onRefresh()
        return
      }
      if (error) throw new Error(error.message)
      onDone()
    } catch (ex) {
      setErr(`新增楼栋失败：${ex.message}`)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Modal title="新增楼栋" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </>
    }>
      <div className="frow">
        <div>
          <label className="f" htmlFor="building-code">栋号 *</label>
          <input id="building-code" value={f.code} onChange={(e) => {
            setF({ ...f, code: e.target.value }); setErr('')
          }} placeholder="A1" />
          <div className="hint">房号将以此为前缀，如 A1 + 03层 + 05号 = A10305</div>
        </div>
        <div>
          <label className="f">名称</label>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="研发楼" />
        </div>
      </div>
      <div className="frow mt">
        <div>
          <label className="f">地上层数</label>
          <input type="number" min="1" value={f.floors_above}
                 onChange={(e) => setF({ ...f, floors_above: e.target.value })} />
        </div>
        <div>
          <label className="f">地下层数</label>
          <input type="number" min="0" value={f.floors_below}
                 onChange={(e) => setF({ ...f, floors_below: e.target.value })} />
        </div>
        <div>
          <label className="f">本栋建筑面积 ㎡</label>
          <input type="number" step="0.01" value={f.gfa}
                 onChange={(e) => setF({ ...f, gfa: e.target.value })} />
        </div>
      </div>
      {buildings.length > 0 && (
        <div className="hint mt">该园区已有楼栋：{buildings.map((b) => b.name ? `${b.code}（${b.name}）` : b.code).join('、')}。栋号不能重复。</div>
      )}
      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function UnitDialog({ parkId, buildings, row, onClose, onDone }) {
  const editing = !!row
  const [f, setF] = useState({
    building_id: row?.building_id || buildings[0]?.id || '',
    floor: row?.floor ?? 1,
    usable_area: row?.usable_area ?? '',
    shared_area: row?.shared_area ?? '',
    purpose: row?.purpose || 'rent_or_sale',
    status: row?.status || 'vacant',
    remark: row?.remark || '',
  })
  const [preview, setPreview] = useState(row?.unit_no || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // 新增时预览系统将生成的房号
  useEffect(() => {
    if (editing || !f.building_id) return
    let alive = true
    sb().rpc('next_unit_no', { p_building: f.building_id, p_floor: Number(f.floor) || 1 })
      .then(({ data }) => {
        if (alive) setPreview(Array.isArray(data) ? data[0]?.unit_no || '' : data?.unit_no || '')
      })
    return () => { alive = false }
  }, [editing, f.building_id, f.floor])

  const save = async () => {
    setErr('')
    if (!f.building_id) return setErr('请选择楼栋')
    const ua = Number(f.usable_area) || 0
    const sa = Number(f.shared_area) || 0
    if (ua <= 0) return setErr('使用面积必须大于 0')

    setBusy(true)
    try {
      if (editing) {
        const { error } = await sb().from('units').update({
          usable_area: ua, shared_area: sa, purpose: f.purpose,
          status: f.status, remark: f.remark || null,
        }).eq('id', row.id)
        if (error) throw new Error(error.message)
      } else {
        const { data: nn, error: nErr } = await sb().rpc('next_unit_no', {
          p_building: f.building_id, p_floor: Number(f.floor) || 1,
        })
        if (nErr) throw new Error(nErr.message)
        const gen = Array.isArray(nn) ? nn[0] : nn
        const { error } = await sb().from('units').insert({
          park_id: parkId, building_id: f.building_id,
          unit_no: gen.unit_no, floor: Number(f.floor) || 1, seq: gen.seq,
          usable_area: ua, shared_area: sa, purpose: f.purpose,
          status: f.status, remark: f.remark || null,
        })
        if (error) throw new Error(error.message)
      }
      onDone()
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  const total = (Number(f.usable_area) || 0) + (Number(f.shared_area) || 0)

  return (
    <Modal title={editing ? `编辑房源 ${row.unit_no}` : '新增房源'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </>
    }>
      <div className="frow">
        <div>
          <label className="f">楼栋 *</label>
          <select value={f.building_id} disabled={editing}
                  onChange={(e) => setF({ ...f, building_id: e.target.value })}>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.code} 栋</option>)}
          </select>
        </div>
        <div>
          <label className="f">层 *</label>
          <input type="number" value={f.floor} disabled={editing}
                 onChange={(e) => setF({ ...f, floor: e.target.value })} />
          <div className="hint">地下层填负数，如 -1</div>
        </div>
        <div>
          <label className="f">房号</label>
          <input value={preview} readOnly />
          <div className="hint">{editing ? '房号不可修改' : '由系统按编号规则生成'}</div>
        </div>
      </div>

      <div className="frow mt">
        <div>
          <label className="f">使用面积 ㎡ *</label>
          <input type="number" step="0.01" value={f.usable_area}
                 onChange={(e) => setF({ ...f, usable_area: e.target.value })} />
        </div>
        <div>
          <label className="f">公摊面积 ㎡</label>
          <input type="number" step="0.01" value={f.shared_area}
                 onChange={(e) => setF({ ...f, shared_area: e.target.value })} />
        </div>
        <div>
          <label className="f">建筑面积 ㎡</label>
          <input value={area(total)} readOnly />
          <div className="hint">使用 + 公摊，自动计算</div>
        </div>
      </div>

      <div className="frow mt">
        <div>
          <label className="f">经营属性</label>
          <select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
            {Object.entries(PURPOSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <div className="hint">决定是否计入出租率 / 销售率</div>
        </div>
        <div>
          <label className="f">状态</label>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="vacant">空置</option>
            <option value="reserved">预留</option>
            <option value="leased">已租</option>
            <option value="sold">已售</option>
          </select>
          <div className="hint">签订租约后自动变更，一般无需手改</div>
        </div>
      </div>

      <div className="fgroup mt">
        <label className="f">备注</label>
        <input value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
      </div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function Cell({ k, v }) {
  return <div><div className="k">{k}</div><div className="v">{v}</div></div>
}

function MergeDialog({ rows, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const sameFloor = new Set(rows.map((r) => `${r.building_id}#${r.floor}`)).size === 1
  const notVacant = rows.filter((r) => r.display_status !== 'vacant')
  const ua = rows.reduce((s, r) => s + Number(r.usable_area || 0), 0)
  const sa = rows.reduce((s, r) => s + Number(r.shared_area || 0), 0)
  const blocked = !sameFloor || notVacant.length > 0

  const run = async () => {
    setBusy(true); setErr('')
    const { data, error } = await sb().rpc('merge_units', {
      p_unit_ids: rows.map((r) => r.id),
      p_purpose: null,
      p_reason: reason || null,
    })
    setBusy(false)
    if (error) return setErr(error.message)
    const { data: nu } = await sb().from('units').select('unit_no').eq('id', data).single()
    onDone(nu?.unit_no || '')
  }

  return (
    <Modal title={`合并 ${rows.length} 间房源`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={run} disabled={busy || blocked}>
          {busy ? '处理中…' : '确认合并'}
        </button>
      </>
    }>
      <div className="tbl-wrap mb">
        <table className="tbl">
          <thead>
            <tr><th>栋号</th><th>层</th><th>房号</th><th className="num">使用</th>
                <th className="num">公摊</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.building_code}</td><td>{floorLabel(r.floor)}</td><td>{r.unit_no}</td>
                <td className="num">{area(r.usable_area)}</td>
                <td className="num">{area(r.shared_area)}</td>
                <td><span className={`tag ${r.display_status}`}>{STATUS_LABEL[r.display_status]}</span></td>
              </tr>
            ))}
            <tr style={{ fontWeight: 600, background: '#f8fafc' }}>
              <td colSpan={3}>合并后</td>
              <td className="num">{area(ua)}</td>
              <td className="num">{area(sa)}</td>
              <td>建筑 {area(ua + sa)} ㎡</td>
            </tr>
          </tbody>
        </table>
      </div>

      {!sameFloor && <div className="err">只能合并同一栋、同一层的房源</div>}
      {notVacant.length > 0 && (
        <div className="err">
          以下房源不是空置状态，无法合并：{notVacant.map((r) => r.unit_no).join('、')}
        </div>
      )}

      <div className="fgroup">
        <label className="f">合并原因</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：整层出租给某公司" />
      </div>

      <div className="hint">
        合并后原房号全部注销且不再复用，系统按「栋号 + 层 + 序号」生成新房号。操作留有台账可追溯。
      </div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function SplitDialog({ row, onClose, onDone }) {
  const [kids, setKids] = useState([
    { usable_area: '', shared_area: '', purpose: row.purpose },
    { usable_area: '', shared_area: '', purpose: row.purpose },
  ])
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const su = kids.reduce((s, k) => s + (Number(k.usable_area) || 0), 0)
  const ss = kids.reduce((s, k) => s + (Number(k.shared_area) || 0), 0)
  const du = su - Number(row.usable_area || 0)
  const ds = ss - Number(row.shared_area || 0)
  const okArea = Math.abs(du) <= 0.01 && Math.abs(ds) <= 0.01

  const setKid = (i, patch) => setKids(kids.map((k, j) => (j === i ? { ...k, ...patch } : k)))

  // 剩余面积一键补给最后一间，避免手工凑数
  const fillLast = () => {
    const head = kids.slice(0, -1)
    const hu = head.reduce((s, k) => s + (Number(k.usable_area) || 0), 0)
    const hs = head.reduce((s, k) => s + (Number(k.shared_area) || 0), 0)
    setKids([...head, {
      ...kids[kids.length - 1],
      usable_area: Math.max(0, Number(row.usable_area) - hu).toFixed(2),
      shared_area: Math.max(0, Number(row.shared_area) - hs).toFixed(2),
    }])
  }

  const run = async () => {
    setBusy(true); setErr('')
    const { data, error } = await sb().rpc('split_unit', {
      p_unit_id: row.id,
      p_children: kids.map((k) => ({
        usable_area: Number(k.usable_area) || 0,
        shared_area: Number(k.shared_area) || 0,
        purpose: k.purpose,
      })),
      p_reason: reason || null,
    })
    setBusy(false)
    if (error) return setErr(error.message)
    onDone((data || []).length)
  }

  return (
    <Modal title={`拆分房源 ${row.unit_no}`} wide onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={run} disabled={busy || !okArea}>
          {busy ? '处理中…' : '确认拆分'}
        </button>
      </>
    }>
      <div className="kv mb">
        <Cell k="拆分前使用面积" v={`${area(row.usable_area)} ㎡`} />
        <Cell k="拆分前公摊面积" v={`${area(row.shared_area)} ㎡`} />
        <Cell k="拆分前建筑面积" v={`${area(row.area)} ㎡`} />
      </div>

      {kids.map((k, i) => (
        <div className="frow mb" key={i} style={{ alignItems: 'end' }}>
          <div style={{ flex: '0 0 66px', minWidth: 66 }}>
            <label className="f">子房源</label>
            <input value={`第 ${i + 1} 间`} readOnly />
          </div>
          <div>
            <label className="f">使用面积 ㎡</label>
            <input type="number" step="0.01" value={k.usable_area}
                   onChange={(e) => setKid(i, { usable_area: e.target.value })} />
          </div>
          <div>
            <label className="f">公摊面积 ㎡</label>
            <input type="number" step="0.01" value={k.shared_area}
                   onChange={(e) => setKid(i, { shared_area: e.target.value })} />
          </div>
          <div>
            <label className="f">属性</label>
            <select value={k.purpose} onChange={(e) => setKid(i, { purpose: e.target.value })}>
              {Object.entries(PURPOSE_LABEL).map(([kk, v]) => <option key={kk} value={kk}>{v}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 66px' }}>
            {kids.length > 2 && (
              <button className="btn sm danger" onClick={() => setKids(kids.filter((_, j) => j !== i))}>
                移除
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="row mb">
        <button className="btn sm"
                onClick={() => setKids([...kids, { usable_area: '', shared_area: '', purpose: row.purpose }])}>
          + 增加一间
        </button>
        <button className="btn sm" onClick={fillLast}>剩余面积补到最后一间</button>
      </div>

      <div className={okArea ? 'ok-msg' : 'err'}>
        子房源汇总：使用 {area(su)} ㎡（差 {du >= 0 ? '+' : ''}{area(du)}）、
        公摊 {area(ss)} ㎡（差 {ds >= 0 ? '+' : ''}{area(ds)}）
        {okArea ? ' — 校验通过' : ' — 必须与拆分前一致（容差 0.01㎡）'}
      </div>

      <div className="fgroup mt">
        <label className="f">拆分原因</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：大间分租给两家企业" />
      </div>

      <div className="hint">拆分后原房号注销，各子房源按编号规则重新生成房号。</div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function DeleteUnit({ row, onClose, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async () => {
    setBusy(true); setErr('')
    const { error } = await sb().from('units').delete().eq('id', row.id)
    setBusy(false)
    if (error) return setErr(`删除失败：${error.message}`)
    onDone()
  }

  return (
    <ConfirmDialog
      title="删除房源" danger busy={busy} onClose={onClose} onConfirm={run}
      message={
        <>
          确定删除房源 <strong>{row.unit_no}</strong>（{area(row.area)} ㎡）？
          <div className="hint mt">
            删除后不可恢复。若该房源已有租约或抄表记录，数据库会拒绝删除，
            这种情况请改用合并或拆分以保留台账。
          </div>
          {err ? <div className="err">{err}</div> : null}
        </>
      }
    />
  )
}
