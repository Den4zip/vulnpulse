# VulnPulse Desktop

Кроссплатформенное Electron-приложение для специалистов по ИБ (AppSec, SOC, CISO): локальная агрегация угроз (NVD, OSV, CISA KEV, БДУ ФСТЭК), автоматический матчинг со стеком компании (CPE / PURL), дашборд и трекинг уязвимостей (заметки, SLA, патчинг) без передачи данных о контуре наружу.

## Технологический стек

- **Платформа:** Electron (TypeScript) с разделением процессов Main / Preload / Renderer, `contextIsolation: true`, `nodeIntegration: false`
- **Frontend:** React, TailwindCSS, lucide-react, shadcn/ui, Recharts, Zustand
- **БД:** SQLite через встроенный `node:sqlite` (`DatabaseSync`), без ORM, с обязательными миграциями
- **Сеть/парсинг:** axios, `fast-xml-parser` (XML ФСТЭК), `cheerio` (резервный HTML)
- **Фон:** node-cron в Main Process
- **Тесты:** Vitest (unit), Playwright (E2E)
- **Сборка:** electron-vite

## Этапы разработки и текущее состояние

| Этап | Содержание | Статус |
|------|------------|--------|
| 1 | Скелет: electron-vite, окна с `contextIsolation`, настройка Vitest/Playwright | Выполнен |
| 2 | Общие типы (`shared/`) + БД: миграции, раннер, `node:sqlite` | Выполнен |
| 3 | Matcher: CPE 2.3, PURL, сравнение версий, нормализатор, движок матчинга | Выполнен |
| 4 | Feed-адаптеры: CISA KEV, NVD, OSV, ФСТЭК, единый httpclient | В работе (следующий) |
| 5 | Планировщик: node-cron поверх адаптеров | Не начат |
| 6 | Preload + IPC: контракт `window.electronAPI.*` | Не начат |
| 7 | Renderer: таблица уязвимостей → дашборд → стек → заметки/SLA → настройки | Не начат |
| 8 | Упаковка: electron-builder, полный прогон Playwright E2E | Не начат |

## Запуск

```bash
npm install
npm run dev      # режим разработки
npm test         # unit-тесты (Vitest)
npm run build    # сборка (electron-vite)
```

## Поток данных

```text
Sources → FeedAdapter (feeds/*) → SQLite (db) → Matcher Engine → IPC → preload → Renderer
```

Односторонний поток: UI не является источником бизнес-логики, все вычисления и работа с БД — только в Main Process.
