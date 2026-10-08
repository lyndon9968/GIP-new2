import { createClient } from '@supabase/supabase-js'

let client = null
let appName = '谷川高科'

// 从 Netlify Function 取连接信息，用户端不保存也不需要填写 URL / Key
export async function initSupabase() {
  if (client) return client

  const res = await fetch('/api/config')
  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      '当前预览没有运行 Netlify Functions：/api/config 返回了网页而不是服务配置。请使用 Netlify 本地开发命令启动；部署站点则检查 Netlify 环境变量。'
    )
  }
  const cfg = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(cfg?.error || '无法获取服务配置，请联系管理员')
  }
  if (!cfg?.url || !cfg?.anonKey) {
    throw new Error('服务端返回的 Supabase 配置不完整，请检查 Netlify 环境变量。')
  }
  appName = cfg.appName || appName

  client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'gip-auth',
    },
  })
  return client
}

export function sb() {
  if (!client) throw new Error('Supabase 尚未初始化')
  return client
}

export function getAppName() {
  return appName
}

// 调用受保护的服务端接口，自动带上登录态
export async function callApi(path, body) {
  const { data } = await sb().auth.getSession()
  const token = data?.session?.access_token
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`)
  return json
}
