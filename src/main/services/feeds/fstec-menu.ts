import { dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import type { FstecAdapter } from './fstec'
import type { OsvAdapter } from './osv'
import type { StackImportResult } from '../stack/config'
import type { FeedScheduler, ScheduledFeed } from '../scheduler'
import type { SettingsService } from '../settings'
import { ImportService } from '../imports'
import { nativeImportPicker } from './import-dialog'
import type { ImportKind } from '@shared/api'

/** Native Main commands; XML and SQLite never enter Renderer. */
export function installFstecMenu(adapter: FstecAdapter, importConfig?: (path: string, signal: AbortSignal) => Promise<StackImportResult>, osv?: Pick<OsvAdapter, 'importFile'>, scheduler?: FeedScheduler, settings?: Pick<SettingsService, 'isWriting' | 'setFeedEnabled' | 'configuration'>, sharedImports?: ImportService): { dispose: () => Promise<void>; isBusy: () => boolean } {
  const imports = sharedImports ?? new ImportService(nativeImportPicker(), {
    fstec: (path, signal) => adapter.importFile(path, signal),
    ...(osv ? { osv: (path: string, signal: AbortSignal) => osv.importFile(path, signal) } : {}),
    ...(importConfig ? { stack: importConfig } : {})
  }, () => !!scheduler?.isRunning || !!settings?.isWriting)
  let active: AbortController | null = null
  let task: Promise<void> | null = null
  let disposed = false
  const busy = (): boolean => active !== null || imports.isBusy || !!scheduler?.isRunning || !!settings?.isWriting
  const refresh = (): void => {
    Menu.getApplicationMenu()!.getMenuItemById('fstec-file')!.enabled = !busy()
    Menu.getApplicationMenu()!.getMenuItemById('fstec-mirror')!.enabled = !busy()
    Menu.getApplicationMenu()!.getMenuItemById('fstec-cancel')!.enabled = busy()
    const config = Menu.getApplicationMenu()!.getMenuItemById('stack-config')
    if (config) config.enabled = !busy()
    const osvItem = Menu.getApplicationMenu()!.getMenuItemById('osv-file')
    if (osvItem) osvItem.enabled = !busy()
    for (const name of ['cisa', 'nvd', 'fstec'] as const) {
      const manual = Menu.getApplicationMenu()!.getMenuItemById(`sync-${name}`)
      if (manual) manual.enabled = !busy()
      const automatic = Menu.getApplicationMenu()!.getMenuItemById(`auto-${name}`)
      if (automatic) {
        automatic.checked = scheduler!.isEnabled(name)
        if (settings) {
          automatic.enabled = !busy()
          const label = name === 'fstec' ? 'ФСТЭК — неофициальное зеркало GitHub' : name === 'cisa' ? 'CISA KEV' : 'NVD'
          automatic.label = `${label} — интервал ${settings.configuration().feeds[name].intervalMinutes} мин.`
        }
      }
    }
  }
  const runScheduled = (name: ScheduledFeed): void => {
    if (!scheduler || busy() || disposed) return
    task = (async () => {
      try {
        const outcome = await scheduler.run(name)
        if (!disposed) await dialog.showMessageBox({ type: outcome.kind === 'failed' ? 'error' : 'info',
          title: `Синхронизация ${name.toUpperCase()}`,
          message: outcome.kind === 'completed' ? `Обработано записей: ${outcome.result.processed}.`
            : outcome.kind === 'cancelled' ? 'Синхронизация отменена.' : 'Синхронизация не выполнена.',
          detail: 'Состояние: Данные → Состояние обновлений. Применённые страницы NVD сохраняются; незавершённое окно будет перечитано.' })
      } catch {
        if (!disposed) await dialog.showMessageBox({ type: 'error', title: 'Синхронизация', message: 'Не удалось сохранить состояние запуска.' })
      }
    })()
  }
  const runImport = (kind: ImportKind): void => {
    if (busy() || disposed) return
    imports.start(kind)
    task = imports.wait().then(async outcome => {
      if (disposed || (outcome.phase === 'cancelled' && !outcome.cancelRequested)) return
      const label = kind === 'osv' ? 'OSV' : 'ФСТЭК'
      const result = outcome.result
      const success = outcome.phase === 'completed'
      const cancelled = outcome.phase === 'cancelled'
      await dialog.showMessageBox({ type: success || cancelled ? 'info' : 'error',
        title: kind === 'stack' ? 'Локальная конфигурация' : `Импорт ${label}`,
        message: result && 'added' in result ? `Добавлено: ${result.added}. Уже загружено: ${result.skipped}. Всего компонентов: ${result.total}.`
          : result && 'processed' in result ? `Обработано записей: ${result.processed}.${result.warnings ? ` Предупреждений: ${result.warnings}.` : ''}`
            : kind === 'stack' ? cancelled ? 'Загрузка отменена.' : 'Конфигурация не загружена.'
              : cancelled ? 'Импорт отменён.' : `Не удалось импортировать данные ${label}.`,
        detail: success ? (kind === 'fstec' ? '' : 'Сетевые запросы не выполнялись. ')
          + 'Записи сохранены локально. Статусы и заметки пользователя сохранены. Автоматическое сопоставление с фидами пока не подключено.'
          : cancelled ? 'Незавершённый импорт не применён.' : 'Проверьте формат и доступность локального файла.' })
    }).catch(() => { console.error('Import notification failed') })
  }
  const runConfig = (): void => { if (importConfig) runImport('stack') }
  const run = (mirror: boolean, source: 'fstec' | 'osv' = 'fstec'): void => {
    if (busy() || disposed || (source === 'osv' && !osv)) return
    if (!mirror) { runImport(source); return }
    if (scheduler) { runScheduled('fstec'); return }
    // Standalone menu embedding without a scheduler (the application always supplies one).
    const controller = new AbortController()
    active = controller
    refresh()
    task = (async () => {
      try {
        const result = await adapter.syncMirror(controller.signal)
        if (!disposed) await dialog.showMessageBox({ type: 'info', title: 'Импорт ФСТЭК',
          message: result.kind === 'not-modified' ? 'Зеркало не изменилось с прошлого импорта.' : `Обработано записей: ${result.processed}.` })
      } catch {
        if (!disposed) await dialog.showMessageBox({ type: controller.signal.aborted ? 'info' : 'error', title: 'Импорт ФСТЭК',
          message: controller.signal.aborted ? 'Импорт отменён.' : 'Не удалось импортировать данные ФСТЭК.',
          detail: 'Не удалось завершить загрузку зеркала.' })
      } finally { active = null; if (!disposed) refresh() }
    })()
  }
  const template: MenuItemConstructorOptions[] = [
    { label: 'Данные', submenu: [
      ...(importConfig ? [{ id: 'stack-config', label: 'Загрузить локальную конфигурацию ПО…', click: runConfig }, { type: 'separator' as const }] : []),
      ...(osv ? [{ id: 'osv-file', label: 'Импорт OSV из JSON…', click: () => run(false, 'osv') }] : []),
      { id: 'fstec-file', label: 'Импорт ФСТЭК из XML…', click: () => run(false) },
      { id: 'fstec-mirror', label: 'Загрузить ФСТЭК из зеркала…', click: () => run(true) },
      { id: 'fstec-cancel', label: 'Отменить текущую загрузку', enabled: false, click: () => { active?.abort(); imports.cancel(); scheduler?.cancel() } },
      ...(scheduler ? [
        { type: 'separator' as const },
        { id: 'sync-cisa', label: 'Обновить CISA KEV сейчас', click: () => runScheduled('cisa') },
        { id: 'sync-nvd', label: 'Обновить NVD сейчас (первый запуск — весь каталог)', click: () => runScheduled('nvd') },
        { label: settings ? 'Автообновление (сохраняется)' : 'Автообновление на эту сессию', submenu: [
          { label: 'При включении просроченный источник загрузится сразу', enabled: false },
          ...([{ name: 'cisa', label: 'CISA KEV — каждый час' }, { name: 'nvd', label: 'NVD — каждые 2 часа' },
            { name: 'fstec', label: 'ФСТЭК — неофициальное зеркало GitHub, раз в сутки' }] as const).map(({ name, label }) => ({
            id: `auto-${name}`, label, type: 'checkbox' as const, checked: false,
            click: (item: { checked: boolean }) => {
              if (!settings) { scheduler.setEnabled(name, item.checked); return }
              if (busy() || disposed) { refresh(); return }
              task = (async () => { await settings.setFeedEnabled(name, item.checked) })().catch(async () => {
                if (!disposed) await dialog.showMessageBox({ type: 'error', title: 'Настройки', message: 'Не удалось сохранить настройку автообновления.' })
              }).finally(() => { if (!disposed) refresh() })
              refresh()
            }
          }))
        ] },
        { id: 'sync-status', label: 'Состояние обновлений', click: () => {
          const labels: Record<string, string> = { failed: 'Ошибка загрузки', cancelled: 'Отменено', interrupted: 'Предыдущий запуск прерван' }
          void dialog.showMessageBox({ type: 'info', title: 'Состояние обновлений',
            message: settings ? 'Настройки автообновления сохраняются между запусками.' : 'Автообновление действует только до закрытия приложения.',
            detail: scheduler.status().map((state) => `${state.name.toUpperCase()}: ${state.running ? 'Загружается' : state.lastError ? labels[state.lastError] ?? 'Ошибка' : state.lastFinishedAt ? 'Завершено' : 'Ещё не запускалось'}; авто: ${state.enabled ? 'вкл.' : 'выкл.'}\nНачало: ${state.lastStartedAt ?? '—'}\nКонец: ${state.lastFinishedAt ?? '—'}`).join('\n\n') })
        } }
      ] : []),
      { type: 'separator' }, { role: 'quit', label: 'Выход' }
    ] },
    { role: 'editMenu', label: 'Правка' },
    { label: 'Вид', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  const unsubscribe = scheduler?.subscribe(() => { if (!disposed) refresh() })
  const unsubscribeImports = imports.subscribe(() => { if (!disposed) refresh() })
  refresh()
  return { isBusy: () => active !== null || imports.isBusy, dispose: async () => {
    disposed = true; unsubscribe?.(); unsubscribeImports(); active?.abort()
    await imports.dispose()
    await task
  } }
}
