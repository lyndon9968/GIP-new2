export const ROLE_LABEL = {
  super_admin: '超级管理员',
  pm: '物业经理',
  engineer: '工程人员',
  cs: '客服',
}

export const CHARGE_LABEL = {
  rent: '租金',
  property_fee: '物业费',
  water: '水费',
  electricity: '电费',
  deposit: '押金',
  other: '其它',
}

export const STATUS_LABEL = {
  vacant: '空置',
  leased: '已租',
  sold: '已售',
  sold_overdue: '已售·欠费',
  fitout: '装修中',
  overdue: '欠费中',
  reserved: '预留',
  voided: '已注销',
}

export const PURPOSE_LABEL = {
  rent_only: '仅出租',
  sale_only: '仅销售',
  rent_or_sale: '可租可售',
  self_use: '自用',
  common: '公共区域',
}

export const CHARGE_STATUS_LABEL = {
  unpaid: '未收',
  partial: '部分收款',
  paid: '已收',
  waived: '免收',
  void: '作废',
}

export const PAY_METHOD_LABEL = {
  bank_transfer: '银行转账',
  cash: '现金',
  cheque: '票据',
  alipay: '支付宝',
  wechat: '微信',
  other: '其它',
}

const nf = (digits) =>
  new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const money = (v) => nf(2).format(Number(v || 0))
export const area = (v) => nf(2).format(Number(v || 0))
export const num = (v, d = 0) => nf(d).format(Number(v || 0))

// 大额金额显示成 万 / 亿，概览指标卡用
export function moneyShort(v) {
  const n = Number(v || 0)
  const abs = Math.abs(n)
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
  return money(n)
}

export const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`)

export const today = () => new Date().toISOString().slice(0, 10)

export function monthStart(d = new Date()) {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`
}

export function monthLabel(s) {
  if (!s) return ''
  const [y, m] = String(s).split('-')
  return `${y}年${Number(m)}月`
}

export const shortMonth = (s) => (s ? `${Number(String(s).split('-')[1])}月` : '')

export const dateStr = (s) => (s ? String(s).slice(0, 10) : '—')

export function floorLabel(f) {
  const n = Number(f)
  return n < 0 ? `B${Math.abs(n)}层` : `${n}层`
}
