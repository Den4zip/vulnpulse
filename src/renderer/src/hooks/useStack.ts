import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiErrorCode, ApiResult, StackEntry, StackQuery } from '@shared/api'
import { useApiResource } from './useApiResource'
import { useStackStore } from '../store/stack'

export function useStack(query: StackQuery, revision: number) {
  const request = useCallback(() => window.electronAPI.stack.list(query), [query, revision])
  return useApiResource(request)
}

export function useStackEntry(id: number | null) {
  const [generation, setGeneration] = useState(0)
  const request = useCallback((): Promise<ApiResult<StackEntry | null>> => id === null
    ? Promise.resolve({ ok: true, value: null }) : window.electronAPI.stack.get(id), [id, generation])
  const resource = useApiResource(request)
  const reload = useCallback(() => setGeneration(value => value + 1), [])
  return { ...resource, generation, reload }
}

/** A late write can invalidate the list, but must not close or overwrite a new editor. */
export function useStackCommand() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiErrorCode | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async <T>(request: () => Promise<ApiResult<T>>, saved: (value: T) => void): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const result = await request()
      if (mounted.current) {
        if (result.ok) saved(result.value)
        else setError(result.error.code)
      }
    } catch { if (mounted.current) setError('UNAVAILABLE') }
    finally {
      // Even an unavailable response may follow a committed operation. Read back, never infer rollback.
      useStackStore.getState().refresh()
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, run }
}
