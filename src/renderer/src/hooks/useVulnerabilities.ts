import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiErrorCode, VulnerabilityQuery } from '@shared/api'
import type { VulnStatus } from '@shared/enums'
import { useApiResource } from './useApiResource'
import { useCatalog } from '../store/catalog'

export function useVulnerabilities(query: VulnerabilityQuery, revision: number) {
  const request = useCallback(() => window.electronAPI.vulnerabilities.list(query), [query, revision])
  return useApiResource(request)
}
export function useVulnerabilityDetail(id: number) {
  const request = useCallback(() => window.electronAPI.vulnerabilities.get(id), [id])
  const resource = useApiResource(request)
  const [saving, setSaving] = useState(false)
  const [writeError, setWriteError] = useState<ApiErrorCode | null>(null)
  const [saved, setSaved] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const save = async (status: VulnStatus): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setSaving(true); setWriteError(null); setSaved(false)
    try {
      const result = await window.electronAPI.vulnerabilities.setStatus(id, status)
      if (result.ok) useCatalog.getState().refresh()
      if (mounted.current) {
        if (result.ok) { resource.reload(); setSaved(true) }
        else setWriteError(result.error.code)
      }
    } catch { if (mounted.current) setWriteError('UNAVAILABLE') }
    finally { pending.current = false; if (mounted.current) setSaving(false) }
  }
  return { ...resource, save, saving, writeError, saved }
}
