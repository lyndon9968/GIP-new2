import { useEffect, useState, useCallback, useRef } from 'react'
import { useManualRefresh } from '../lib/PageCache'
import { sb } from '../lib/supabase'
import { area, moneyShort, money, num, pct } from '../lib/format'
import { DonutChart, BarChart, monthSeries, lastMonths } from '../components/Charts'

export default function Dashboard() {
  const [co, setCo] = useState(null)
  const [parks, setParks] = useState([])
  const [expect, setExpect] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const requestId = useRef(0)
  const load = useCallback(async () => {
    const request = ++requestId.current
    setLoading(true); setErr('')
    try {
      const [c, p, e] = await Promise.all([
        sb().from('v_company_overview').select('*').maybeSingle(),
        sb().from('v_park_overview').select('*').order('sort_order').order('code'),
        sb().from('v_expected_income').select('*').in('charge_type', ['rent', 'property_fee']),
      ])
      if (request !== requestId.current) return
      if (c.error) throw new Error(c.error.message)
      if (p.error) throw new Error(p.error.message)
      if (e.error) throw new Error(e.error.message)
      setCo(c.data)
      setParks(p.data || [])
      setExpect(e.data || [])
    } catch (ex) {
      if (request === requestId.current) setErr(ex.message)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [])
  useEffect(() => { load(); return () => { ++requestId.current } }, [load])
  useManualRefresh(load, loading)

  if (loading) return <div className="loading">加载中…</div>
  if (err) return <div className="err">{err}</div>

  return (
    <>
      <CompanyKpis co={co} />
      <ExpectedIncome rows={expect} />

      <div className="sec-title">园区概览</div>
      {parks.length === 0 ? (
        <div className="card"><div className="empty">尚未创建园区，请到系统设置中添加</div></div>
      ) : (
        <div className="grid parks-grid">
          {parks.map((p) => <ParkCard key={p.park_id} p={p} />)}
        </div>
      )}
    </>
  )
}

function CompanyKpis({ co }) {
  const c = co || {}
  return (
    <>
      <div className="grid kpis">
        <Kpi cls="accent" lbl="总管理面积" val={area(c.total_managed_area)} unit="㎡"
             sub={`${num(c.park_count)} 个园区 · ${num(c.building_count)} 栋`} />
        <Kpi lbl="累计租金收入" val={moneyShort(c.rent_income_total)} sub="全部已收租金" />
        <Kpi lbl="当年租金收入" val={moneyShort(c.rent_income_ytd)} sub={`${new Date().getFullYear()} 年已收`} />
        <Kpi lbl="累计物业费收入" val={moneyShort(c.fee_income_total)} sub="全部已收物业费" />
        <Kpi lbl="当年物业费收入" val={moneyShort(c.fee_income_ytd)} sub={`${new Date().getFullYear()} 年已收`} />
        <Kpi cls="good" lbl="总体出租率" val={pct(c.occupancy_rate)}
             sub={`已租 ${area(c.leased_area)} / 可租 ${area(c.rentable_area)} ㎡`} />
        <Kpi cls="good" lbl="总体销售率" val={pct(c.sale_rate)}
             sub={`已售 ${area(c.sold_area)} / 可售 ${area(c.saleable_area)} ㎡`} />
        <Kpi cls={Number(c.overdue_count) > 0 ? 'alert' : ''} lbl="逾期未收"
             val={moneyShort(c.overdue_amount)}
             sub={`${num(c.overdue_count)} 笔 · 其中 ${num(c.critical_overdue_count)} 笔超 7 天`} />
      </div>
    </>
  )
}

function Kpi({ lbl, val, unit, sub, cls = '' }) {
  return (
    <div className={`kpi ${cls}`}>
      <div className="lbl">{lbl}</div>
      <div className="val">{val}{unit ? <span className="unit">{unit}</span> : null}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}

// 未来 6 个月预期收入，数据来自已生成的收款计划表
function ExpectedIncome({ rows }) {
  const months = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`)
  }

  const rent = monthSeries(rows.filter((r) => r.charge_type === 'rent'), months, (r) => r.expected_amount)
  const fee = monthSeries(rows.filter((r) => r.charge_type === 'property_fee'), months, (r) => r.expected_amount)
  const total = rent.reduce((s, x) => s + x.value, 0) + fee.reduce((s, x) => s + x.value, 0)

  if (total <= 0) return null

  return (
    <div className="card mt">
      <div className="card-h">
        <h3>未来 6 个月预期收入</h3>
        <span className="hint">来自各租约已生成的收款计划，合计 {money(total)} 元</span>
      </div>
      <div className="card-b">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div>
            <div className="legend-inline mb"><span><i style={{ background: '#1b4f9c' }} />预期租金</span></div>
            <BarChart data={rent} color="#1b4f9c" />
          </div>
          <div>
            <div className="legend-inline mb"><span><i style={{ background: '#7a5cc4' }} />预期物业费</span></div>
            <BarChart data={fee} color="#7a5cc4" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ParkCard({ p }) {
  return (
    <div className="card park-overview-card">
      <div className="card-h">
        <h3>{p.name}</h3>
        <span className="tag">{p.code}</span>
        {p.city ? <span className="hint">{p.city}</span> : null}
      </div>

      <div className="card-b">
        <div className="kv">
          <Item k="占地面积" v={`${area(p.land_area)} ㎡`} />
          <Item k="栋数" v={`${num(p.building_count)} 栋`} />
          <Item k="建筑面积" v={`${area(p.gfa_total)} ㎡`} />
          <Item k="地上 / 地下" v={`${area(p.gfa_above)} / ${area(p.gfa_below)}`} />
          <Item k="可出租面积" v={`${area(p.rentable_area)} ㎡`} />
          <Item k="车位数" v={`${num(p.parking_count)} 个`} />
        </div>

        {(p.has_rental || p.has_sale) && (
          <div className="row mt" style={{ gap: 18, justifyContent: 'space-around' }}>
            {p.has_rental && (
              <DonutChart
                value={p.occupancy_rate} label="出租率" color="#15925f"
                sub={
                  <>
                    <div><i style={{ background: '#15925f' }} />已租 {area(p.leased_area)} ㎡</div>
                    <div><i style={{ background: '#e6eaf1' }} />未出租 {area(p.vacant_area)} ㎡</div>
                  </>
                }
              />
            )}
            {p.has_sale && (
              <DonutChart
                value={p.sale_rate} label="销售率" color="#7a5cc4"
                sub={
                  <>
                    <div><i style={{ background: '#7a5cc4' }} />已售 {area(p.sold_area)} ㎡</div>
                    <div><i style={{ background: '#e6eaf1' }} />
                      待售 {area(Number(p.saleable_area || 0) - Number(p.sold_area || 0))} ㎡
                    </div>
                  </>
                }
              />
            )}
          </div>
        )}

        <div className="fee-list">
          <div className="fee-row">
            <span className="ft">水费</span>
            <span className="fa">{money(p.water_amount_month)} 元</span>
            <span className="fd">本月用量 {num(p.water_usage_month, 2)} 吨</span>
          </div>
          <div className="fee-row">
            <span className="ft">电费</span>
            <span className="fa">{money(p.elec_amount_month)} 元</span>
            <span className="fd">本月用量 {num(p.elec_usage_month, 2)} 度</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Item({ k, v }) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  )
}
