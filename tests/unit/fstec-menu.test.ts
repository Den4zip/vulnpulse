import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FstecAdapter } from '@main/services/feeds/fstec'

const state = vi.hoisted(() => ({ menu: null as any, open: vi.fn(), message: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: state.open, showMessageBox: state.message },
  Menu: {
    buildFromTemplate: (template: any[]) => {
      const find = (items: any[], id: string): any => {
        for (const item of items) {
          if (item.id === id) return item
          if (Array.isArray(item.submenu)) { const found = find(item.submenu, id); if (found) return found }
        }
      }
      return { getMenuItemById: (id: string) => find(template, id) }
    },
    setApplicationMenu: (menu: any) => { state.menu = menu },
    getApplicationMenu: () => state.menu
  }
}))
import { installFstecMenu } from '@main/services/feeds/fstec-menu'
import { initDb } from '@main/db'
import { FeedScheduler } from '@main/services/scheduler'
import { nativeImportPicker } from '@main/services/feeds/import-dialog'
import type { BrowserWindow } from 'electron'

const menuItem = (id: string) => state.menu.getMenuItemById(id)
beforeEach(() => { vi.clearAllMocks(); state.open.mockResolvedValue({ canceled: false, filePaths: ['local.xml'] }); state.message.mockResolvedValue({ response: 0 }) })

describe('FSTEC native commands', () => {
  it('parents IPC file selection to the controlled window and abandons selections from a closed or replaced window', async () => {
    const window = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow
    let current: BrowserWindow | null = window
    const pick = nativeImportPicker(() => current)
    expect(await pick('osv')).toBe('local.xml')
    expect(state.open).toHaveBeenLastCalledWith(window, expect.objectContaining({ title: 'Локальный импорт OSV JSON' }))
    current = null
    await expect(pick('osv')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(state.open).toHaveBeenCalledOnce()
    current = window
    state.open.mockImplementationOnce(async () => { current = null; return { canceled: false, filePaths: ['private.xml'] } })
    expect(await pick('fstec')).toBeNull()
    current = window
    state.open.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await pick('stack')).toBeNull()
    vi.mocked(window.isDestroyed).mockReturnValue(true)
    await expect(pick('osv')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
  it('coordinates scheduled tasks with file selection and exposes session-only toggles/status', async () => {
    const db = initDb(':memory:')
    let controls: ReturnType<typeof installFstecMenu>
    const sync = vi.fn().mockResolvedValue({ processed: 2 })
    const scheduler = new FeedScheduler(db, [{ name: 'cisa', source: 'https://example.org', intervalMs: 3600000, sync },
      { name: 'nvd', source: 'https://example.org', intervalMs: 7200000, sync },
      { name: 'fstec', source: 'https://example.org', intervalMs: 86400000, sync }], () => controls?.isBusy() ?? false)
    controls = installFstecMenu({} as FstecAdapter, undefined, { importFile: vi.fn() }, scheduler)
    try {
      expect(menuItem('auto-cisa').checked).toBe(false)
      expect(menuItem('auto-nvd').checked).toBe(false)
      expect(menuItem('auto-fstec').checked).toBe(false)
      let select!: (value: any) => void
      state.open.mockReturnValueOnce(new Promise((resolve) => { select = resolve }))
      menuItem('osv-file').click()
    expect(controls.isBusy()).toBe(true)
      expect(await scheduler.run('cisa')).toEqual({ kind: 'busy' })
      menuItem('sync-nvd').click()
      await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce())
      select({ canceled: true, filePaths: [] })
      await vi.waitFor(() => expect(controls.isBusy()).toBe(false))
      menuItem('auto-cisa').click({ checked: true })
      expect(scheduler.isEnabled('cisa')).toBe(true)
      menuItem('sync-cisa').click()
      expect(menuItem('osv-file').enabled).toBe(false)
      menuItem('fstec-file').click()
      await vi.waitFor(() => expect(menuItem('osv-file').enabled).toBe(true))
      expect(sync).toHaveBeenCalledOnce()
      menuItem('sync-status').click()
      expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('CISA: Завершено; авто: вкл.') }))
      menuItem('fstec-mirror').click()
      await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    } finally { await scheduler.dispose(); await controls.dispose(); db.$client.close() }
  })

  it('cancels scheduled work through the common cancel command', async () => {
    const db = initDb(':memory:')
    const sync = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })
    }))
    const scheduler = new FeedScheduler(db, [{ name: 'nvd', source: 'https://example.org', intervalMs: 7200000, sync }])
    const controls = installFstecMenu({} as FstecAdapter, undefined, undefined, scheduler)
    try {
      menuItem('sync-nvd').click()
      await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce())
      menuItem('fstec-cancel').click()
      await vi.waitFor(() => expect(scheduler.isRunning).toBe(false))
      expect(scheduler.status()[0].lastError).toBe('cancelled')
      expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ message: 'Синхронизация отменена.' }))
    } finally { await scheduler.dispose(); await controls.dispose(); db.$client.close() }
  })

  it('imports OSV from a JSON selector with an abort signal and blocks other imports', async () => {
    const fstec = { importFile: vi.fn(), syncMirror: vi.fn() }
    const osv = { importFile: vi.fn().mockResolvedValue({ processed: 3 }) }
    const config = vi.fn()
    state.open.mockResolvedValue({ canceled: false, filePaths: ['local.json'] })
    const controls = installFstecMenu(fstec as unknown as FstecAdapter, config, osv)
    menuItem('osv-file').click()
    expect(menuItem('osv-file').enabled).toBe(false)
    expect(menuItem('stack-config').enabled).toBe(false)
    menuItem('fstec-file').click()
    menuItem('stack-config').click()
    await vi.waitFor(() => expect(menuItem('osv-file').enabled).toBe(true))
    expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: 'OSV JSON', extensions: ['json'] }] }))
    expect(osv.importFile).toHaveBeenCalledWith('local.json', expect.any(AbortSignal))
    expect(fstec.importFile).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
    expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ title: 'Импорт OSV', message: 'Обработано записей: 3.', detail: expect.stringContaining('Сетевые запросы не выполнялись') }))
    await controls.dispose()
  })

  it('handles OSV errors and selection cancellation', async () => {
    const osv = { importFile: vi.fn().mockRejectedValue(new Error('Invalid OSV JSON')) }
    const controls = installFstecMenu({} as FstecAdapter, undefined, osv)
    menuItem('osv-file').click()
    await vi.waitFor(() => expect(menuItem('osv-file').enabled).toBe(true))
    expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', title: 'Импорт OSV', message: 'Не удалось импортировать данные OSV.', detail: 'Проверьте формат и доступность локального файла.' }))
    state.open.mockResolvedValue({ canceled: true, filePaths: [] })
    menuItem('osv-file').click()
    await controls.dispose()
    expect(osv.importFile).toHaveBeenCalledTimes(1)
    expect(state.message).toHaveBeenCalledTimes(1)
  })

  it('cancels OSV and waits for it on shutdown without a result dialog', async () => {
    const osv = { importFile: vi.fn((_path: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })) }
    const controls = installFstecMenu({} as FstecAdapter, undefined, osv)
    menuItem('osv-file').click()
    await vi.waitFor(() => expect(osv.importFile).toHaveBeenCalled())
    await controls.dispose()
    expect(osv.importFile.mock.calls[0][1].aborted).toBe(true)
    expect(state.message).not.toHaveBeenCalled()
    menuItem('osv-file').click()
    expect(osv.importFile).toHaveBeenCalledTimes(1)
  })

  it('loads a local inventory config and prevents overlapping FSTEC commands', async () => {
    const api = { importFile: vi.fn(), syncMirror: vi.fn() }
    const load = vi.fn().mockResolvedValue({ added: 4, skipped: 0, total: 4 })
    const controls = installFstecMenu(api as unknown as FstecAdapter, load)
    menuItem('stack-config').click()
    menuItem('fstec-mirror').click()
    expect(menuItem('stack-config').enabled).toBe(false)
    await vi.waitFor(() => expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Добавлено: 4') })))
    expect(load).toHaveBeenCalledWith('local.xml', expect.any(AbortSignal))
    expect(api.syncMirror).not.toHaveBeenCalled()
    await controls.dispose()
  })

  it('handles configuration failure and selection cancellation', async () => {
    const load = vi.fn().mockRejectedValue(new Error('bad config'))
    const controls = installFstecMenu({} as FstecAdapter, load)
    menuItem('stack-config').click()
    await vi.waitFor(() => expect(menuItem('stack-config').enabled).toBe(true))
    expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', detail: 'Проверьте формат и доступность локального файла.' }))
    state.open.mockResolvedValue({ canceled: true, filePaths: [] })
    menuItem('stack-config').click()
    await controls.dispose()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('opens the file selector and imports the selected path with a cancellation signal', async () => {
    const api = { importFile: vi.fn().mockResolvedValue({ processed: 2 }), syncMirror: vi.fn() }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-file').click()
    expect(menuItem('fstec-file').enabled).toBe(false)
    await vi.waitFor(() => expect(state.message).toHaveBeenCalled())
    expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'] }))
    expect(api.importFile).toHaveBeenCalledWith('local.xml', expect.any(AbortSignal))
    await controls.dispose()
    expect(api.syncMirror).not.toHaveBeenCalled()
  })

  it('does not import when the file selector is cancelled', async () => {
    state.open.mockResolvedValue({ canceled: true, filePaths: [] })
    const api = { importFile: vi.fn(), syncMirror: vi.fn() }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-file').click()
    await controls.dispose()
    expect(api.importFile).not.toHaveBeenCalled()
    expect(state.message).not.toHaveBeenCalled()
  })

  it('invokes mirror sync directly and reports an unchanged snapshot', async () => {
    const api = { importFile: vi.fn(), syncMirror: vi.fn().mockResolvedValue({ kind: 'not-modified', processed: 0 }) }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-mirror').click()
    await vi.waitFor(() => expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('не изменилось') })))
    expect(state.open).not.toHaveBeenCalled()
    await controls.dispose()
  })

  it('cancels an active import and suppresses overlapping commands', async () => {
    const api = { importFile: vi.fn(), syncMirror: vi.fn((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })) }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-mirror').click()
    menuItem('fstec-file').click()
    expect(menuItem('fstec-cancel').enabled).toBe(true)
    menuItem('fstec-cancel').click()
    await vi.waitFor(() => expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ message: 'Импорт отменён.' })))
    expect(api.syncMirror).toHaveBeenCalledTimes(1)
    expect(state.open).not.toHaveBeenCalled()
    await controls.dispose()
  })

  it('aborts on shutdown without opening a result dialog', async () => {
    const api = { importFile: vi.fn(), syncMirror: vi.fn((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })) }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-mirror').click()
    await controls.dispose()
    expect(state.message).not.toHaveBeenCalled()
    menuItem('fstec-mirror').click()
    expect(api.syncMirror).toHaveBeenCalledTimes(1)
  })

  it('reports import failures and re-enables the commands', async () => {
    const api = { importFile: vi.fn(), syncMirror: vi.fn().mockRejectedValue(new Error('failed')) }
    const controls = installFstecMenu(api as unknown as FstecAdapter)
    menuItem('fstec-mirror').click()
    await vi.waitFor(() => expect(menuItem('fstec-mirror').enabled).toBe(true))
    expect(state.message).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', detail: 'Не удалось завершить загрузку зеркала.' }))
    await controls.dispose()
  })
})
