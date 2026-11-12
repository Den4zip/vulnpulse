import { BrowserWindow, dialog } from 'electron'
import type { FilePicker } from '../imports'
import { ServiceError } from '../errors'

/** File paths are acquired only in Main, from the controlled window's native dialog. */
export function nativeImportPicker(getWindow?: () => BrowserWindow | null): FilePicker {
  return async kind => {
    const window = getWindow ? getWindow() : BrowserWindow.getFocusedWindow()
    if (getWindow && (!window || window.isDestroyed())) throw new ServiceError('UNAVAILABLE')
    const options = { title: kind === 'stack' ? 'Загрузка локальной конфигурации ПО'
      : kind === 'osv' ? 'Локальный импорт OSV JSON' : 'Импорт XML БДУ ФСТЭК', properties: ['openFile' as const],
      filters: kind === 'stack' ? [{ name: 'Конфигурация стека ПО (JSON)', extensions: ['json'] }]
        : kind === 'osv' ? [{ name: 'OSV JSON', extensions: ['json'] }] : [{ name: 'XML БДУ ФСТЭК', extensions: ['xml', 'gz'] }] }
    const selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (getWindow && (window!.isDestroyed() || getWindow() !== window)) return null
    return selected.canceled ? null : selected.filePaths[0] || null
  }
}
