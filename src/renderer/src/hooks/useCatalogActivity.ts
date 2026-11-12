import { useEffect, useRef, useState } from 'react'
import type { ApiErrorCode, ImportKind, SyncView } from '@shared/api'
import { useCatalog } from '../store/catalog'
import { useStackStore } from '../store/stack'
import { useWorkflow } from '../store/workflow'

/** Sequential Main-only status polling also notices completion of native-menu/cron work. */
export function useCatalogActivity() {
  const [status, setStatus] = useState<SyncView | null>(null)
  const [pollError, setPollError] = useState<ApiErrorCode | null>(null)
  const [commandError, setCommandError] = useState<ApiErrorCode | null>(null)
  const [starting, setStarting] = useState(false)
  const [revision, setRevision] = useState(0)
  const startingRef = useRef(false)
  const completed = useRef('')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let active = false
      try {
        const result = await window.electronAPI.sync.status()
        if (!current) return
        if (result.ok) {
          setStatus(result.value); setPollError(null)
          active = result.value.active !== null
          const signature = [result.value.lastSync, result.value.lastImport]
            .filter(op => op && ['completed', 'cancelled', 'failed'].includes(op.phase)).map(op => `${op!.id}:${op!.phase}`).join('|')
          if (signature && completed.current !== signature) {
            useCatalog.getState().refresh()
            useStackStore.getState().refresh()
            useWorkflow.getState().refresh()
          }
          completed.current = signature
        } else setPollError(result.error.code)
      } catch { if (current) setPollError('UNAVAILABLE') }
      if (current) timer = setTimeout(() => { void poll() }, active ? 1000 : 3000)
    }
    void poll()
    return () => { current = false; clearTimeout(timer) }
  }, [revision])
  const importFile = async (kind: ImportKind): Promise<void> => {
    if (startingRef.current) return
    startingRef.current = true; setStarting(true); setCommandError(null)
    try {
      const result = await window.electronAPI.sync.importFile({ kind })
      if (mounted.current) {
        if (result.ok) {
          setStatus(previous => previous ? { ...previous, active: result.value, lastImport: result.value } : previous)
          setRevision(value => value + 1)
        } else setCommandError(result.error.code)
      }
    } catch { if (mounted.current) setCommandError('UNAVAILABLE') }
    finally { startingRef.current = false; if (mounted.current) setStarting(false) }
  }
  const cancel = async (): Promise<void> => {
    if (!status?.active) return
    setCommandError(null)
    try {
      const result = await window.electronAPI.sync.cancel({ operationId: status.active.id })
      if (mounted.current) {
        if (!result.ok) setCommandError(result.error.code)
        setRevision(value => value + 1)
      }
    } catch { if (mounted.current) setCommandError('UNAVAILABLE') }
  }
  return { status, error: commandError ?? pollError, starting, importFile, cancel }
}
