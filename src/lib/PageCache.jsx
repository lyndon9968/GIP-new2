import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

const RefreshContext = createContext(null)
const PageContext = createContext({ active: true, version: 0, path: null })

// Only in-memory page state: a full reload or a different signed-in user starts fresh.
export function PageCacheProvider({ children }) {
  const [versions, setVersions] = useState({})
  const [busy, setBusy] = useState({})
  const markLoading = useCallback((path, loading) => setBusy((v) => v[path] === loading ? v : ({ ...v, [path]: loading })), [])
  const refresh = (path) => setVersions((v) => ({ ...v, [path]: (v[path] || 0) + 1 }))
  return <RefreshContext.Provider value={{ versions, refresh, busy, markLoading }}>{children}</RefreshContext.Provider>
}

export const usePageCache = () => useContext(RefreshContext)
export const usePageActivity = () => useContext(PageContext).active

// Mount on the first visit, then hide instead of unmounting on route/tab changes.
// The hidden attribute also excludes inactive forms from focus and accessibility.
export function CachedPage({ path, active, children }) {
  const parent = useContext(PageContext)
  const cache = usePageCache()
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  if (!active && !visited) return null
  return <section hidden={!active} data-cached-page={path || undefined}>
    <PageContext.Provider value={{ active: parent.active && active,
      path: path || parent.path,
      version: path ? cache.versions[path] || 0 : parent.version }}>
      {children}
    </PageContext.Provider>
  </section>
}

export function useManualRefresh(load, loading = false) {
  const { active, version, path } = useContext(PageContext)
  const cache = usePageCache()
  const markLoading = cache?.markLoading
  useEffect(() => {
    if (active && path) markLoading?.(path, loading)
  }, [active, path, loading, markLoading])
  const latest = useRef(load)
  latest.current = load
  const seen = useRef(version)
  useEffect(() => {
    if (seen.current === version) return
    seen.current = version
    if (active) latest.current()
  }, [version, active])
}
