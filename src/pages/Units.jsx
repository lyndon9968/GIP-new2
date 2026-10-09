import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useManualRefresh } from '../lib/PageCache'
import { useAuth } from '../lib/AuthContext'
import { ParkPicker } from '../components/Layout'
import Modal, { ConfirmDialog } from '../components/Modal'
import { area, STATUS_LABEL, PURPOSE_LABEL, floorLabel, unitLocations,
  unitBuildingLabel, unitFloorLabel, unitLocationLabel, unitInBuilding } from '../lib/format'

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
  const requestId = useRef(0)

  useEffect(() => {
    if (!parkId && parks.length) setParkId(parks[0].id)
  }, [parks, parkId])

  const load = useCallback(async () => {
    if (!parkId) return
    const request = ++requestId.current
    setLoading(true)
    setErr('')
    try {
      const [u, b] = await Promise.all([
        sb().from('v_unit_status').select('*').eq('park_id', parkId)
          .order('building_code').order('floor').order('unit_no'),
        sb().from('buildings').select('*').eq('park_id', parkId).order('sort_order').order('code'),
      ])
      if (request !== requestId.current) return
      if (u.error) throw new Error(u.error.message)
      if (b.error) throw new Error(b.error.message)
      setRows(u.data || [])
      setBuildings(b.data || [])
      setSel([])
    } catch (ex) {
      if (request === requestId.current) setErr(ex.message)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [parkId])

  useEffect(() => { load(); return () => { ++requestId.current } }, [load])
  useManualRefresh(load, loading)

  const shown = useMemo(() => rows.filter((r) => {
    if (r.status === 'voided' && filter.status !== 'voided') return false
    if (filter.building && !unitInBuilding(r, filter.building)) return false
    if (filter.status && r.display_status !== filter.status) return false
    if (filter.kw) {
      const k = filter.kw.toLowerCase()
      if (!`${r.unit_no} ${r.party_name || ''} ${unitLocationLabel(r)}`.toLowerCase().includes(k)) return false
    }
    return true
  }), [rows, filter])

  const selRows = [...new Map(rows.filter((r) => sel.includes(r.id)).map((r) => [r.id, r])).values()]
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
          {canEdit ? <th style={{ minWidth: 140 }}>操作</th> : null}
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
            <td>{unitBuildingLabel(r)}</td>
            <td>{unitFloorLabel(r)}</td>
            <td><strong>{r.unit_no}</strong>{unitLocations(r).length > 1 && <div className="hint">{unitLocationLabel(r)}</div>}</td>
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
                  <button className="btn sm danger" onClick={() => onDelete(r)}
                          aria-label={`删除房源 ${r.unit_no}`}>删除</button>
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
  const originalLocations = row ? unitLocations(row) : []
  const composite = new Set(originalLocations.map((x) => x.building_id)).size > 1
  const originalBuilding = buildings.find((b) => b.id === row?.building_id)
  const originalWholeFloors = [
    ...Array.from({ length: Math.max(0, Number(originalBuilding?.floors_below) || 0) }, (_, i) => -i - 1),
    ...Array.from({ length: Math.max(1, Number(originalBuilding?.floors_above) || 1) }, (_, i) => i + 1),
  ]
  const isWhole = !composite && originalLocations.length > 1
    && originalLocations.length === originalWholeFloors.length
    && originalWholeFloors.every((floor) => originalLocations.some((x) => Number(x.floor) === floor))
  const [f, setF] = useState({
    building_id: row?.building_id || buildings[0]?.id || '',
    floor: row?.floor ?? 1,
    scope: composite ? 'composite' : isWhole ? 'whole' : originalLocations.length > 1 ? 'multi' : 'single',
    floors: originalLocations.map((x) => Number(x.floor)),
    usable_area: row?.usable_area ?? '',
    shared_area: row?.shared_area ?? '',
    purpose: row?.purpose || 'rent_or_sale',
    status: row?.status || 'vacant',
    remark: row?.remark || '',
  })
  const [preview, setPreview] = useState(row?.unit_no || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const building = buildings.find((b) => b.id === f.building_id)
  const availableFloors = [...new Set([
    ...Array.from({ length: Math.max(0, Number(building?.floors_below) || 0) }, (_, i) => -i - 1),
    ...Array.from({ length: Math.max(1, Number(building?.floors_above) || 1) }, (_, i) => i + 1),
    ...originalLocations.filter((x) => x.building_id === f.building_id).map((x) => Number(x.floor)),
  ])].sort((a, b) => a - b)
  const selectedFloors = f.scope === 'whole' ? availableFloors : f.scope === 'multi' ? f.floors : [Number(f.floor)]
  const anchorFloor = editing ? row.floor : selectedFloors.length ? Math.min(...selectedFloors) : 1
  const locations = composite ? originalLocations.map(({ building_id, floor }) => ({ building_id, floor }))
    : selectedFloors.map((floor) => ({ building_id: f.building_id, floor }))

  // 新增时预览系统将生成的房号
  useEffect(() => {
    if (editing || !f.building_id) return
    let alive = true
    sb().rpc('next_unit_no', { p_building: f.building_id, p_floor: anchorFloor })
      .then(({ data }) => {
        if (alive) setPreview(Array.isArray(data) ? data[0]?.unit_no || '' : data?.unit_no || '')
      })
    return () => { alive = false }
  }, [editing, f.building_id, anchorFloor])

  const save = async () => {
    if (submitting.current) return
    setErr('')
    if (!f.building_id) return setErr('请选择楼栋')
    const ua = Number(f.usable_area) || 0
    const sa = Number(f.shared_area) || 0
    if (!Number.isFinite(ua) || ua <= 0 || !Number.isFinite(sa) || sa < 0) return setErr('使用面积必须大于 0，公摊面积不能为负数')
    if (!locations.length || locations.some((x) => !Number.isInteger(x.floor))) return setErr('请选择有效的覆盖楼层')
    if (!locations.some((x) => x.building_id === f.building_id && x.floor === anchorFloor)) return setErr('覆盖楼层必须保留原房号所属楼层')

    submitting.current = true
    setBusy(true)
    try {
      if (editing) {
        const { error } = await sb().from('units').update({
          usable_area: ua, shared_area: sa, purpose: f.purpose,
          status: f.status, remark: f.remark || null,
          locations,
        }).eq('id', row.id)
        if (error) throw new Error(error.message)
      } else {
        const { data: nn, error: nErr } = await sb().rpc('next_unit_no', {
          p_building: f.building_id, p_floor: anchorFloor,
        })
        if (nErr) throw new Error(nErr.message)
        const gen = Array.isArray(nn) ? nn[0] : nn
        const { error } = await sb().from('units').insert({
          park_id: parkId, building_id: f.building_id,
          unit_no: gen.unit_no, floor: anchorFloor, seq: gen.seq,
          locations,
          usable_area: ua, shared_area: sa, purpose: f.purpose,
          status: f.status, remark: f.remark || null,
        })
        if (error) throw new Error(error.message)
      }
      onDone()
    } catch (ex) {
      setErr(ex.message)
    } finally {
      submitting.current = false
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
                  onChange={(e) => setF({ ...f, building_id: e.target.value, floors: [], floor: 1 })}>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.code} 栋</option>)}
          </select>
        </div>
        <div>
          <label className="f" htmlFor="unit-scope">房源范围 *</label>
          <select id="unit-scope" value={f.scope} disabled={composite}
                  onChange={(e) => setF({ ...f, scope: e.target.value, floors: f.floors.length ? f.floors : [Number(f.floor)] })}>
            <option value="single">单层</option><option value="multi">多层</option><option value="whole">整栋</option>
            {composite && <option value="composite">跨栋组合房源</option>}
          </select>
        </div>
        <div>
          <label className="f">房号</label>
          <input value={preview} readOnly />
          <div className="hint">{editing ? '房号不可修改' : '由系统按编号规则生成'}</div>
        </div>
      </div>

      <div className="fgroup mt">
        {composite ? <div className="hint">覆盖位置：{unitLocationLabel(row)}。跨栋位置由合并／拆分操作维护。</div>
          : f.scope === 'single' ? <>
            <label className="f" htmlFor="unit-floor">层 *</label>
            <input id="unit-floor" type="number" value={f.floor} disabled={editing}
                   onChange={(e) => setF({ ...f, floor: e.target.value })} />
            <div className="hint">地下层填负数，如 -1</div>
          </> : <>
            <label className="f">覆盖楼层 *</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {availableFloors.map((floor) => <label className="row" key={floor} style={{ gap: 6 }}>
                <input type="checkbox" style={{ width: 16 }} checked={selectedFloors.includes(floor)}
                       disabled={f.scope === 'whole' || (editing && floor === row.floor)}
                       onChange={(e) => setF({ ...f, floors: e.target.checked ? [...f.floors, floor] : f.floors.filter((x) => x !== floor) })} />
                {floorLabel(floor)}
              </label>)}
            </div>
            <div className="hint">整栋包含楼栋登记的全部地上／地下楼层；下方填写整套房源的总面积，不乘以层数。</div>
          </>}
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
  const submitting = useRef(false)

  const samePark = new Set(rows.map((r) => r.park_id)).size === 1
  const sameStatus = new Set(rows.map((r) => r.status)).size === 1 && ['vacant', 'leased'].includes(rows[0]?.status)
  const samePurpose = new Set(rows.map((r) => r.purpose)).size === 1
  const leaseIds = rows.map((r) => r.lease_id || null)
  const sameLease = leaseIds.every((id) => id === leaseIds[0])
  const ua = rows.reduce((s, r) => s + Number(r.usable_area || 0), 0)
  const sa = rows.reduce((s, r) => s + Number(r.shared_area || 0), 0)
  const blocked = rows.length < 2 || !samePark || !sameStatus || !samePurpose || !sameLease

  const run = async () => {
    if (blocked || submitting.current) return
    submitting.current = true
    setBusy(true); setErr('')
    try {
      const { data, error } = await sb().rpc('merge_units', {
        p_unit_ids: rows.map((r) => r.id), p_purpose: null, p_reason: reason || null,
      })
      if (error) throw new Error(error.message)
      const { data: nu } = await sb().from('units').select('unit_no').eq('id', data).single()
      onDone(nu?.unit_no || data)
    } catch (ex) {
      setErr(ex.message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
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
                <td>{unitBuildingLabel(r)}</td><td>{unitFloorLabel(r)}</td><td>{r.unit_no}<div className="hint">{unitLocationLabel(r)}</div></td>
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

      {!samePark && <div className="err">只能合并同一园区的房源</div>}
      {!sameStatus && <div className="err">请选择全部空置或全部已租的房源；已售、预留、已注销及混合状态不能直接合并。</div>}
      {!samePurpose && <div className="err">请先统一所选房源的经营属性。</div>}
      {!sameLease && <div className="err">所选房源关联不同租约或混合已签约与未签约房源，不能直接合并。</div>}

      <div className="fgroup">
        <label className="f">合并原因</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：整层出租给某公司" />
      </div>

      <div className="hint">
        支持同园区跨栋、跨层合并。原房号注销且不再复用，新房号按首个覆盖位置的「栋号 + 层 + 序号」生成，列表完整显示所有覆盖位置。
        同一份租约下的房源合并后保留合同计租面积、收款计划、已收款记录及抄表记录。数据库还会校验草稿租约和表具归属。
      </div>

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}

function SplitDialog({ row, onClose, onDone }) {
  const sourceLocations = unitLocations(row)
  const locationKey = (x) => `${x.building_id}#${x.floor}`
  const blankKid = () => ({ usable_area: '', shared_area: '', purpose: row.purpose,
    locations: sourceLocations.length === 1 ? sourceLocations : [] })
  const [kids, setKids] = useState([
    blankKid(), blankKid(),
  ])
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const su = kids.reduce((s, k) => s + (Number(k.usable_area) || 0), 0)
  const ss = kids.reduce((s, k) => s + (Number(k.shared_area) || 0), 0)
  const du = su - Number(row.usable_area || 0)
  const ds = ss - Number(row.shared_area || 0)
  const okArea = Math.abs(du) <= 0.01 && Math.abs(ds) <= 0.01
    && kids.every((k) => Number(k.usable_area) > 0 && Number(k.shared_area) >= 0)
  const selectedLocations = new Set(kids.flatMap((k) => k.locations.map(locationKey)))
  const okLocations = kids.every((k) => k.locations.length > 0)
    && sourceLocations.every((x) => selectedLocations.has(locationKey(x)))

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
    if (busy || !okArea || !okLocations) return
    setBusy(true); setErr('')
    const { data, error } = await sb().rpc('split_unit', {
      p_unit_id: row.id,
      p_children: kids.map((k) => ({
        usable_area: Number(k.usable_area) || 0,
        shared_area: Number(k.shared_area) || 0,
        purpose: k.purpose,
        locations: k.locations.map(({ building_id, floor }) => ({ building_id, floor })),
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
        <button className="btn primary" onClick={run} disabled={busy || !okArea || !okLocations}>
          {busy ? '处理中…' : '确认拆分'}
        </button>
      </>
    }>
      <div className="kv mb">
        <Cell k="拆分前使用面积" v={`${area(row.usable_area)} ㎡`} />
        <Cell k="拆分前公摊面积" v={`${area(row.shared_area)} ㎡`} />
        <Cell k="拆分前建筑面积" v={`${area(row.area)} ㎡`} />
      </div>
      <div className="hint mb">拆分前位置：{unitLocationLabel(row)}。各子房源的位置须合计覆盖全部原位置；同层分成多间时可选择同一位置。</div>

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
          {sourceLocations.length > 1 && <div style={{ minWidth: 180 }}>
            <label className="f">覆盖位置 *</label>
            {sourceLocations.map((x) => <label className="row" key={locationKey(x)} style={{ gap: 6 }}>
              <input type="checkbox" style={{ width: 16 }} checked={k.locations.some((l) => locationKey(l) === locationKey(x))}
                     onChange={(e) => setKid(i, { locations: e.target.checked ? [...k.locations, x] : k.locations.filter((l) => locationKey(l) !== locationKey(x)) })} />
              {x.building_code}栋 {floorLabel(x.floor)}
            </label>)}
          </div>}
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
                onClick={() => setKids([...kids, blankKid()])}>
          + 增加一间
        </button>
        <button className="btn sm" onClick={fillLast}>剩余面积补到最后一间</button>
      </div>

      <div className={okArea ? 'ok-msg' : 'err'}>
        子房源汇总：使用 {area(su)} ㎡（差 {du >= 0 ? '+' : ''}{area(du)}）、
        公摊 {area(ss)} ㎡（差 {ds >= 0 ? '+' : ''}{area(ds)}）
        {okArea ? ' — 校验通过' : ' — 必须与拆分前一致（容差 0.01㎡）'}
      </div>
      {!okLocations && <div className="err">每个子房源都要选择位置，并覆盖拆分前的全部楼栋和楼层。</div>}

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
  const submitting = useRef(false)

  const run = async () => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true); setErr('')
    try {
      const { data, error } = await sb().rpc('delete_unit', { p_unit_id: row.id })
      if (error) {
        if (['PGRST202', '42883'].includes(error.code)) {
          throw new Error('数据库尚未升级删除功能，请管理员先运行 16_safe_unit_delete.sql，再刷新重试。')
        }
        if (error.code === '23503' && !/不能删除/.test(error.message)) {
          throw new Error('该房源有关联业务记录，不能删除。请先核对租约及历史记录。')
        }
        throw new Error(error.message)
      }
      if (data !== row.id) throw new Error('删除结果未确认，请刷新列表核对后重试。')
      onDone()
    } catch (ex) {
      setErr(`删除失败：${ex.message}`)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title="删除房源" danger busy={busy} onClose={() => { if (!busy) onClose() }} onConfirm={run}
      message={
        <>
          确定删除房源 <strong>{row.unit_no}</strong>（{area(row.area)} ㎡）？
          <div className="hint mt">位置：{unitLocationLabel(row)} · 状态：{STATUS_LABEL[row.display_status]}</div>
          <div className="hint mt">
            删除只针对这一房源，不会删除楼栋或其他房源，删除后无法在界面恢复。
            无关联记录的测试或误录房源，即使标为“已租”也可以删除。
            已关联租约、水电表、合并拆分台账或凭证的房源不能直接删除，以保留历史记录。
          </div>
          {err ? <div className="err">{err}</div> : null}
        </>
      }
    />
  )
}
