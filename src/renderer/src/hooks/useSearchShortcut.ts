import { useEffect } from 'react'

export function useSearchShortcut(id: string, disabled: boolean) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (disabled || event.defaultPrevented || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') || (!event.ctrlKey && !event.metaKey && event.key === '/')) {
        event.preventDefault(); document.getElementById(id)?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [id, disabled])
}
