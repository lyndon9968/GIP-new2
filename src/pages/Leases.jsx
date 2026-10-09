import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useManualRefresh } from '../lib/PageCache'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { ParkPicker } from '../components/Layout'
import { money, area, dateStr, CHARGE_LABEL } from '../lib/format'
import LeaseForm from './LeaseForm'
import { PaymentDialog, ScheduleDialog } from './LeasePayment'

export default function Leases() {
  const { parks, can } = useAuth()
  const [parkId, setParkId] = useState('')
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [tab, setTab] = useState('rental')   // rental | ownership
  const [onlyAlert, setOnlyAlert] = useState(false)
  const [kw, setKw] = useState('')
  const [dlg, setDlg] = useState(null)
  const requestId = useRef(0)

  useEffect(() => {
    if (!parkId && parks.length) setParkId(parks[0].id)
  }, [parks, parkId])

  const load = useCallback(async () => {
    if (!parkId) return
    const request = ++requestId.current
    setLoading(true); setErr('')
    try {
      const { data, error } = await sb()
        .from('v_lease_cards').select('*')
        .eq('park_id', parkId)
        .in('status', ['draft', 'active', 'expired'])
        .order('max_alert_level', { ascending: false })
        .order('party_name')
      if (request !== requestId.current) return
      if (error) throw new Error(error.message)
      setCards(data || [])
    } catch (ex) {
      if (request === requestId.current) setErr(ex.message)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [parkId])

  useEffect(() => { load(); return () => { ++requestId.current } }, [load])
  useManualRefresh(load, loading)

  const shown = useMemo(() => cards.filter((c) => {
    if (c.lease_kind !== tab) return false
    if (onlyAlert && Number(c.max_alert_level) < 2) return false
    if (kw && !`${c.party_name} ${c.contract_no} ${c.unit_list || ''}`.toLowerCase()
                .includes(kw.toLowerCase())) return false
    return true
  }), [cards, tab, onlyAlert, kw])

  const alerts = cards.filter((c) => Number(c.max_alert_level) >= 2)
  const critical = cards.filter((c) => Number(c.max_alert_level) === 3)
  const done = (m) => { setMsg(m); setDlg(null); load(); setTimeout(() => setMsg(''), 4000) }

  return (
    <>
      <div className="card mb">
        <div className="card-b">
          <div className="row">
            <ParkPicker value={parkId} onChange={setParkId} />
            <div style={{ minWidth: 160, flex: 1 }}>
              <label className="f">搜索租户 / 合同号 / 房号</label>
              <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="输入关键词" />
            </div>
          </div>

          <div className="row mt">
            <div className="seg">
              <button className={tab === 'rental' ? 'on' : ''} onClick={() => setTab('rental')}>
                租赁租户
              </button>
              <button className={tab === 'ownership' ? 'on' : ''} onClick={() => setTab('ownership')}>
                已售业主
              </button>
            </div>
            <button className={`btn${onlyAlert ? ' primary' : ''}`} onClick={() => setOnlyAlert(!onlyAlert)}>
              仅看逾期{alerts.length ? `（${alerts.length}）` : ''}
            </button>
            {can.editLease && (
              <button className="btn primary" onClick={() => setDlg({ type: 'new' })}>
                + 新建{tab === 'ownership' ? '物业服务合同' : '租约'}
              </button>
            )}
            <div className="spacer" />
            <span className="hint">共 {shown.length} 户</span>
          </div>

          {critical.length > 0 && (
            <div className="err mt" style={{ fontWeight: 600 }}>
              ⚠ {critical.length} 户逾期已超 7 天，合计欠款{' '}
              {money(critical.reduce((s, c) => s + Number(c.total_balance || 0), 0))} 元
            </div>
          )}
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
      {msg ? <div className="ok-msg">{msg}</div> : null}

      {loading ? <div className="loading">加载中…</div>
        : shown.length === 0 ? (
          <div className="card"><div className="empty">
            {tab === 'ownership' ? '暂无已售物业的业主合同' : '暂无租约'}
          </div></div>
        ) : (
          <div className="grid cards-grid">
            {shown.map((c) => (
              <LeaseCard key={c.lease_id} c={c} can={can}
                         onPay={(ch) => setDlg({ type: 'pay', card: c, charge: ch })}
                         onEdit={() => setDlg({ type: 'edit', card: c })}
                         onSchedule={() => setDlg({ type: 'sched', card: c })} />
            ))}
          </div>
        )}

      {dlg?.type === 'new' && (
        <LeaseForm parkId={parkId} kind={tab} onClose={() => setDlg(null)}
                   onDone={() => done('合同已保存，收款计划已生成')} />
      )}
      {dlg?.type === 'edit' && (
        <LeaseForm parkId={parkId} kind={dlg.card.lease_kind} leaseId={dlg.card.lease_id}
                   onClose={() => setDlg(null)} onDone={() => done('合同已更新')} />
      )}
      {dlg?.type === 'pay' && (
        <PaymentDialog card={dlg.card} charge={dlg.charge} onClose={() => setDlg(null)}
                       onDone={() => done('收款已确认')} />
      )}
      {dlg?.type === 'sched' && (
        <ScheduleDialog card={dlg.card} onClose={() => setDlg(null)} onPaid={() => done('收款已确认')} />
      )}
    </>
  )
}

function LeaseCard({ c, can, onPay, onEdit, onSchedule }) {
  const lv = Number(c.max_alert_level) || 0
  const isOwner = c.lease_kind === 'ownership'

  const fees = [
    { t: 'rent', amt: c.rent_due_amount, due: c.rent_due_date, od: c.rent_overdue_days,
      lv: c.rent_alert, id: c.rent_charge_id },
    { t: 'property_fee', amt: c.fee_due_amount, due: c.fee_due_date, od: c.fee_overdue_days,
      lv: c.fee_alert, id: c.fee_charge_id },
    { t: 'water', amt: c.water_due_amount, due: c.water_due_date, od: c.water_overdue_days,
      lv: c.water_alert, id: c.water_charge_id },
    { t: 'electricity', amt: c.elec_due_amount, due: c.elec_due_date, od: c.elec_overdue_days,
      lv: c.elec_alert, id: c.elec_charge_id },
  ].filter((f) => f.id && !(isOwner && f.t === 'rent'))

  return (
    <div className={`lease-card lv${lv}`}>
      <div className="lc-h">
        <div className="nm">
          {c.party_name}
          {isOwner ? <span className="tag sold">业主</span> : null}
          {c.status === 'draft' ? <span className="tag unpaid">未生成计划</span> : null}
          {lv === 3 ? <span className="tag overdue">逾期 {c.max_overdue_days} 天</span> : null}
        </div>
        <div className="sub">
          {c.contract_no} · {c.unit_list || '未关联房源'}
        </div>
      </div>

      <div className="lc-b">
        <div className="kv">
          <F k="租赁面积" v={`${area(c.total_area)} ㎡`} />
          <F k="使用 / 公摊" v={`${area(c.usable_area)} / ${area(c.shared_area)}`} />
          {!isOwner && <F k="租金" v={`${Number(c.rent_price || 0).toFixed(3)} 元/㎡/天`} />}
          <F k="物业费" v={`${Number(c.fee_price || 0).toFixed(2)} 元/㎡/月`} />
          <F k="合同起始" v={dateStr(c.start_date)} />
          <F k="合同结束" v={dateStr(c.end_date)} />
          {!isOwner && <F k="免租期" v={`${Number(c.rent_free_months || 0).toFixed(1)} 月`} />}
          {!isOwner && <F k="装修期" v={`${Number(c.fitout_months || 0).toFixed(1)} 月`} />}
        </div>

        <div className="fee-list">
          {fees.length === 0 ? (
            <div className="fee-row empty">
              {c.status === 'draft' ? '尚未生成收款计划' : '本期无待收款项'}
            </div>
          ) : fees.map((f) => (
            <div className={`fee-row lv${Number(f.lv) || 0}`} key={f.t}>
              <span className="ft">{CHARGE_LABEL[f.t]}</span>
              <div>
                <div className="fa">{money(f.amt)} 元</div>
                <div className={`fd${Number(f.od) > 0 ? ' od' : ''}`}>
                  应交 {dateStr(f.due)}
                  {Number(f.od) > 0 ? ` · 已逾期 ${f.od} 天` : ''}
                </div>
              </div>
              {can.confirmPayment && (
                <button className="btn ok sm" onClick={() => onPay(f)}>确认收款</button>
              )}
            </div>
          ))}
        </div>

        <div className="row mt">
          <button className="btn sm" onClick={onSchedule}>收款计划</button>
          {can.editLease && <button className="btn sm" onClick={onEdit}>编辑合同</button>}
          <div className="spacer" />
          {Number(c.total_balance) > 0 && (
            <span className="hint">
              未收合计 <strong style={{ color: lv >= 2 ? '#d63a3a' : '#1a2233' }}>
                {money(c.total_balance)}
              </strong> 元
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function F({ k, v }) {
  return <div><div className="k">{k}</div><div className="v">{v}</div></div>
}
