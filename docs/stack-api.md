# Стек ПО: сервис и IPC

Реализовано и проверено 2026-11-07, второй пункт стадии 6. SQLite, валидация и изменения находятся в Main. Preload предоставляет конкретные методы `window.electronAPI.stack`; React-экран подключён 2026-11-08: [Стек ПО](stack-ui.md). Контракт API этим UI-шагом не менялся.

| Метод | Вход | Ответ внутри `ApiResult` |
| --- | --- | --- |
| `list(query?)` | search/kind/sort/direction/offset/limit | items/total/offset/limit |
| `get(id)` | Положительный безопасный целый ID | `StackEntry` |
| `create(component)` | Полный компонент | item/invalidatedMatches/matchingRecomputed |
| `update(command)` | id/expectedUpdatedAt/component | item/invalidatedMatches/matchingRecomputed |
| `remove(command)` | id/expectedUpdatedAt | id/removedMatches |

Read/command DTO находятся в `shared/api.ts`, независимо от Drizzle/Main. У прочитанной записи обязательны ID, даты и явные nullable поля; старая запись без версии остаётся читаемой. Создание и обновление требуют конкретной версии и хотя бы одного согласованного CPE/PURL.

```ts
const read = await window.electronAPI.stack.get(id)
if (read.ok) {
  const saved = await window.electronAPI.stack.update({
    id, expectedUpdatedAt: read.value.updatedAt,
    component: {
      kind: 'package', name: 'Demo', product: 'demo', version: '1.1.0',
      purl: 'pkg:npm/demo@1.1.0'
    }
  })
  // saved.ok / saved.error.code; при CONFLICT перечитать запись.
}
```

Обновление полностью заменяет поля компонента, сохраняя ID/createdAt. Это позволяет проверить согласованность версии и идентификаторов вместе. Optional vendor/cpe23/purl нормализуются в null; отсутствующие optional поля при замене очищаются. Частичный patch не поддержан.

## Проверки и конфликты

Общий `stack/component.ts` используется и CRUD, и прежним JSON-импортом. Сохраняется его политика: строки до 2048 символов без управляющих символов/пробелов по краям, конкретная версия, CPE с теми же vendor/product/version, PURL npm/PyPI/Maven с canonical product и той же версией, без qualifiers/subpath. Пределы реализации CPE/PURL не расширялись.

Совпадение точной тройки vendor/product/version отклоняется как `CONFLICT`, включая NULL vendor. JSON-импорт по-прежнему пропускает идентичную запись, а CRUD create сообщает конфликт. Разные версии — разные записи. Проверка выполняется в `BEGIN IMMEDIATE` вместе с записью; существующие legacy-дубли не принимаются молча. Схемный nullable UNIQUE не изменён: прямые записи в БД в обход поддержанных сервисов могут создать такие дубли.

Изменение и удаление требуют точный `expectedUpdatedAt`, полученный из последнего чтения. Устаревшее значение даёт `CONFLICT`; отсутствующий ID — `NOT_FOUND`. Обновлённая дата строго позже прежней как минимум на 1 мс, включая одинаковое время/перевод часов назад. Старый SQLite UTC формат читается без смены часового пояса. Идентичный update не меняет ревизию; неправильная сохранённая дата не угадывается — запись откатывается с `INTERNAL_ERROR`.

Фильтры: поиск до 200 символов по name/vendor/product/version и kind. Поиск — буквальная подстрока SQLite LIKE, ASCII case-insensitive; Unicode folding/FTS отсутствуют. Sort id/name/updatedAt, direction asc/desc, default name asc + ID; даты старого SQLite и нового ISO формата сравниваются хронологически. Limit 1..100, offset 0..1000000, defaults 50/0. Count/страница читаются в одной транзакции. Offset-пагинация может смещаться при изменении каталога между запросами.

Во время локального импорта/выбора файла через меню любые записи стека получают `BUSY`, чтение доступно. Фоновые загрузки общих каталогов не блокируют CRUD на время ожидания сети. Новых сетевых запросов или передачи стека API не добавляет.

## Вычисленные совпадения и сохранность

Изменение kind/vendor/product/version/cpe23/purl удаляет прежние строки `matches` только этого компонента в той же транзакции. Переименование сохраняет совпадения. Удаление компонента каскадно удаляет его matches. Ошибка откатывает компонент и изменения matches вместе.

В ответе записи `matchingRecomputed: false`: автоматический пересчёт matcher не подключён. `invalidatedMatches`/`removedMatches` показывают число удалённых вычисленных строк. Их отсутствие не означает неприменимость уязвимостей или исправление. Каталог, исходники, глобальные статусы, заметки/SLA и другие компоненты сохраняются.

Для пяти новых IPC-каналов используется та же проверка контролируемого окна/главного frame/origin/URL и безопасная сериализация ошибок, что у каталога. Аргументы проверяются в Main; общих invoke/send/SQL-методов в bridge нет. Коды `CONFLICT` и `BUSY` дополнили существующий ApiResult; SQL/исключения не передаются клиенту.

## Фактические проверки

- Typecheck Main/Preload/Renderer и production build успешны. Схема, миграции и зависимости не менялись; рабочая пользовательская БД не открывалась.
- Полный Vitest с coverage — **696/696**, 24 файла (+81 stack service case и один IPC test; прежние bridge/импорт тесты расширены). Matcher — все 100%. Stack CRUD: statements 96,92%, branches 94,87%, functions/lines 100%; component и stack validation — все 100%. Общие services — 86,95% / 85,81% / 94,52% / 89,70%. Coverage include прежний: services; IPC/preload проверяются unit/E2E, worker остаётся вне инструментации.
- Полный Electron E2E — **6/6**, 7,1 с. Новый сценарий проверяет пять методов из sandboxed Renderer, дубли/валидацию, совместимость с импортом примера и legacy timestamp, устаревшие update/delete, переименование/смену версии, ограниченную инвалидацию matches, BUSY во время fake OS dialog, отказ всем пяти каналам другому окну и сохранность после перезапуска/удаления. Matches и каталог для этого сценария создаются только как fixtures во временной БД; реальный автопересчёт не заявляется.
- В ходе typecheck уточнён generic StackKind в валидаторе; при самостоятельном просмотре учтена хронологическая сортировка смешанных timestamp-форматов и добавлен regression case. Финальные прогоны успешны.
- Drizzle update/delete/returning и transaction behavior сверены через Context7 `/drizzle-team/drizzle-orm-docs`, установленный драйвер rc.5 и реальные SQLite-тесты. Отдельного снимка rc.5 в Context7 нет. Первичные источники: [update](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/sqlite/update.mdx), [delete](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/sqlite/delete.mdx), [transactions](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/sqlite/transactions.mdx).

Живые фиды, audit, нагрузка и установщики этим пунктом не проверялись. Последующее продолжение 2026-11-07: [заметки/SLA](workflow-api.md) реализованы, включая отдельную миграцию ревизий notes/SLA. Тот исторический общий прогон — 771 unit и 7 Electron E2E; цифры выше относятся к пункту сервиса стека. Все пять пунктов IPC затем реализованы. Актуализация 2026-11-08: UI стека подключён, свежие 874 unit / 17 Electron E2E и ограничения описаны в [отчёте](stack-ui.md). [Заметки / SLA](workflow-ui.md) также подключены; следующий экран — Настройки. Findings/независимые статусы компонентов не добавлены.
