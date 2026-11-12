import { Severity, VulnStatus, type FeedName } from '@shared/enums'
import type { ApiErrorCode } from '@shared/api'

export const statusLabels: Record<VulnStatus, string> = {
  [VulnStatus.New]: 'Новая', [VulnStatus.Analyzing]: 'Анализируется', [VulnStatus.Affected]: 'Затронута',
  [VulnStatus.InProgress]: 'В работе', [VulnStatus.Patched]: 'Исправлена', [VulnStatus.FalsePositive]: 'Ложное срабатывание'
}
export const severityLabels: Record<Severity, string> = {
  [Severity.Critical]: 'Критическая', [Severity.High]: 'Высокая', [Severity.Medium]: 'Средняя',
  [Severity.Low]: 'Низкая', [Severity.None]: 'None · 0'
}
export const feedLabels: Record<FeedName, string> = { nvd: 'NVD', osv: 'OSV', cisa: 'CISA KEV', fstec: 'БДУ ФСТЭК' }
const errors: Record<ApiErrorCode, string> = {
  INVALID_ARGUMENT: 'Проверьте параметры запроса.', NOT_FOUND: 'Запись больше не найдена. Обновите каталог.',
  CONFLICT: 'Данные изменились. Обновите их и повторите действие.', BUSY: 'Дождитесь завершения текущей операции.',
  FORBIDDEN: 'Доступ к данным запрещён.', INTERNAL_ERROR: 'Не удалось выполнить операцию. Повторите попытку.',
  UNAVAILABLE: 'Сервис недоступен. Повторите попытку.'
}
export function errorText(code: ApiErrorCode): string { return errors[code] ?? errors.INTERNAL_ERROR }
const plurals = new Intl.PluralRules('ru-RU')
export function recordCount(count: number): string {
  const form = plurals.select(count)
  return `${count.toLocaleString('ru-RU')} ${form === 'one' ? 'запись' : form === 'few' ? 'записи' : 'записей'}`
}
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
export function displayDate(value: string | null): string {
  if (!value) return 'Нет данных'
  const time = Date.parse(value)
  return Number.isFinite(time) ? dateFormat.format(time) : 'Нет данных'
}
