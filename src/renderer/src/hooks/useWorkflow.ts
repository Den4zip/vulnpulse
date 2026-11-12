import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiErrorCode, ApiResult, NoteEntry, VulnerabilityQuery } from '@shared/api'
import { useWorkflow } from '../store/workflow'
import { useApiResource } from './useApiResource'

export function useWorkflowOwners(query: VulnerabilityQuery, revision: number) {
  const request = useCallback(() => window.electronAPI.vulnerabilities.list(query), [query, revision])
  return useApiResource(request)
}
export function useWorkflowOwner(id: number) {
  const request = useCallback(() => window.electronAPI.vulnerabilities.get(id), [id])
  return useApiResource(request)
}
export function useNotes(ownerId: number, offset: number, revision: number) {
  const request = useCallback(() => window.electronAPI.notes.list({ vulnerabilityId: ownerId, offset, limit: 10, direction: 'desc' }), [ownerId, offset, revision])
  return useApiResource(request)
}
export function useNote(ownerId: number, noteId: number | null) {
  const [generation, setGeneration] = useState(0)
  const request = useCallback(async (): Promise<ApiResult<NoteEntry | null>> => {
    if (noteId === null) return { ok: true, value: null }
    const result = await window.electronAPI.notes.get(noteId)
    return result.ok && result.value.vulnerabilityId !== ownerId
      ? { ok: false, error: { code: 'CONFLICT', message: 'Запись не относится к выбранной уязвимости.' } } : result
  }, [ownerId, noteId, generation])
  const resource = useApiResource(request)
  const reload = useCallback(() => setGeneration(value => value + 1), [])
  return { ...resource, generation, reload }
}
export function useSla(ownerId: number, revision = 0, autoRefresh = false) {
  const [generation, setGeneration] = useState(0)
  const request = useCallback(() => window.electronAPI.sla.get(ownerId), [ownerId, revision, generation])
  const resource = useApiResource(request)
  const reload = useCallback(() => setGeneration(value => value + 1), [])
  useEffect(() => {
    if (!autoRefresh || resource.loading) return
    // Wait for each reply before scheduling another read. Main reevaluates time-dependent state.
    const timer = setTimeout(reload, 30_000)
    return () => clearTimeout(timer)
  }, [autoRefresh, request, resource.loading, reload])
  return { ...resource, generation, reload }
}
export function useWorkflowCommand() {
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
      useWorkflow.getState().refresh()
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, run }
}
