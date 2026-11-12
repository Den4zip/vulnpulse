import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { VulnerabilityService } from '../services/vulnerabilities'
import { installHandlers } from './handlers'

/** Transport only. Services own validation, SQL and business operations. */
export function installVulnerabilityIpc(service: VulnerabilityService,
  trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([
    [IPC_CHANNELS.vulnerabilityList, (input: unknown) => service.list(input)],
    [IPC_CHANNELS.vulnerabilityGet, (input: unknown) => service.get(input)],
    [IPC_CHANNELS.vulnerabilitySetStatus, (input: unknown) => service.setStatus(input)]
  ], trusted)
}
