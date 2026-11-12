import { app, BrowserWindow, safeStorage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { DB_FILENAME, initDb } from './db'
import { createFstecAdapter } from './services/feeds/fstec-runtime'
import { installFstecMenu } from './services/feeds/fstec-menu'
import { importStackConfigFile } from './services/stack/config'
import { OsvAdapter } from './services/feeds/osv'
import { CisaAdapter, CISA_KEV_URL } from './services/feeds/cisa'
import { NvdAdapter, NVD_CVE_URL } from './services/feeds/nvd'
import { FSTEC_MIRROR_URL } from './services/feeds/fstec-data'
import { FeedScheduler } from './services/scheduler'
import { VulnerabilityService } from './services/vulnerabilities'
import { installVulnerabilityIpc } from './ipc/vulnerabilities'
import { protectWindow, trustedRenderer } from './ipc/security'
import { StackService } from './services/stack'
import { installStackIpc } from './ipc/stack'
import { NoteService } from './services/workflow/notes'
import { SlaService } from './services/workflow/sla'
import { installWorkflowIpc } from './ipc/workflow'
import { SettingsService } from './services/settings'
import { KeyVault } from './services/settings/vault'
import { NETWORK_FEEDS } from './services/settings/validation'
import { installSettingsIpc } from './ipc/settings'
import type { StoredSettings } from '../shared/api'
import { ImportService } from './services/imports'
import { nativeImportPicker } from './services/feeds/import-dialog'
import { SyncService } from './services/sync'
import { installSyncIpc } from './ipc/sync'
import { DashboardService } from './services/dashboard'
import { installDashboardIpc } from './ipc/dashboard'

const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = process.env['ELECTRON_RENDERER_URL'] || pathToFileURL(rendererFile).href
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  protectWindow(win, rendererUrl)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(rendererFile)
  }
}

function startApplication(): void {
  const db = initDb(join(app.getPath('userData'), DB_FILENAME))
  const disposeIpc = installVulnerabilityIpc(new VulnerabilityService(db),
    (event) => trustedRenderer(event, mainWindow, rendererUrl))
  const fstec = createFstecAdapter(db)
  const cisa = new CisaAdapter(db)
  let imports: ReturnType<typeof installFstecMenu> | undefined
  let scheduler: FeedScheduler | undefined
  let importService: ImportService | undefined
  const settingsService = new SettingsService(db, new KeyVault(safeStorage), () => !!scheduler?.isRunning || !!importService?.isBusy)
  scheduler = new FeedScheduler(db, [
    { name: 'cisa', source: CISA_KEV_URL, intervalMs: 60 * 60_000, sync: (signal) => cisa.sync(signal) },
    { name: 'nvd', source: NVD_CVE_URL, intervalMs: 2 * 60 * 60_000,
      sync: async (signal) => new NvdAdapter(db, await settingsService.apiKeyForNvd()).sync(signal) },
    { name: 'fstec', source: FSTEC_MIRROR_URL, intervalMs: 24 * 60 * 60_000, sync: (signal) => fstec.syncMirror(signal) }
  ], () => !!importService?.isBusy || settingsService.isWriting)
  const applySettings = (value: StoredSettings): void => scheduler!.configure(NETWORK_FEEDS.map(name => ({
    name, enabled: value.feeds[name].enabled, intervalMs: value.feeds[name].intervalMinutes * 60_000
  })))
  applySettings(settingsService.configuration())
  const unsubscribeSettings = settingsService.subscribe(applySettings)
  const osv = new OsvAdapter(db)
  const importConfig = (path: string, signal: AbortSignal) => importStackConfigFile(db, path, signal)
  importService = new ImportService(nativeImportPicker(() => mainWindow), {
    fstec: (path, signal) => fstec.importFile(path, signal),
    osv: (path, signal) => osv.importFile(path, signal), stack: importConfig
  }, () => !!scheduler?.isRunning || settingsService.isWriting)
  imports = installFstecMenu(fstec, importConfig, osv, scheduler, settingsService, importService)
  const syncService = new SyncService(scheduler, importService, () => settingsService.isWriting)
  const disposeDashboardIpc = installDashboardIpc(new DashboardService(db, () => syncService.status()),
    (event) => trustedRenderer(event, mainWindow, rendererUrl))
  const disposeSyncIpc = installSyncIpc(syncService, (event) => trustedRenderer(event, mainWindow, rendererUrl))
  const disposeStackIpc = installStackIpc(new StackService(db, () => importService?.isBusy ?? false),
    (event) => trustedRenderer(event, mainWindow, rendererUrl))
  const disposeWorkflowIpc = installWorkflowIpc(new NoteService(db), new SlaService(db),
    (event) => trustedRenderer(event, mainWindow, rendererUrl))
  const disposeSettingsIpc = installSettingsIpc(settingsService, (event) => trustedRenderer(event, mainWindow, rendererUrl))
  scheduler.start()
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    disposeIpc()
    disposeStackIpc()
    disposeWorkflowIpc()
    disposeSettingsIpc()
    disposeSyncIpc()
    disposeDashboardIpc()
    syncService.dispose()
    unsubscribeSettings()
    void Promise.allSettled([scheduler!.dispose(), imports!.dispose(), settingsService.dispose()]).then(() => { db.$client.close(); app.quit() })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  void app.whenReady().then(startApplication)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
