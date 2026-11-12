# Белое окно при dev-запуске — исправление 2026-11-08

Источник: пользовательские скриншоты после `npm run dev`, предупреждение `Failed to load URL: http://localhost:5173/ ... ERR_CONNECTION_REFUSED` и белое окно с рабочим нативным меню. Этот сбой возникает до загрузки React и не свидетельствует о результате импорта.

## Воспроизведение и причина

Команда: `npm run e2e -- tests/e2e/vulnerability-api.spec.ts -g "development renderer" --workers=1`.

Прежний dev E2E явно задавал `host: '127.0.0.1'`, хотя в конфигурации проекта host отсутствовал. После снятия тестового override тест дважды воспроизвёл белое окно: заголовок приложения не найден. Временные диагностические probes подтвердили listener `::1`, family IPv6, URL `http://localhost:5174/` и `did-fail-load` с `code: -102`, `description: ERR_CONNECTION_REFUSED`. Порт 5173 был занят; Vite выбрал следующий. Чужой dev-сервер не останавливался.

В [официальном описании server.host](https://vite.dev/config/server-options.html#server-host) Vite отмечает, что Node и браузер могут выбирать разные адреса `localhost`. Установленный electron-vite 4 формирует ELECTRON_RENDERER_URL из server.host/port; при отсутствии host использует localhost. Смена одного параметра на `renderer.server.host: '127.0.0.1'` в electron.vite.config.ts дала listener IPv4/тот же URL для Electron и успешную загрузку тем же тестом.

## Что изменено

- Vite и Electron используют явный loopback `127.0.0.1`. LAN-binding не включён; CSP и IPC guard не ослаблены, зависимости/Main/БД/импорт не менялись.
- Dev E2E наследует `config.renderer.server`, проверяет настоящие заголовки UI, отсутствие native did-fail-load, API, sandbox/dev CSP и сохраняет dev-renderer.png. Тест больше не подменяет host, скрывая дефект проекта. Временные DEBUG-probes удалены.
- Документация локального импорта уточняет, что конфигурация ПО пополняет stack. Она не создаёт vulnerability records. На момент исправления запуска экран стека отсутствовал; позднее 2026-11-08 подключён [Стек ПО](stack-ui.md), автоматический matcher остаётся будущей работой. Для каталога нужен отдельный импорт OSV JSON / XML ФСТЭК либо обновление фидов. Сохранность конкретного пользовательского импорта не утверждается: его БД не открывалась.

## Перезапуск

Закрыть белое окно, нажать Ctrl+C в терминале старого запуска и выполнить:

```powershell
cd "D:\проект\vulnpulse-desktop"
npm run dev
```

Для примера каталога: Импорт → OSV JSON → `D:\проект\vulnpulse-desktop\examples\osv-demo.json`. Для конфигурации стека используется отдельный пункт меню Данные либо Стек ПО → Импорт JSON.

## Проверки

2026-11-08: точный repro красный дважды до исправления; после смены host тот же targeted E2E зелёный (1/1). Финальные typecheck Main/Preload/Renderer и production build успешны; полный Vitest+coverage **874/874**, 30 файлов; полный Electron E2E **14/14**, 27,8 с, включая импорт/повтор/rollback/restart конфигурации ПО и dev regression (1,6 с). Matcher и DashboardService сохранили все100%; services88,30/87,04/94,71/91,12, прежний scope services без UI/IPC/preload и собранного worker. Dev-скриншот просмотрен: оболочка и пустой каталог загружены.

Профили тестовые/удалены. Пользовательский процесс и рабочая БД не изменялись; их перезапуск выполняет пользователь. Автоматических отклонений approval не было. Новые live feeds/audit/нагрузка/упаковка не проверялись. Коммит/push не создавались.
