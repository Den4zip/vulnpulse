import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  ping: (): string => 'VulnPulse preload ready'
})
