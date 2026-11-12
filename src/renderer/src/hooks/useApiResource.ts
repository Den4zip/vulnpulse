import { useCallback, useEffect, useState } from 'react'
import type { ApiErrorCode, ApiResult } from '@shared/api'

interface Resource<T> { request: unknown; data: T | null; error: ApiErrorCode | null; loading: boolean }
/** Ignore late responses and never present rows belonging to a previous query. IPC is not abortable. */
export function useApiResource<T>(request: () => Promise<ApiResult<T>>) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<Resource<T>>({ request, data: null, error: null, loading: true })
  const reload = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    let current = true
    setState(previous => ({ request, data: previous.request === request ? previous.data : null, error: null, loading: true }))
    void (async () => {
      try {
        const result = await request()
        if (current) setState({ request, data: result.ok ? result.value : null, error: result.ok ? null : result.error.code, loading: false })
      } catch {
        if (current) setState({ request, data: null, error: 'UNAVAILABLE', loading: false })
      }
    })()
    return () => { current = false }
  }, [request, revision])
  return { ...(state.request === request ? state : { data: null, error: null, loading: true }), reload }
}
