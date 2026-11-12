import type { ApiErrorCode, ApiResult } from '@shared/api'

const messages: Record<ApiErrorCode, string> = {
  INVALID_ARGUMENT: 'Некорректные параметры запроса.',
  NOT_FOUND: 'Запись не найдена.',
  CONFLICT: 'Запись уже существует или была изменена. Обновите данные.',
  BUSY: 'Дождитесь завершения текущей операции.',
  FORBIDDEN: 'Доступ запрещён.',
  INTERNAL_ERROR: 'Не удалось выполнить операцию.',
  UNAVAILABLE: 'Сервис недоступен.'
}

export class ServiceError extends Error {
  constructor(readonly code: ApiErrorCode) { super(messages[code]) }
}

export function failure<T = never>(code: ApiErrorCode): ApiResult<T> {
  return { ok: false, error: { code, message: messages[code] } }
}
