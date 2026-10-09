import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import Modal, { ConfirmDialog } from '../components/Modal'
import { unitInBuilding, unitLocationLabel } from '../lib/format'

const BLANK = {
  meter_no: '', meter_type: 'water', building_id: '', unit_id: '', lease_id: '',
  is_public: false, is_master: false, multiplier: 1, init_reading: 0, location: '', remark: '',
}

// 表具管理：水表号 / 电表号、倍率、归属（租户 / 公共 / 总表）
export default function MeterDialog({ parkId, onClose, onDone }) {
  const [list, setList] = useState([])
  const [buildings, setBuildings] = useState([])
  const [units, setUnits] = useState([])
  const [leases, setLeases] = useState([])
  const [f, setF] = useState(BLANK)
  const [editId, setEditId] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(null)

  const load = async () => {
    const [m, b, u, l] = await Promise.all([
      sb().from('meters').select('*').eq('park_id', parkId).order('meter_type').order('meter_no'),
      sb().from('buildings').select('id, code').eq('park_id', parkId).order('code'),
      sb().from('v_unit_status').select('id, unit_no, floor, building_id, building_code, locations').eq('park_id', parkId)
        .neq('status', 'voided').order('unit_no'),
      sb().from('v_lease_cards').select('lease_id, party_name, contract_no')
        .eq('park_id', parkId).in('status', ['active', 'draft']),
    ])
    setList(m.data || [])
    setBuildings(b.data || [])
    setUnits(u.data || [])
    setLeases(l.data || [])
  }

  useEffect(() => { load() }, [parkId])

  const reset = () => { setF(BLANK); setEditId(null); setErr('') }

  const save = async () => {
    setErr('')
    if (!f.meter_no.trim()) return setErr('表号必填')

    const payload = {
      park_id: parkId,
      meter_no: f.meter_no.trim(),
      meter_type: f.meter_type,
      building_id: f.building_id || null,
      unit_id: f.unit_id || null,
      lease_id: f.is_public || f.is_master ? null : (f.lease_id || null),
      is_public: !!f.is_public,
      is_master: !!f.is_master,
      multiplier: Number(f.multiplier) || 1,
      init_reading: Number(f.init_reading) || 0,
      location: f.location || null,
      remark: f.remark || null,
    }

    setBusy(true)
    const { error } = editId
      ? await sb().from('meters').update(payload).eq('id', editId)
      : await sb().from('meters').insert(payload)
    setBusy(false)
    if (error) return setErr(error.message)
    reset()
    load()
    onDone?.()
  }

  const edit = (m) => {
    setEditId(m.id)
    setF({
      meter_no: m.meter_no, meter_type: m.meter_type,
      building_id: m.building_id || '', unit_id: m.unit_id || '', lease_id: m.lease_id || '',
      is_public: m.is_public, is_master: m.is_master,
      multiplier: m.multiplier, init_reading: m.init_reading,
      location: m.location || '', remark: m.remark || '',
    })
  }

  const removeMeter = async () => {
    setBusy(true)
    const { error } = await sb().from('meters').delete().eq('id', del.id)
    setBusy(false)
    if (error) { setErr(`删除失败：${error.message}`); setDel(null); return }
    setDel(null)
    load()
  }

  const unitOptions = f.building_id
    ? units.filter((u) => unitInBuilding(u, f.building_id))
    : units

  return (
    <Modal title="表具管理" wide onClose={onClose} footer={
      <button className="btn" onClick={onClose}>关闭</button>
    }>
      <div className="sec-title">{editId ? '编辑表具' : '新增表具'}</div>

      <div className="frow">
        <div>
          <label className="f">表号 *</label>
          <input value={f.meter_no} onChange={(e) => setF({ ...f, meter_no: e.target.value })}
                 placeholder="如 W-A1-0305" />
        </div>
        <div>
          <label className="f">类型</label>
          <select value={f.meter_type} onChange={(e) => setF({ ...f, meter_type: e.target.value })}>
            <option value="water">水表</option>
            <option value="electricity">电表</option>
          </select>
        </div>
        <div>
          <label className="f">倍率</label>
          <input type="number" step="0.0001" value={f.multiplier}
                 onChange={(e) => setF({ ...f, multiplier: e.target.value })} />
          <div className="hint">互感器倍率，无则填 1</div>
        </div>
        <div>
          <label className="f">建表初始读数</label>
          <input type="number" step="0.001" value={f.init_reading}
                 onChange={(e) => setF({ ...f, init_reading: e.target.value })} />
          <div className="hint">首次抄表的上期读数</div>
        </div>
      </div>

      <div className="row mt">
        <label className="row" style={{ gap: 6, fontSize: 13.5 }}>
          <input type="checkbox" style={{ width: 16 }} checked={f.is_public}
                 onChange={(e) => setF({ ...f, is_public: e.target.checked, lease_id: '' })} />
          公共区域表（走廊、停车场等）
        </label>
        <label className="row" style={{ gap: 6, fontSize: 13.5 }}>
          <input type="checkbox" style={{ width: 16 }} checked={f.is_master}
                 onChange={(e) => setF({ ...f, is_master: e.target.checked, lease_id: '' })} />
          园区 / 楼栋总表
        </label>
      </div>
      <div className="hint">
        公共表与总表不直接出账。总表用量减去各租户用量即真实损耗，用于按面积或用量分摊到租户账单。
      </div>

      <div className="frow mt">
        <div>
          <label className="f">所属栋</label>
          <select value={f.building_id}
                  onChange={(e) => setF({ ...f, building_id: e.target.value, unit_id: '' })}>
            <option value="">—</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.code} 栋</option>)}
          </select>
        </div>
        <div>
          <label className="f">对应房源</label>
          <select value={f.unit_id} onChange={(e) => setF({ ...f, unit_id: e.target.value })}>
            <option value="">—</option>
            {unitOptions.map((u) => (
              <option key={u.id} value={u.id}>{u.unit_no}（{unitLocationLabel(u)}）</option>
            ))}
          </select>
        </div>
        <div>
          <label className="f">计费归属租户</label>
          <select value={f.lease_id} disabled={f.is_public || f.is_master}
                  onChange={(e) => setF({ ...f, lease_id: e.target.value })}>
            <option value="">—</option>
            {leases.map((l) => (
              <option key={l.lease_id} value={l.lease_id}>{l.party_name}（{l.contract_no}）</option>
            ))}
          </select>
          <div className="hint">一个租户可绑多块表</div>
        </div>
        <div>
          <label className="f">安装位置</label>
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}

      <div className="row mt">
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? '保存中…' : editId ? '保存修改' : '新增表具'}
        </button>
        {editId && <button className="btn" onClick={reset}>取消编辑</button>}
      </div>

      <div className="sec-title">已有表具（{list.length}）</div>
      {list.length === 0 ? <div className="empty">暂无表具</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>表号</th><th>类型</th><th>归属</th><th>房源</th>
                <th className="num">倍率</th><th className="num">初始读数</th>
                <th>位置</th><th style={{ width: 96 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const lease = leases.find((l) => l.lease_id === m.lease_id)
                const unit = units.find((u) => u.id === m.unit_id)
                return (
                  <tr key={m.id} style={{ opacity: m.is_active ? 1 : 0.5 }}>
                    <td><strong>{m.meter_no}</strong></td>
                    <td>{m.meter_type === 'water' ? '水表' : '电表'}</td>
                    <td>
                      {m.is_master ? <span className="tag reserved">总表</span>
                        : m.is_public ? <span className="tag">公共</span>
                        : lease ? lease.party_name
                        : <span className="hint">未绑定</span>}
                    </td>
                    <td>{unit?.unit_no || '—'}</td>
                    <td className="num">{m.multiplier}</td>
                    <td className="num">{m.init_reading}</td>
                    <td>{m.location || '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        <button className="btn sm" onClick={() => edit(m)}>编辑</button>
                        <button className="btn sm danger" onClick={() => setDel(m)}>删除</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {del && (
        <ConfirmDialog
          title="删除表具" danger busy={busy} onClose={() => setDel(null)} onConfirm={removeMeter}
          message={
            <>
              确定删除表 <strong>{del.meter_no}</strong>？
              <div className="hint mt">该表的历史抄表记录会一并删除，已生成的水电账单将解除关联。</div>
            </>
          }
        />
      )}
    </Modal>
  )
}
