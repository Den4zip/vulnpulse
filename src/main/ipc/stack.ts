import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { StackService } from '../services/stack'
import { installHandlers } from './handlers'

export function installStackIpc(service: StackService, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([
    [IPC_CHANNELS.stackList, (input) => service.list(input)],
    [IPC_CHANNELS.stackGet, (input) => service.get(input)],
    [IPC_CHANNELS.stackCreate, (input) => service.create(input)],
    [IPC_CHANNELS.stackUpdate, (input) => service.update(input)],
    [IPC_CHANNELS.stackRemove, (input) => service.remove(input)]
  ], trusted)
}
