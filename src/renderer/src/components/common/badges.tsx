import type { Severity, VulnStatus } from '@shared/enums'
import { severityLabels, statusLabels } from '@renderer/lib/presentation'
import { cn } from '@renderer/lib/utils'

export function SeverityBadge({ value }: { value: Severity | null }) {
  return <span className={cn('severity-badge', `severity-${value?.toLowerCase() ?? 'unknown'}`)}>
    <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
    {value === null ? 'Неизвестна' : severityLabels[value]}
  </span>
}
export function StatusBadge({ value }: { value: VulnStatus }) {
  return <span className={cn('status-badge', value === 'Patched' ? 'status-patched' : value === 'New' ? 'status-new' : '')}>{statusLabels[value]}</span>
}
export function KevBadge() { return <span className="kev-badge" title="Включена в каталог известных эксплуатируемых уязвимостей CISA">KEV</span> }
