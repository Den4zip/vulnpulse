# Использованные материалы интерфейса

## Mint

Визуальная основа: [Free Admin Dashboard UI Kit / Mint](https://www.figma.com/community/file/1244293267600418871/free-admin-dashboard-ui-kit).
Автор: [Ali (@malik_ali)](https://www.figma.com/@malik_ali).
Лицензия: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

VulnPulse адаптирует светлую палитру, навигацию и характер поверхностей по публичному превью. Изменены логотип, предметные данные, таблица, формы, состояния и компоновка для desktop. Это адаптация, а не точная копия слоёв Figma; автор исходного дизайна не заявлен как участник или рекомендатель проекта. Исходные превью остаются в документации и не входят в интерфейс приложения. Атрибуция также доступна через «О дизайне» в приложении.

## shadcn/ui

Примитивы Button и Dialog в `src/renderer/src/components/ui/` адаптируют композицию [shadcn/ui](https://github.com/shadcn-ui/ui): собственные стили Mint, русские accessible names, нативные controls, боковая карточка и управляемое восстановление фокуса. Лицензия относится к материалам shadcn/ui, а не задаёт лицензию всего проекта.

Текст [лицензии shadcn/ui](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), полученный 2026-11-07:

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm-зависимости

Графики: [Recharts](https://github.com/recharts/recharts), MIT, Copyright (c) 2015-present recharts. Текст лицензии поставляется в `node_modules/recharts/LICENSE`; сбор полного реестра лицензий остаётся этапом упаковки.

Иконки: [Lucide](https://lucide.dev/), ISC. Состояние UI: [Zustand](https://github.com/pmndrs/zustand), MIT. Модальные примитивы: [Radix UI](https://www.radix-ui.com/primitives), MIT. Их собственные лицензии включены в установленные npm-пакеты. Полный набор лицензий поставки потребуется собрать при упаковке приложения; этот файл фиксирует новые материалы этапа UI и не является полным реестром всех транзитивных зависимостей.
