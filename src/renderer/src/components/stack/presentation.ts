import type { ApiErrorCode } from '@shared/api'
import type { StackKind } from '@shared/enums'
import { displayDate } from '@renderer/lib/presentation'

export const kindLabels: Record<StackKind, string> = { application: 'Приложение', system: 'Системное ПО', package: 'Пакет' }

export function stackDate(value: string): string {
  return displayDate(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value)
}

export function stackWriteError(code: ApiErrorCode, action: 'create' | 'update' | 'remove'): string {
  if (code === 'INVALID_ARGUMENT') return 'Проверьте обязательные поля и конкретную версию. Нужен CPE или PURL с теми же product и version; для CPE также нужен vendor. PURL: npm, PyPI или Maven, без qualifiers и subpath.'
  if (code === 'CONFLICT') return action === 'create' ? 'Компонент с такими vendor, product и version уже существует. Проверьте список.'
    : action === 'remove' ? 'Компонент изменился. Перечитайте запись перед удалением.'
      : 'Компонент изменился или такая комбинация vendor, product и version уже существует. Перечитайте запись и проверьте список.'
  if (code === 'BUSY') return 'Идёт локальный импорт. Дождитесь его завершения и повторите действие.'
  if (code === 'NOT_FOUND') return 'Компонент больше не найден. Закройте форму и обновите список.'
  if (code === 'FORBIDDEN') return 'Доступ к изменению компонента запрещён.'
  return action === 'remove' ? 'Удаление не подтверждено. Проверьте список перед повторной попыткой.'
    : 'Сохранение не подтверждено. Проверьте список перед повторной попыткой, чтобы не создать дубль.'
}
