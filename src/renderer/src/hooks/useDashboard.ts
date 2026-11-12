import { useCallback } from 'react'
import { useApiResource } from './useApiResource'

export function useDashboard(revision: number, activityVersion: string) {
  const request = useCallback(() => window.electronAPI.dashboard.get(), [revision, activityVersion])
  return useApiResource(request)
}
