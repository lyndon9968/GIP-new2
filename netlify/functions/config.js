// 下发 Supabase 连接信息，用户无需自行配置 URL 与 Key
export default async () => {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    return Response.json(
      { error: '服务端未配置 SUPABASE_URL / SUPABASE_ANON_KEY' },
      { status: 500 }
    )
  }

  return Response.json(
    { url, anonKey, appName: process.env.APP_NAME || '谷川高科' },
    { headers: { 'Cache-Control': 'public, max-age=300' } }
  )
}
