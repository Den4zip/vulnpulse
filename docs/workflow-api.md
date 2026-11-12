# Заметки и SLA: сервисы и IPC

Реализовано и проверено 2026-11-07, третий пункт стадии 6. Владелец — **вся уязвимость**, как в текущей схеме. Findings и независимые статусы компонентов не вводятся. Интерфейс подключён 2026-11-08: [Заметки / SLA](workflow-ui.md), без изменения этого API.

## Контракт

Read/command DTO описаны в `shared/api.ts` без зависимостей от Main/Drizzle. Все методы возвращают прежний `ApiResult`, используют проверку контролируемого окна/frame/origin/URL и фиксированные безопасные ошибки.

| Метод `window.electronAPI` | Действие |
| --- | --- |
| `notes.list({ vulnerabilityId, offset?, limit?, direction? })` | Страница заметок выбранной уязвимости, общий счёт |
| `notes.get(id)` | Прочитать заметку |
| `notes.create({ vulnerabilityId, body })` | Добавить текст |
| `notes.update({ id, expectedRevision, body })` | Изменить текст при актуальной ревизии |
| `notes.remove({ id, expectedRevision })` | Удалить выбранную заметку |
| `sla.get(vulnerabilityId)` | Прочитать SLA и рассчитанное Main состояние |
| `sla.set({ vulnerabilityId, dueAt, patchedAt, expected })` | Создать или заменить SLA |
| `sla.remove({ vulnerabilityId, expected })` | Удалить SLA |

Для нового SLA `expected: null`; для изменения/удаления — `{ id, revision }` из последнего чтения. ID и revision вместе защищают также от устаревшего запроса после удаления/повторного создания SLA. Заметки имеют постоянный ID и требуют expectedRevision. Каждое принятое обновление увеличивает revision, включая возврат к прежнему тексту/датам. Превышение безопасного целого счётчика отклоняется с откатом.

Отсутствующий владелец или заметка даёт `NOT_FOUND`. Для существующей уязвимости без SLA `sla.get` возвращает `record: null`; при попытке создать поверх существующего/изменить устаревшую ревизию — `CONFLICT`. Ключ владельца заметки неизменяемый. Неизвестные поля и неверные типы отклоняются в Main.

### Текст заметок

Новый body — непустой после trim текст до 16 384 UTF-16 единиц; исходные пробелы, кириллица, переносы и табуляция сохраняются. NUL/остальные ASCII controls запрещены. Текст не интерпретируется как HTML. Текущий UI выводит его обычным текстом.

Для больших legacy-заметок чтение ограничено 16 384 SQLite-символами, `bodyTruncated: true` явно сообщает об обрезке. Само чтение не меняет БД. Текущий редактор сообщает об обрезке и требует явного подтверждения замены новым полным текстом. Страница — limit 1..100, offset 0..1000000, default 50/0; direction desc по ID по умолчанию (порядок добавления), asc доступен. ID/createdAt/владелец сохраняются при редактировании.

### Время SLA

Новые dueAt/patchedAt — точные UTC instants `YYYY-MM-DDTHH:mm:ss.SSSZ`. Пример: `2026-12-01T15:00:00.000Z`. Date-only, локальное время, offset-строки, несуществующие даты и leap seconds не принимаются. Текущий интерфейс явно подписывает ввод как UTC и сериализует его в канонический instant с сохранением миллисекунд. DueAt может быть в прошлом; patchedAt — null либо время не позже часов Main.

Ответ — `{ vulnerabilityId, record, evaluatedAt }`, где evaluatedAt также UTC. Состояние и флаги вычисляет Main при каждом чтении:

| Состояние | Условие | isOverdue / missedDeadline |
| --- | --- | --- |
| open | Исполнение не отмечено, now ≤ dueAt | false / false |
| overdue | Исполнение не отмечено, now > dueAt | true / true |
| completed | Есть корректный patchedAt ≤ now | false / patchedAt > dueAt |
| unknown | Неоднозначная/повреждённая legacy-дата или исполнение в будущем | null / null |

Данные без явного UTC, например прежнее `2026-12-01`, сохраняются без угадывания часового пояса и показываются как unknown. Legacy-строки дат ограничены 128 символами в ответе, обрезка отмечена `dateValuesTruncated`; БД при чтении не меняется. Исправление возможно через set с актуальным токеном. Переход времени сам по себе не записывает новую ревизию.

Отметка исполнения SLA не меняет VulnStatus; смена VulnStatus не заполняет patchedAt. Удаление/переоткрытие SLA — отдельные ручные операции. KEV-срок поставщика не копируется в пользовательский SLA. Фиды сохраняют заметки, сроки и их ревизии; операции заметок/SLA не меняют каталог, matches или стек. Запись атомарна в BEGIN IMMEDIATE; ошибки откатываются. Эти операции доступны и во время ожидания импорта: адаптеры не владеют пользовательскими записями, SQL в Main выполняется последовательно.

## Миграция и проверки

`004_workflow_revisions`: drizzle-kit rc.5 сгенерировал новую SQL-миграцию из schema.ts. Добавлены notes.revision и sla.revision (`NOT NULL DEFAULT 1`), индекс notes(vulnerability_id,id). Прежние миграции не переписывались. Нет переноса владельцев/удаления данных или изменения существующих дат/ID.

- Typecheck Main/Preload/Renderer и build успешны.
- Полный Vitest+coverage — **771/771**, 26 файлов: +72 workflow-сценария, +2 миграционных и +1 IPC test; прежние bridge/schema тесты обновлены. Matcher — все 100%. Workflow: 96,42% statements / 95,60% branches / 100% functions/lines; workflow validation/records — все 100%. Общие services — 87,46% / 86,29% / 95,07% / 90,29%. Scope coverage прежний: services; IPC/preload тестируются unit/E2E, worker вне инструментации.
- Проверена заполненная файловая БД до 004: ID/body/createdAt/dueAt/patchedAt, статус, источники, связи, стек/matches, ETag/checkpoint сохранены; ревизии стали 1; повтор миграции и reopen успешны. Искусственный конфликт индекса откатывает оба ADD COLUMN и запись в журнал; после устранения конфликта повтор проходит. FK check чист.
- Полный Electron E2E — **7/7**, 9,3 с; новый workflow-сценарий 3,3 с. Built Main реально обновляет отдельную legacy-БД, Renderer вызывает восемь методов: заметки, unknown/overdue/completed SLA, устаревшие токены, date validation, импорт OSV и сохранность после перезапуска/удаления, отказ другому окну. Данные и профили тестовые, native dialogs подменены.
- Первый целевой unit-прогон выявил неверное тестовое ожидание для допустимого patchedAt:null; тест исправлен, production-логика не менялась из-за этого случая. Финальные прогоны успешны. Dependencies не менялись, рабочая БД не открывалась; live feeds, audit, нагрузка и упаковка не проверялись.

Drizzle generate/returning/optimistic where сверены через Context7 `/drizzle-team/drizzle-orm-docs` и установленные rc.5 типы/драйвер (отдельного rc.5 снимка в индексе нет). Первичные источники: [SQLite generate](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/sqlite/drizzle-kit-generate.mdx), [update](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/sqlite/update.mdx). UTC-политика и состояния SLA — решения этого API, не правила Drizzle.

Результаты выше относятся к сервису workflow на 2026-11-07. Затем реализованы Settings/sync-import IPC и первые четыре UI-экрана. На 2026-11-08 [workflow UI](workflow-ui.md) проверен: 892 unit / 21 Electron E2E. Следующий пункт — экран Настройки; автопересчёт matcher и независимые проблемы компонентов остаются будущей работой.
