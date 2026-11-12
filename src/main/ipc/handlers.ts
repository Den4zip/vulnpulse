import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { type ApiResult, type IPC_CHANNELS } from '@shared/api'
import { failure, ServiceError } from '../services/errors'

type Channel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

/** Shared transport guard, never exposed as a generic bridge method. */
export function installHandlers(operations: readonly (readonly [Channel, (input: unknown) => unknown])[],
  trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  const installed: Channel[] = []
  try {
    for (const [channel, operation] of operations) {
      const failed = (error: unknown) => failure(error instanceof ServiceError ? error.code : 'INTERNAL_ERROR')
      ipcMain.handle(channel, (event, ...args: unknown[]): ApiResult<unknown> | Promise<ApiResult<unknown>> => {
        try { if (!trusted(event)) return failure('FORBIDDEN') } catch { return failure('FORBIDDEN') }
        if (args.length > 1) return failure('INVALID_ARGUMENT')
        try {
          const result = operation(args[0])
          return result instanceof Promise ? result.then(value => ({ ok: true as const, value }), failed) : { ok: true, value: result }
        } catch (error) { return failed(error) }
      })
      installed.push(channel)
    }
  } catch (error) {
    for (const channel of installed) ipcMain.removeHandler(channel)
    throw error
  }
  return () => { for (const channel of installed) ipcMain.removeHandler(channel) }
}
