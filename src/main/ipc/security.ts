import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

/** File origins alone do not identify a document. Require the exact controlled window/frame and URL. */
export function sameDocument(actual: string, expected: string): boolean {
  try {
    const value = new URL(actual)
    const target = new URL(expected)
    if (!['file:', 'http:', 'https:'].includes(target.protocol)) return false
    value.hash = ''; target.hash = ''
    return value.href === target.href
  } catch { return false }
}

export function trustedRenderer(event: IpcMainInvokeEvent, window: BrowserWindow | null, expectedUrl: string): boolean {
  try {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed()) return false
    const frame = event.senderFrame
    if (!frame || frame.detached || frame !== event.sender.mainFrame) return false
    const target = new URL(expectedUrl)
    const originMatches = target.protocol === 'file:'
      ? frame.origin === 'null' || frame.origin === 'file://'
      : frame.origin === target.origin
    return originMatches && sameDocument(frame.url, expectedUrl) && sameDocument(event.sender.getURL(), expectedUrl)
  } catch { return false }
}

export function protectWindow(window: BrowserWindow, expectedUrl: string): void {
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => { if (!sameDocument(event.url, expectedUrl)) event.preventDefault() })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !sameDocument(event.url, expectedUrl)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => { event.preventDefault() })
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
}
