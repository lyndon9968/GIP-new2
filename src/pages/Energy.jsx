import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useManualRefresh } from '../lib/PageCache'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { ParkPicker } from '../components/Layout'
import { BarChart, monthSeries, lastMonths } from '../components/Charts'
import { money, num, monthStart, monthLabel } from '../lib/format'
import MeterReadingCard from './EnergyCard'
import MeterDialog from './EnergyMeter'

export default function Energy() {
  const { parks, can } = useAuth()
  const [parkId, setParkId] = useState('')
  const [month, setMonth] = useState(monthStart())
  const [meters, setMeters] = useState([])
  const [readings, setReadings] = useState([])
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [dlg, setDlg] = useState(null)
  const [group, setGroup] = useState('tenant')  // tenant | public
  const requestId = useRef(0)

  useEffect(() => {
    if (!parkId && parks.length) setParkId(parks[0].id)
  }, [parks, parkId])

  const load = useCallback(async () => {
    if (!parkId) return
    const request = ++requestId.current
    setLoading(true); setErr('')
    try {
      const [m, r, s] = await Promise.all([
        sb().from('meters')
          .select('id,park_id,meter_no,meter_type,multiplier,is_public,is_master,location,is_active,init_reading,unit_id,lease_id,building_id')
          .eq('park_id', parkId).eq('is_active', true).order('meter_type').order('meter_no'),
        sb().from('meter_readings').select('*').eq('park_id', parkId).eq('bill_month', month),
        sb().from('v_energy_monthly').select('*').eq('park_id', parkId),
      ])
      if (request !== requestId.current) return
      if (m.error) throw new Error(m.error.message)
      if (r.error) throw new Error(r.error.message)
      if (s.error) throw new Error(s.error.message)
      setMeters(m.data || [])
      setReadings(r.data || [])
      setSeries(s.data || [])
    } catch (ex) {
      if (request === requestId.current) setErr(ex.message)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [parkId, month])

  useEffect(() => { load(); return () => { ++requestId.current } }, [load])
  useManualRefresh(load, loading)

  // 按租约分组，一个租户一张卡；公共表单独一组
  const groups = useMemo(() => {
    const map = new Map()
    for (const m of meters) {
      const key = m.is_public || m.is_master ? '__public__' : (m.lease_id || '__unbound__')
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(m)
    }
    return map
  }, [meters])

  const [leaseInfo, setLeaseInfo] = useState({})
  useEffect(() => {
    let alive = true
    const ids = [...new Set(meters.map((m) => m.lease_id).filter(Boolean))]
    if (!ids.length) return setLeaseInfo({})
    sb().from('v_lease_cards')
      .select('lease_id, party_name, contract_no, unit_list, water_price, electricity_price, total_area')
      .in('lease_id', ids)
      .then(({ data }) => {
        if (!alive) return
        const o = {}
        for (const x of data || []) o[x.lease_id] = x
        setLeaseInfo(o)
      })
    return () => { alive = false }
  }, [meters])

  const months = lastMonths(6)
  const waterBars = monthSeries(series.filter((x) => x.meter_type === 'water'), months)
  const elecBars = monthSeries(series.filter((x) => x.meter_type === 'electricity'), months)
  const thisMonth = series.filter((x) => String(x.month).slice(0, 7) === month.slice(0, 7))
  const wSum = thisMonth.filter((x) => x.meter_type === 'water').reduce((s, x) => s + Number(x.amount || 0), 0)
  const eSum = thisMonth.filter((x) => x.meter_type === 'electricity').reduce((s, x) => s + Number(x.amount || 0), 0)

  const done = (m) => { setMsg(m); setDlg(null); load(); setTimeout(() => setMsg(''), 4000) }

  const allocLoss = async (type) => {
    setErr(''); setMsg('')
    const { data, error } = await sb().rpc('allocate_energy_loss', {
      p_park: parkId, p_bill_month: month, p_type: type,
    })
    if (error) return setErr(error.message)
    load()
    setMsg(Number(data) > 0
      ? `已分摊${type === 'water' ? '水' : '电'}损耗 ${num(data, 2)} ${type === 'water' ? '吨' : '度'}`
      : '本月无需分摊，或园区未启用损耗分摊')
    setTimeout(() => setMsg(''), 5000)
  }

  const tenantKeys = [...groups.keys()].filter((k) => k !== '__public__')
  const publicMeters = groups.get('__public__') || []

  return (
    <>
      <div className="card mb">
        <div className="card-b">
          <div className="row">
            <ParkPicker value={parkId} onChange={setParkId} />
            <div style={{ minWidth: 150 }}>
              <label className="f">抄表月份</label>
              <input type="month" value={month.slice(0, 7)}
                     onChange={(e) => setMonth(`${e.target.value}-01`)} />
            </div>
            {can.editMeter && (
              <div style={{ alignSelf: 'flex-end' }}>
                <button className="btn" onClick={() => setDlg({ type: 'meter' })}>表具管理</button>
              </div>
            )}
          </div>

          <div className="row mt">
            <div className="seg">
              <button className={group === 'tenant' ? 'on' : ''} onClick={() => setGroup('tenant')}>
                租户表（{tenantKeys.length}）
              </button>
              <button className={group === 'public' ? 'on' : ''} onClick={() => setGroup('public')}>
                公共 / 总表（{publicMeters.length}）
              </button>
            </div>
            {can.editMeter && (
              <>
                <button className="btn" onClick={() => allocLoss('water')}>分摊水损耗</button>
                <button className="btn" onClick={() => allocLoss('electricity')}>分摊电损耗</button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid kpis mb">
        <div className="kpi accent">
          <div className="lbl">{monthLabel(month)} 水费合计</div>
          <div className="val">{money(wSum)}<span className="unit">元</span></div>
        </div>
        <div className="kpi accent">
          <div className="lbl">{monthLabel(month)} 电费合计</div>
          <div className="val">{money(eSum)}<span className="unit">元</span></div>
        </div>
      </div>

      <div className="grid mb" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card">
          <div className="card-h"><h3>水费（近 6 个月）</h3></div>
          <div className="card-b"><BarChart data={waterBars} color="#3b7fd4" /></div>
        </div>
        <div className="card">
          <div className="card-h"><h3>电费（近 6 个月）</h3></div>
          <div className="card-b"><BarChart data={elecBars} color="#d98212" /></div>
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
      {msg ? <div className="ok-msg">{msg}</div> : null}

      {loading ? <div className="loading">加载中…</div> : (
        <div className="grid cards-grid">
          {group === 'tenant' ? (
            tenantKeys.length === 0
              ? <div className="card"><div className="empty">尚未配置租户水电表，请先在「表具管理」中添加</div></div>
              : tenantKeys.map((k) => (
                  <MeterReadingCard
                    key={k} meters={groups.get(k)} lease={leaseInfo[k]} month={month}
                    readings={readings} canEdit={can.editMeter}
                    onSaved={() => done('抄表已保存，账单已同步')}
                  />
                ))
          ) : (
            publicMeters.length === 0
              ? <div className="card"><div className="empty">尚未配置公共区域表或园区总表</div></div>
              : <MeterReadingCard
                  meters={publicMeters} lease={null} month={month} readings={readings}
                  canEdit={can.editMeter} isPublic
                  onSaved={() => done('抄表已保存')}
                />
          )}
        </div>
      )}

      {dlg?.type === 'meter' && (
        <MeterDialog parkId={parkId} onClose={() => setDlg(null)} onDone={() => done('表具已保存')} />
      )}
    </>
  )
}
