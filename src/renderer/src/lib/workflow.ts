import type { ApiErrorCode, SlaEntry } from '@shared/api'

/** Presentation/transport conversion only. SLA state and validity of commands remain Main-owned. */
export function inputToUtc(value: string): string | null {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  if (!parts) return null
  const canonical = `${parts[1]}:${parts[2] ?? '00'}.${(parts[3] ?? '').padEnd(3, '0')}Z`
  const time = Date.parse(canonical)
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? canonical : null
}
export function utcToInput(value: string): string {
  return value.endsWith('Z') && inputToUtc(value.slice(0, -1)) === value ? value.slice(0, -1) : ''
}
export function workflowTime(value: string): string {
  // Old note timestamps use SQLite's UTC datetime format; SLA legacy values are shown literally.
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
}
export const slaLabels: Record<SlaEntry['state'], string> = { open: 'Открыт', overdue: 'Просрочен', completed: 'Исполнен', unknown: 'Не определено' }
export function workflowWriteError(code: ApiErrorCode): string {
  if (code === 'CONFLICT') return 'Запись изменилась. Перечитайте её перед повторной отправкой; черновик сохранён.'
  if (code === 'NOT_FOUND') return 'Запись или уязвимость больше не найдена. Закройте форму и обновите данные.'
  if (code === 'INVALID_ARGUMENT') return 'Проверьте текст и даты UTC. Время исполнения не должно быть в будущем; срок и текст обязательны для соответствующей формы.'
  if (code === 'FORBIDDEN') return 'Доступ к записи запрещён.'
  if (code === 'BUSY') return 'Операция временно недоступна. Повторите позже.'
  return 'Изменение не подтверждено. Проверьте сохранённые данные перед повтором; автоматическая повторная отправка не выполняется.'
}
