import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import Modal from '../components/Modal'
import { area, today, STATUS_LABEL, unitBuildingLabel, unitFloorLabel, unitLocationLabel } from '../lib/format'

const CYCLES = [
  { v: 1, t: '月付' }, { v: 3, t: '季付' },
  { v: 6, t: '半年付' }, { v: 12, t: '年付' },
]

export default function LeaseForm({ parkId, kind, leaseId, onClose, onDone }) {
  const isOwner = kind === 'ownership'
  const editing = !!leaseId

  const [parties, setParties] = useState([])
  const [units, setUnits] = useState([])
  const [f, setF] = useState({
    party_id: '', new_party: '', contact_name: '', contact_phone: '', tax_no: '',
    contract_no: '', start_date: today(), end_date: '',
    rent_price: '', fee_price: '',
    rent_cycle_months: 3, fee_cycle_months: 3, due_advance_days: 0,
    deposit_amount: '', water_price: '', electricity_price: '', remark: '',
  })
  const [pickedUnits, setPickedUnits] = useState([])
  const [periods, setPeriods] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(1)

  useEffect(() => {
    if (!parkId) return
    ;(async () => {
      const [p, u] = await Promise.all([
        sb().from('parties').select('id, name, kind, contact_name, contact_phone')
          .eq('park_id', parkId).eq('kind', isOwner ? 'owner' : 'tenant')
          .eq('is_active', true).order('name'),
        sb().from('v_unit_status').select('*').eq('park_id', parkId)
          .neq('status', 'voided').order('building_code').order('floor').order('unit_no'),
      ])
      setParties(p.data || [])
      setUnits(u.data || [])
    })()
  }, [parkId, isOwner])

  // 编辑时载入既有数据
  useEffect(() => {
    if (!leaseId) return
    ;(async () => {
      const [l, lu, lp] = await Promise.all([
        sb().from('leases').select('*').eq('id', leaseId).single(),
        sb().from('lease_units').select('*').eq('lease_id', leaseId),
        sb().from('lease_periods').select('*').eq('lease_id', leaseId).order('start_date'),
      ])
      if (l.data) {
        const d = l.data
        setF((s) => ({
          ...s,
          party_id: d.party_id, contract_no: d.contract_no,
          start_date: d.start_date, end_date: d.end_date,
          rent_price: d.rent_price, fee_price: d.fee_price,
          rent_cycle_months: d.rent_cycle_months, fee_cycle_months: d.fee_cycle_months,
          due_advance_days: d.due_advance_days,
          deposit_amount: d.deposit_amount,
          water_price: d.water_price ?? '', electricity_price: d.electricity_price ?? '',
          remark: d.remark || '',
        }))
      }
      setPickedUnits((lu.data || []).map((x) => ({
        unit_id: x.unit_id, usable_area: x.usable_area, shared_area: x.shared_area,
      })))
      setPeriods((lp.data || []).map((x) => ({
        kind: x.kind, start_date: x.start_date, end_date: x.end_date,
        waive_rent: x.waive_rent, waive_fee: x.waive_fee, remark: x.remark || '',
      })))
    })()
  }, [leaseId])

  const totalArea = pickedUnits.reduce(
    (s, u) => s + Number(u.usable_area || 0) + Number(u.shared_area || 0), 0)

  const toggleUnit = (u) => {
    const has = pickedUnits.find((x) => x.unit_id === u.id)
    if (has) return setPickedUnits(pickedUnits.filter((x) => x.unit_id !== u.id))
    setPickedUnits([...pickedUnits, {
      unit_id: u.id, usable_area: u.usable_area, shared_area: u.shared_area,
    }])
  }

  const setUnitArea = (id, patch) =>
    setPickedUnits(pickedUnits.map((x) => (x.unit_id === id ? { ...x, ...patch } : x)))

  const addPeriod = (k) => setPeriods([...periods, {
    kind: k,
    start_date: f.start_date,
    end_date: f.start_date,
    waive_rent: true,
    waive_fee: false,
    remark: '',
  }])

  const setPeriod = (i, patch) =>
    setPeriods(periods.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const save = async () => {
    setErr('')
    if (!f.party_id && !f.new_party.trim()) return setErr('请选择或新建租户 / 业主')
    if (!f.contract_no.trim()) return setErr('合同号必填')
    if (!f.end_date) return setErr('合同结束日必填')
    if (f.end_date < f.start_date) return setErr('结束日不能早于起始日')
    if (!pickedUnits.length) return setErr('请至少关联一间房源')
    if (!isOwner && !(Number(f.rent_price) > 0)) return setErr('租金单价必填')
    for (const p of periods) {
      if (p.end_date < p.start_date) return setErr('免租期 / 装修期的结束日不能早于起始日')
    }

    setBusy(true)
    try {
      // 1. 主体
      let partyId = f.party_id
      if (!partyId) {
        const { data, error } = await sb().from('parties').insert({
          park_id: parkId,
          kind: isOwner ? 'owner' : 'tenant',
          name: f.new_party.trim(),
          contact_name: f.contact_name || null,
          contact_phone: f.contact_phone || null,
          tax_no: f.tax_no || null,
        }).select('id').single()
        if (error) throw new Error(`保存租户失败：${error.message}`)
        partyId = data.id
      }

      // 2. 合约
      const payload = {
        park_id: parkId,
        party_id: partyId,
        contract_no: f.contract_no.trim(),
        lease_kind: kind,
        start_date: f.start_date,
        end_date: f.end_date,
        rent_price: isOwner ? 0 : Number(f.rent_price) || 0,
        fee_price: Number(f.fee_price) || 0,
        rent_cycle_months: Number(f.rent_cycle_months) || 3,
        fee_cycle_months: Number(f.fee_cycle_months) || 3,
        due_advance_days: Number(f.due_advance_days) || 0,
        deposit_amount: Number(f.deposit_amount) || 0,
        water_price: f.water_price === '' ? null : Number(f.water_price),
        electricity_price: f.electricity_price === '' ? null : Number(f.electricity_price),
        remark: f.remark || null,
      }

      let id = leaseId
      if (editing) {
        const { error } = await sb().from('leases').update(payload).eq('id', leaseId)
        if (error) throw new Error(`保存合同失败：${error.message}`)
      } else {
        const { data, error } = await sb().from('leases').insert(payload).select('id').single()
        if (error) throw new Error(`保存合同失败：${error.message}`)
        id = data.id
      }

      // 3. 房源关联（全量替换）
      await sb().from('lease_units').delete().eq('lease_id', id)
      const { error: luErr } = await sb().from('lease_units').insert(
        pickedUnits.map((u) => ({
          lease_id: id,
          unit_id: u.unit_id,
          usable_area: Number(u.usable_area) || 0,
          shared_area: Number(u.shared_area) || 0,
        }))
      )
      if (luErr) throw new Error(`保存房源关联失败：${luErr.message}`)

      // 4. 免租期 / 装修期（全量替换）
      await sb().from('lease_periods').delete().eq('lease_id', id)
      if (periods.length) {
        const { error: lpErr } = await sb().from('lease_periods').insert(
          periods.map((p) => ({
            lease_id: id,
            kind: p.kind,
            start_date: p.start_date,
            end_date: p.end_date,
            waive_rent: !!p.waive_rent,
            waive_fee: !!p.waive_fee,
            remark: p.remark || null,
          }))
        )
        if (lpErr) throw new Error(`保存免租期失败：${lpErr.message}`)
      }

      // 5. 生成收款计划（已收款账期不会被覆盖）
      const { error: gErr } = await sb().rpc('generate_lease_schedule', {
        p_lease: id, p_regenerate: true,
      })
      if (gErr) throw new Error(`生成收款计划失败：${gErr.message}`)

      onDone()
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  const title = editing
    ? `编辑${isOwner ? '物业服务合同' : '租约'}`
    : `新建${isOwner ? '物业服务合同' : '租约'}`

  return (
    <Modal title={title} wide onClose={onClose} footer={
      <>
        {step > 1 && <button className="btn" onClick={() => setStep(step - 1)}>上一步</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>取消</button>
        {step < 3
          ? <button className="btn primary" onClick={() => setStep(step + 1)}>下一步</button>
          : <button className="btn primary" onClick={save} disabled={busy}>
              {busy ? '保存中…' : '保存并生成收款计划'}
            </button>}
      </>
    }>
      <div className="seg mb">
        {['① 租户与房源', '② 计价与账期', '③ 免租与装修期'].map((t, i) => (
          <button key={i} className={step === i + 1 ? 'on' : ''} onClick={() => setStep(i + 1)}>{t}</button>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="frow">
            <div>
              <label className="f">{isOwner ? '业主' : '租户'} *</label>
              <select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value })}>
                <option value="">— 新建 —</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="f">合同号 *</label>
              <input value={f.contract_no} onChange={(e) => setF({ ...f, contract_no: e.target.value })}
                     placeholder="如 GC01-2026-008" />
            </div>
          </div>

          {!f.party_id && (
            <div className="frow mt">
              <div>
                <label className="f">{isOwner ? '业主' : '企业'}名称 *</label>
                <input value={f.new_party} onChange={(e) => setF({ ...f, new_party: e.target.value })} />
              </div>
              <div>
                <label className="f">联系人</label>
                <input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
              </div>
              <div>
                <label className="f">联系电话</label>
                <input value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} />
              </div>
              <div>
                <label className="f">统一社会信用代码</label>
                <input value={f.tax_no} onChange={(e) => setF({ ...f, tax_no: e.target.value })} />
              </div>
            </div>
          )}

          <div className="sec-title">关联房源（已选 {pickedUnits.length} 间，合计 {area(totalArea)} ㎡）</div>
          <div className="tbl-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 34 }} /><th>栋</th><th>层</th><th>房号</th>
                  <th className="num">建筑面积</th><th>状态</th>
                  <th className="num">计租使用</th><th className="num">计租公摊</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => {
                  const p = pickedUnits.find((x) => x.unit_id === u.id)
                  const occupied = ['leased', 'sold'].includes(u.status) && u.lease_id
                    && u.lease_id !== leaseId
                  return (
                    <tr key={u.id} className={p ? 'sel' : ''}>
                      <td>
                        <input type="checkbox" style={{ width: 16 }} checked={!!p}
                               disabled={occupied} onChange={() => toggleUnit(u)}
                               aria-label={`选择 ${u.unit_no}`} />
                      </td>
                      <td>{unitBuildingLabel(u)}</td>
                      <td>{unitFloorLabel(u)}</td>
                      <td><strong>{u.unit_no}</strong><div className="hint">{unitLocationLabel(u)}</div></td>
                      <td className="num">{area(u.area)}</td>
                      <td>
                        <span className={`tag ${u.display_status}`}>{STATUS_LABEL[u.display_status]}</span>
                        {occupied ? <span className="hint"> {u.party_name}</span> : null}
                      </td>
                      <td className="num">
                        {p ? (
                          <input type="number" step="0.01" style={{ width: 92 }} value={p.usable_area}
                                 onChange={(e) => setUnitArea(u.id, { usable_area: e.target.value })} />
                        ) : '—'}
                      </td>
                      <td className="num">
                        {p ? (
                          <input type="number" step="0.01" style={{ width: 92 }} value={p.shared_area}
                                 onChange={(e) => setUnitArea(u.id, { shared_area: e.target.value })} />
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="hint mt">
            计租面积默认取房源登记面积，如合同另有约定可直接改。总计租面积 {area(totalArea)} ㎡ 是租金与物业费的计算基数。
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="frow">
            <div>
              <label className="f">合同起始日 *</label>
              <input type="date" value={f.start_date}
                     onChange={(e) => setF({ ...f, start_date: e.target.value })} />
            </div>
            <div>
              <label className="f">合同结束日 *</label>
              <input type="date" value={f.end_date}
                     onChange={(e) => setF({ ...f, end_date: e.target.value })} />
            </div>
            <div>
              <label className="f">押金 元</label>
              <input type="number" step="0.01" value={f.deposit_amount}
                     onChange={(e) => setF({ ...f, deposit_amount: e.target.value })} />
            </div>
          </div>

          <div className="frow mt">
            {!isOwner && (
              <div>
                <label className="f">租金单价 元/㎡/天 *</label>
                <input type="number" step="0.001" value={f.rent_price}
                       onChange={(e) => setF({ ...f, rent_price: e.target.value })} placeholder="1.200" />
              </div>
            )}
            <div>
              <label className="f">物业费单价 元/㎡/月</label>
              <input type="number" step="0.01" value={f.fee_price}
                     onChange={(e) => setF({ ...f, fee_price: e.target.value })} placeholder="18.00" />
            </div>
          </div>

          <div className="frow mt">
            {!isOwner && (
              <div>
                <label className="f">租金缴费周期</label>
                <select value={f.rent_cycle_months}
                        onChange={(e) => setF({ ...f, rent_cycle_months: e.target.value })}>
                  {CYCLES.map((c) => <option key={c.v} value={c.v}>{c.t}（每 {c.v} 个月）</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="f">物业费缴费周期</label>
              <select value={f.fee_cycle_months}
                      onChange={(e) => setF({ ...f, fee_cycle_months: e.target.value })}>
                {CYCLES.map((c) => <option key={c.v} value={c.v}>{c.t}（每 {c.v} 个月）</option>)}
              </select>
            </div>
            <div>
              <label className="f">应交日提前天数</label>
              <input type="number" min="0" value={f.due_advance_days}
                     onChange={(e) => setF({ ...f, due_advance_days: e.target.value })} />
              <div className="hint">0 = 账期首日当天应交</div>
            </div>
          </div>

          <div className="frow mt">
            <div>
              <label className="f">水费单价 元/吨</label>
              <input type="number" step="0.0001" value={f.water_price}
                     onChange={(e) => setF({ ...f, water_price: e.target.value })} placeholder="留空用园区默认" />
            </div>
            <div>
              <label className="f">电费单价 元/度</label>
              <input type="number" step="0.0001" value={f.electricity_price}
                     onChange={(e) => setF({ ...f, electricity_price: e.target.value })} placeholder="留空用园区默认" />
            </div>
          </div>

          <div className="fgroup mt">
            <label className="f">备注</label>
            <input value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} />
          </div>

          <div className="hint">
            应交日期按合同起始日滚动推算，不固定在每月 1 日。租金按自然月实际天数计算：
            <br />租金 = Σ 每月（计租面积 × 元/㎡/天 × 该月计费天数）
            <br />物业费 = Σ 每月（计租面积 × 元/㎡/月 × 该月计费天数 ÷ 该月自然天数）
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="row mb">
            <button className="btn" onClick={() => addPeriod('fitout')}>+ 装修期</button>
            <button className="btn" onClick={() => addPeriod('rent_free')}>+ 免租期</button>
            <div className="spacer" />
            <span className="hint">起止可自由设定，允许多段、允许重叠</span>
          </div>

          {periods.length === 0 ? (
            <div className="empty">未设置免租期或装修期，全期照常计费</div>
          ) : periods.map((p, i) => (
            <div className="card mb" key={i}>
              <div className="card-b">
                <div className="frow" style={{ alignItems: 'end' }}>
                  <div style={{ flex: '0 0 110px' }}>
                    <label className="f">类型</label>
                    <select value={p.kind} onChange={(e) => setPeriod(i, { kind: e.target.value })}>
                      <option value="fitout">装修期</option>
                      <option value="rent_free">免租期</option>
                    </select>
                  </div>
                  <div>
                    <label className="f">起始日</label>
                    <input type="date" value={p.start_date}
                           onChange={(e) => setPeriod(i, { start_date: e.target.value })} />
                  </div>
                  <div>
                    <label className="f">结束日</label>
                    <input type="date" value={p.end_date}
                           onChange={(e) => setPeriod(i, { end_date: e.target.value })} />
                  </div>
                  <div style={{ flex: '0 0 76px' }}>
                    <button className="btn sm danger"
                            onClick={() => setPeriods(periods.filter((_, j) => j !== i))}>移除</button>
                  </div>
                </div>

                <div className="row mt">
                  <label className="row" style={{ gap: 6, fontSize: 13.5 }}>
                    <input type="checkbox" style={{ width: 16 }} checked={!!p.waive_rent}
                           onChange={(e) => setPeriod(i, { waive_rent: e.target.checked })} />
                    减免租金
                  </label>
                  <label className="row" style={{ gap: 6, fontSize: 13.5 }}>
                    <input type="checkbox" style={{ width: 16 }} checked={!!p.waive_fee}
                           onChange={(e) => setPeriod(i, { waive_fee: e.target.checked })} />
                    减免物业费
                  </label>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <input value={p.remark} placeholder="备注"
                           onChange={(e) => setPeriod(i, { remark: e.target.value })} />
                  </div>
                </div>

                <div className="hint mt">
                  共 {Math.max(0, Math.round(
                    (new Date(p.end_date) - new Date(p.start_date)) / 86400000) + 1)} 天
                  {p.waive_rent && p.waive_fee ? '，租金与物业费均减免'
                    : p.waive_rent ? '，仅减免租金，物业费照收'
                    : p.waive_fee ? '，仅减免物业费，租金照收'
                    : '，两项均照常计费'}
                </div>
              </div>
            </div>
          ))}

          <div className="hint">
            每户的减免规则可以不一样：装修期是否免物业费，勾选上面的开关即可。
            重叠的天数系统只扣一次，不会重复减免。
          </div>
        </>
      )}

      {err ? <div className="err">{err}</div> : null}
    </Modal>
  )
}
