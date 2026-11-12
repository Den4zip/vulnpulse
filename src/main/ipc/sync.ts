import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { SyncService } from '../services/sync'
import { installHandlers } from './handlers'

export function installSyncIpc(service: SyncService, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([
    [IPC_CHANNELS.syncStatus, input => service.status(input)],
    [IPC_CHANNELS.syncStart, input => service.start(input)],
    [IPC_CHANNELS.syncImportFile, input => service.importFile(input)],
    [IPC_CHANNELS.syncCancel, input => service.cancel(input)]
  ], trusted)
}
