import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { DashboardService } from '../services/dashboard'
import { installHandlers } from './handlers'

export function installDashboardIpc(service: DashboardService,
  trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([[IPC_CHANNELS.dashboardGet, input => service.get(input)]], trusted)
}
