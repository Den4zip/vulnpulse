import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { SettingsService } from '../services/settings'
import { installHandlers } from './handlers'

export function installSettingsIpc(service: SettingsService, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([
    [IPC_CHANNELS.settingsGet, input => service.get(input)],
    [IPC_CHANNELS.settingsUpdate, input => service.update(input)],
    [IPC_CHANNELS.settingsSetNvdKey, input => service.setNvdApiKey(input)],
    [IPC_CHANNELS.settingsRemoveNvdKey, input => service.removeNvdApiKey(input)]
  ], trusted)
}
