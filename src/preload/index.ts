import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type ApiResult, type ElectronAPI } from '../shared/api'

async function invoke<T>(channel: typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS], input: unknown): Promise<ApiResult<T>> {
  try { return await ipcRenderer.invoke(channel, input) as ApiResult<T> } catch {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Сервис недоступен.' } }
  }
}

const api: ElectronAPI = {
  ping: () => 'VulnPulse preload ready',
  dashboard: { get: () => invoke(IPC_CHANNELS.dashboardGet, undefined) },
  vulnerabilities: {
    list: (query) => invoke(IPC_CHANNELS.vulnerabilityList, query),
    get: (id) => invoke(IPC_CHANNELS.vulnerabilityGet, { id }),
    setStatus: (id, status) => invoke(IPC_CHANNELS.vulnerabilitySetStatus, { id, status })
  },
  stack: {
    list: (query) => invoke(IPC_CHANNELS.stackList, query),
    get: (id) => invoke(IPC_CHANNELS.stackGet, { id }),
    create: (component) => invoke(IPC_CHANNELS.stackCreate, component),
    update: (command) => invoke(IPC_CHANNELS.stackUpdate, command),
    remove: (command) => invoke(IPC_CHANNELS.stackRemove, command)
  },
  notes: {
    list: (query) => invoke(IPC_CHANNELS.notesList, query),
    get: (id) => invoke(IPC_CHANNELS.notesGet, { id }),
    create: (command) => invoke(IPC_CHANNELS.notesCreate, command),
    update: (command) => invoke(IPC_CHANNELS.notesUpdate, command),
    remove: (command) => invoke(IPC_CHANNELS.notesRemove, command)
  },
  sla: {
    get: (vulnerabilityId) => invoke(IPC_CHANNELS.slaGet, { vulnerabilityId }),
    set: (command) => invoke(IPC_CHANNELS.slaSet, command),
    remove: (command) => invoke(IPC_CHANNELS.slaRemove, command)
  },
  settings: {
    get: () => invoke(IPC_CHANNELS.settingsGet, undefined),
    update: (command) => invoke(IPC_CHANNELS.settingsUpdate, command),
    setNvdApiKey: (command) => invoke(IPC_CHANNELS.settingsSetNvdKey, command),
    removeNvdApiKey: (command) => invoke(IPC_CHANNELS.settingsRemoveNvdKey, command)
  },
  sync: {
    status: () => invoke(IPC_CHANNELS.syncStatus, undefined),
    start: (command) => invoke(IPC_CHANNELS.syncStart, command),
    importFile: (command) => invoke(IPC_CHANNELS.syncImportFile, command),
    cancel: (command) => invoke(IPC_CHANNELS.syncCancel, command)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
