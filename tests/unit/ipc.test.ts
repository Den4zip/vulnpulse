import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import { VulnStatus } from '@shared/enums'
import { ServiceError } from '@main/services/errors'
import { installVulnerabilityIpc } from '@main/ipc/vulnerabilities'
import { protectWindow, sameDocument, trustedRenderer } from '@main/ipc/security'
import type { VulnerabilityService } from '@main/services/vulnerabilities'
import { installStackIpc } from '@main/ipc/stack'
import type { StackService } from '@main/services/stack'
import { installWorkflowIpc } from '@main/ipc/workflow'
import type { NoteService } from '@main/services/workflow/notes'
import type { SlaService } from '@main/services/workflow/sla'
import { installSettingsIpc } from '@main/ipc/settings'
import type { SettingsService } from '@main/services/settings'
import { installSyncIpc } from '@main/ipc/sync'
import type { SyncService } from '@main/services/sync'
import { installDashboardIpc } from '@main/ipc/dashboard'
import type { DashboardService } from '@main/services/dashboard'

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      if (state.handlers.has(channel)) throw new Error('already registered')
      state.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => { state.handlers.delete(channel) }
  },
  ipcRenderer: { invoke: state.invoke },
  contextBridge: { exposeInMainWorld: state.expose }
}))

afterEach(() => { state.handlers.clear(); vi.clearAllMocks() })
const fakeService = () => ({ list: vi.fn().mockReturnValue({ items: [], total: 0 }), get: vi.fn(), setStatus: vi.fn() })
const vulnerabilityChannels = [IPC_CHANNELS.vulnerabilityList, IPC_CHANNELS.vulnerabilityGet, IPC_CHANNELS.vulnerabilitySetStatus]
const stackChannels = [IPC_CHANNELS.stackList, IPC_CHANNELS.stackGet, IPC_CHANNELS.stackCreate, IPC_CHANNELS.stackUpdate, IPC_CHANNELS.stackRemove]
const workflowChannels = [IPC_CHANNELS.notesList, IPC_CHANNELS.notesGet, IPC_CHANNELS.notesCreate, IPC_CHANNELS.notesUpdate,
  IPC_CHANNELS.notesRemove, IPC_CHANNELS.slaGet, IPC_CHANNELS.slaSet, IPC_CHANNELS.slaRemove]
const settingsChannels = [IPC_CHANNELS.settingsGet, IPC_CHANNELS.settingsUpdate, IPC_CHANNELS.settingsSetNvdKey, IPC_CHANNELS.settingsRemoveNvdKey]
const call = (channel: string, ...args: any[]) => state.handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)

describe('IPC transport', () => {
  it('guards the dashboard before reads, rejects extra arguments and removes its handler', () => {
    const service = { get: vi.fn(() => ({ total: 0 })) }
    const trusted = vi.fn(() => false)
    const dispose = installDashboardIpc(service as unknown as DashboardService, trusted)
    expect(call(IPC_CHANNELS.dashboardGet)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(service.get).not.toHaveBeenCalled()
    trusted.mockReturnValue(true)
    expect(call(IPC_CHANNELS.dashboardGet)).toEqual({ ok: true, value: { total: 0 } })
    expect(call(IPC_CHANNELS.dashboardGet, {}, {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(service.get).toHaveBeenCalledOnce()
    dispose()
    expect(state.handlers.size).toBe(0)
  })
  it('guards all sync commands before service access, validates arity and disposes handlers', () => {
    const service = { status: vi.fn(), start: vi.fn(), importFile: vi.fn(), cancel: vi.fn() }
    const trusted = vi.fn(() => true)
    const channels = [IPC_CHANNELS.syncStatus, IPC_CHANNELS.syncStart, IPC_CHANNELS.syncImportFile, IPC_CHANNELS.syncCancel]
    const dispose = installSyncIpc(service as unknown as SyncService, trusted)
    for (const [index, method] of [service.status, service.start, service.importFile, service.cancel].entries()) {
      method.mockReturnValueOnce({ index })
      expect(call(channels[index], { input: index })).toEqual({ ok: true, value: { index } })
      expect(method).toHaveBeenCalledWith({ input: index })
      expect(call(channels[index], {}, {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
    trusted.mockReturnValue(false)
    for (const channel of channels) expect(call(channel)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    for (const method of Object.values(service)) expect(method).toHaveBeenCalledTimes(1)
    dispose()
    expect(state.handlers.size).toBe(0)
  })
  it('awaits settings operations and sanitizes rejected crypto/SQL exceptions', async () => {
    const service = { get: vi.fn(), update: vi.fn(), setNvdApiKey: vi.fn(), removeNvdApiKey: vi.fn() }
    const trusted = vi.fn(() => true)
    const dispose = installSettingsIpc(service as unknown as SettingsService, trusted)
    const methods = [service.get, service.update, service.setNvdApiKey, service.removeNvdApiKey]
    for (const [index, channel] of settingsChannels.entries()) {
      methods[index].mockResolvedValueOnce({ metadata: index })
      expect(await call(channel, { payload: index })).toEqual({ ok: true, value: { metadata: index } })
      expect(methods[index]).toHaveBeenCalledWith({ payload: index })
    }
    service.setNvdApiKey.mockRejectedValueOnce(new Error('provider exception with plaintext must stay private'))
    expect(await call(IPC_CHANNELS.settingsSetNvdKey)).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить операцию.' } })
    service.setNvdApiKey.mockRejectedValueOnce(new ServiceError('UNAVAILABLE'))
    expect(await call(IPC_CHANNELS.settingsSetNvdKey)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    trusted.mockReturnValue(false)
    for (const channel of settingsChannels) expect(await call(channel)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(service.removeNvdApiKey).toHaveBeenCalledTimes(1)
    dispose()
    expect(state.handlers.size).toBe(0)
  })
  it('registers only fixed channels and forwards one payload after authorization', () => {
    const service = fakeService()
    const guard = vi.fn().mockReturnValue(true)
    const dispose = installVulnerabilityIpc(service as unknown as VulnerabilityService, guard)
    expect([...state.handlers.keys()]).toEqual(vulnerabilityChannels)
    expect(call(IPC_CHANNELS.vulnerabilityList, { limit: 2 })).toEqual({ ok: true, value: { items: [], total: 0 } })
    expect(service.list).toHaveBeenCalledWith({ limit: 2 })
    call(IPC_CHANNELS.vulnerabilityGet, { id: 1 })
    call(IPC_CHANNELS.vulnerabilitySetStatus, { id: 1, status: VulnStatus.Patched })
    expect(service.get).toHaveBeenCalledWith({ id: 1 })
    expect(service.setStatus).toHaveBeenCalledWith({ id: 1, status: VulnStatus.Patched })
    expect(guard).toHaveBeenCalledTimes(3)
    expect(call(IPC_CHANNELS.vulnerabilityList, {}, {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(service.list).toHaveBeenCalledTimes(1)
    dispose(); dispose()
    expect(state.handlers.size).toBe(0)
  })

  it('denies untrusted or disappeared senders before any service access', () => {
    const service = fakeService()
    const guard = vi.fn().mockReturnValue(false)
    installVulnerabilityIpc(service as unknown as VulnerabilityService, guard)
    for (const channel of vulnerabilityChannels) expect(call(channel)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    guard.mockImplementation(() => { throw new Error('frame disappeared') })
    expect(call(IPC_CHANNELS.vulnerabilityList)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
    expect(service.setStatus).not.toHaveBeenCalled()
  })

  it('serializes only safe error codes/messages and never SQL/errors/stack/payload', () => {
    const service = fakeService()
    installVulnerabilityIpc(service as unknown as VulnerabilityService, () => true)
    for (const code of ['NOT_FOUND', 'INVALID_ARGUMENT'] as const) {
      service.get.mockImplementation(() => { throw new ServiceError(code) })
      expect(call(IPC_CHANNELS.vulnerabilityGet, { id: 1 })).toMatchObject({ ok: false, error: { code } })
    }
    for (const error of [new Error('SELECT raw_json apiKey=secret'), 'payload', null]) {
      service.get.mockImplementation(() => { throw error })
      expect(call(IPC_CHANNELS.vulnerabilityGet)).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить операцию.' } })
    }
  })

  it('cleans partially registered channels if a registration fails', () => {
    state.handlers.set(IPC_CHANNELS.vulnerabilityGet, () => 'keep-existing')
    expect(() => installVulnerabilityIpc(fakeService() as unknown as VulnerabilityService, () => true)).toThrow('already registered')
    expect([...state.handlers.keys()]).toEqual([IPC_CHANNELS.vulnerabilityGet])
  })

  it('routes all stack methods through the same guard and safe errors and disposes independently', () => {
    const stack = { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const guard = vi.fn(() => true)
    const disposeVulnerabilities = installVulnerabilityIpc(fakeService() as unknown as VulnerabilityService, guard)
    const disposeStack = installStackIpc(stack as unknown as StackService, guard)
    expect([...state.handlers.keys()]).toEqual([...vulnerabilityChannels, ...stackChannels])
    for (const [index, method] of (['list', 'get', 'create', 'update', 'remove'] as const).entries()) {
      stack[method].mockReturnValueOnce({ test: method })
      expect(call(stackChannels[index], { test: index })).toEqual({ ok: true, value: { test: method } })
      expect(stack[method]).toHaveBeenCalledWith({ test: index })
    }
    for (const code of ['CONFLICT', 'BUSY'] as const) {
      stack.update.mockImplementationOnce(() => { throw new ServiceError(code) })
      expect(call(IPC_CHANNELS.stackUpdate)).toMatchObject({ ok: false, error: { code } })
    }
    guard.mockReturnValue(false)
    for (const channel of stackChannels) expect(call(channel)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(stack.create).toHaveBeenCalledTimes(1)
    expect(stack.remove).toHaveBeenCalledTimes(1)
    disposeStack()
    expect([...state.handlers.keys()]).toEqual(vulnerabilityChannels)
    disposeVulnerabilities()
    expect(state.handlers.size).toBe(0)
  })

  it('guards all workflow channels, forwards commands and removes only its own handlers', () => {
    const notes = { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const sla = { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
    const guard = vi.fn(() => true)
    const disposeV = installVulnerabilityIpc(fakeService() as unknown as VulnerabilityService, guard)
    const dispose = installWorkflowIpc(notes as unknown as NoteService, sla as unknown as SlaService, guard)
    const methods = [notes.list, notes.get, notes.create, notes.update, notes.remove, sla.get, sla.set, sla.remove]
    for (const [index, channel] of workflowChannels.entries()) {
      methods[index].mockReturnValueOnce({ forwarded: index })
      expect(call(channel, { input: index })).toEqual({ ok: true, value: { forwarded: index } })
      expect(methods[index]).toHaveBeenCalledWith({ input: index })
    }
    guard.mockReturnValue(false)
    for (const channel of workflowChannels) expect(call(channel, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    for (const method of methods) expect(method).toHaveBeenCalledTimes(1)
    dispose()
    expect([...state.handlers.keys()]).toEqual(vulnerabilityChannels)
    disposeV()
    expect(state.handlers.size).toBe(0)
  })
})

const expectedUrl = 'file:///D:/project/out/renderer/index.html'
const fakeWindow = () => {
  const handlers = new Map<string, (event: any) => void>()
  const frame = { url: expectedUrl, origin: 'null', detached: false }
  const contents = {
    mainFrame: frame, getURL: vi.fn(() => expectedUrl), isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(), on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() }
  }
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) }
  const event = { sender: contents, senderFrame: frame }
  return { window, contents, frame, event, handlers }
}
const trust = (f: ReturnType<typeof fakeWindow>, url = expectedUrl) => trustedRenderer(f.event as unknown as IpcMainInvokeEvent, f.window as unknown as BrowserWindow, url)

describe('Renderer authorization and window policy', () => {
  it('requires the controlled window and its live main frame, exact document and origin', () => {
    const f = fakeWindow()
    expect(trust(f)).toBe(true)
    f.frame.origin = 'file://'
    expect(trust(f)).toBe(true)
    f.frame.url += '#details'
    expect(trust(f)).toBe(true)
    f.frame.url = 'file:///D:/other.html'
    expect(trust(f)).toBe(false)
    f.frame.url = expectedUrl
    f.frame.origin = 'https://evil.test'
    expect(trust(f)).toBe(false)
  })

  it('rejects other windows, matching-URL subframes, null/detached/destroyed frames and races', () => {
    const f = fakeWindow()
    const event = f.event as any
    expect(trustedRenderer(event, null, expectedUrl)).toBe(false)
    f.window.isDestroyed.mockReturnValueOnce(true)
    expect(trust(f)).toBe(false)
    f.contents.isDestroyed.mockReturnValueOnce(true)
    expect(trust(f)).toBe(false)
    event.sender = fakeWindow().contents
    expect(trust(f)).toBe(false)
    event.sender = f.contents
    event.senderFrame = { ...f.frame }
    expect(trust(f)).toBe(false)
    event.senderFrame = null
    expect(trust(f)).toBe(false)
    event.senderFrame = f.frame
    f.frame.detached = true
    expect(trust(f)).toBe(false)
    f.frame.detached = false
    f.contents.getURL.mockReturnValueOnce('about:blank')
    expect(trust(f)).toBe(false)
    f.contents.getURL.mockImplementationOnce(() => { throw new Error('destroyed') })
    expect(trust(f)).toBe(false)
  })

  it('pins development origin and path instead of accepting a hostname prefix', () => {
    const f = fakeWindow()
    f.frame.url = 'http://localhost:5173/'
    f.frame.origin = 'http://localhost:5173'
    f.contents.getURL.mockReturnValue(f.frame.url)
    expect(trust(f, f.frame.url)).toBe(true)
    f.frame.origin = 'http://localhost:5174'
    expect(trust(f, f.frame.url)).toBe(false)
    expect(sameDocument('http://localhost:5173.evil.test/', 'http://localhost:5173/')).toBe(false)
  })

  it.each(['about:blank', 'data:text/html,test', 'blob:https://example.org/id', 'javascript:alert(1)', 'file:///D:/project/out/renderer/index.html?different', 'invalid'])('rejects unexpected documents: %s', (url) => {
    expect(sameDocument(url, expectedUrl)).toBe(false)
    expect(sameDocument(url, url)).toBe(url.startsWith('file:'))
  })

  it('blocks navigation, popups, subframes, webviews and permissions by default', () => {
    const f = fakeWindow()
    protectWindow(f.window as unknown as BrowserWindow, expectedUrl)
    expect(f.contents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.org' })).toEqual({ action: 'deny' })
    const blocked = { url: 'https://example.org', isMainFrame: true, preventDefault: vi.fn() }
    f.handlers.get('will-navigate')!(blocked)
    expect(blocked.preventDefault).toHaveBeenCalledOnce()
    const allowed = { url: expectedUrl, isMainFrame: true, preventDefault: vi.fn() }
    f.handlers.get('will-navigate')!(allowed)
    f.handlers.get('will-frame-navigate')!(allowed)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    f.handlers.get('will-frame-navigate')!({ ...allowed, isMainFrame: false })
    expect(allowed.preventDefault).toHaveBeenCalledOnce()
    f.handlers.get('will-attach-webview')!(blocked)
    expect(blocked.preventDefault).toHaveBeenCalledTimes(2)
    expect(f.contents.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const callback = vi.fn()
    f.contents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'geolocation', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
})

describe('Preload bridge', () => {
  it('exposes dedicated methods and converts transport failures to a safe result', async () => {
    await import('../../src/preload/index')
    const [name, api] = state.expose.mock.calls[0]
    expect(name).toBe('electronAPI')
    expect(Object.keys(api)).toEqual(['ping', 'dashboard', 'vulnerabilities', 'stack', 'notes', 'sla', 'settings', 'sync'])
    expect(Object.keys(api.vulnerabilities)).toEqual(['list', 'get', 'setStatus'])
    expect(api.ping()).toBe('VulnPulse preload ready')
    const result = { ok: true, value: { items: [], total: 0 } }
    state.invoke.mockResolvedValue(result)
    expect(Object.keys(api.dashboard)).toEqual(['get'])
    expect(await api.dashboard.get()).toEqual(result)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.dashboardGet, undefined)
    expect(await api.vulnerabilities.list({ limit: 2 })).toEqual(result)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.vulnerabilityList, { limit: 2 })
    await api.vulnerabilities.get(7)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.vulnerabilityGet, { id: 7 })
    await api.vulnerabilities.setStatus(7, VulnStatus.Patched)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.vulnerabilitySetStatus, { id: 7, status: VulnStatus.Patched })
    expect(Object.keys(api.stack)).toEqual(['list', 'get', 'create', 'update', 'remove'])
    await api.stack.list({ limit: 3 })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.stackList, { limit: 3 })
    await api.stack.get(8)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.stackGet, { id: 8 })
    const component = { name: 'demo' }
    await api.stack.create(component)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.stackCreate, component)
    const command = { id: 8, expectedUpdatedAt: 'revision', component }
    await api.stack.update(command)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.stackUpdate, command)
    const removal = { id: 8, expectedUpdatedAt: 'revision' }
    await api.stack.remove(removal)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.stackRemove, removal)
    expect(Object.keys(api.notes)).toEqual(['list', 'get', 'create', 'update', 'remove'])
    expect(Object.keys(api.sla)).toEqual(['get', 'set', 'remove'])
    await api.notes.list({ vulnerabilityId: 9 })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.notesList, { vulnerabilityId: 9 })
    await api.notes.get(10)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.notesGet, { id: 10 })
    const note = { vulnerabilityId: 9, body: 'Plain text' }
    await api.notes.create(note)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.notesCreate, note)
    const noteEdit = { id: 10, expectedRevision: 1, body: 'Edited' }
    await api.notes.update(noteEdit)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.notesUpdate, noteEdit)
    const noteRemove = { id: 10, expectedRevision: 2 }
    await api.notes.remove(noteRemove)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.notesRemove, noteRemove)
    await api.sla.get(9)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.slaGet, { vulnerabilityId: 9 })
    const slaWrite = { vulnerabilityId: 9, dueAt: '2026-12-01T00:00:00.000Z', patchedAt: null, expected: null }
    await api.sla.set(slaWrite)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.slaSet, slaWrite)
    const slaRemove = { vulnerabilityId: 9, expected: { id: 11, revision: 1 } }
    await api.sla.remove(slaRemove)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.slaRemove, slaRemove)
    expect(Object.keys(api.settings)).toEqual(['get', 'update', 'setNvdApiKey', 'removeNvdApiKey'])
    await api.settings.get()
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsGet, undefined)
    const options = { expectedRevision: 1, feeds: {} }
    await api.settings.update(options)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsUpdate, options)
    const key = { expectedRevision: 1, apiKey: 'fixture' }
    await api.settings.setNvdApiKey(key)
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsSetNvdKey, key)
    await api.settings.removeNvdApiKey({ expectedRevision: 2 })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsRemoveNvdKey, { expectedRevision: 2 })
    expect(Object.keys(api.sync)).toEqual(['status', 'start', 'importFile', 'cancel'])
    await api.sync.status()
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.syncStatus, undefined)
    await api.sync.start({ feed: 'cisa' })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.syncStart, { feed: 'cisa' })
    await api.sync.importFile({ kind: 'osv' })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.syncImportFile, { kind: 'osv' })
    await api.sync.cancel({ operationId: 'fixture-id' })
    expect(state.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.syncCancel, { operationId: 'fixture-id' })
    state.invoke.mockRejectedValue(new Error('ipc error includes secret'))
    expect(await api.dashboard.get()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await api.vulnerabilities.list()).toEqual({ ok: false, error: { code: 'UNAVAILABLE', message: 'Сервис недоступен.' } })
    expect(await api.stack.list()).toEqual({ ok: false, error: { code: 'UNAVAILABLE', message: 'Сервис недоступен.' } })
    expect(await api.notes.get(10)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await api.sla.get(9)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await api.settings.get()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(await api.sync.status()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  })
})
