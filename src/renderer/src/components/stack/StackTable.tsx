import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import type { StackEntry, StackPage, StackQuery } from '@shared/api'
import { useStackStore } from '@renderer/store/stack'
import { Button } from '../ui/button'
import { NativeSelect } from '../ui/select'
import { kindLabels, stackDate } from './presentation'

export function StackTable({ page, blocked, edit, remove }: {
  page: StackPage; blocked: boolean
  edit: (row: StackEntry, trigger: HTMLButtonElement) => void
  remove: (row: StackEntry, trigger: HTMLButtonElement) => void
}) {
  const query = useStackStore(state => state.query)
  const sort = useStackStore(state => state.sort)
  const go = useStackStore(state => state.page)
  const filter = useStackStore(state => state.filter)
  const header = (label: string, column: NonNullable<StackQuery['sort']>) => <th scope="col" aria-sort={query.sort === column ? query.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button onClick={() => sort(column)}>{label}{query.sort === column ? query.direction === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" /> : null}</button></th>
  return <>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Таблица компонентов, прокрутка"><table className="catalog-table stack-table">
      <caption className="sr-only">Сохранённый стек ПО. Автоматический пересчёт применимости пока недоступен.</caption>
      <thead><tr>{header('Название', 'name')}<th scope="col">Тип</th><th scope="col">Поставщик</th><th scope="col">Продукт</th><th scope="col">Версия</th><th scope="col">Идентификаторы</th>{header('Изменён', 'updatedAt')}<th scope="col"><span className="sr-only">Действия</span></th></tr></thead>
      <tbody>{page.items.map(row => <tr key={row.id}>
        <td><button className="stack-name-link" aria-label={`Изменить ${row.name}`} title={row.name} onClick={event => edit(row, event.currentTarget)}>{row.name}</button></td>
        <td><span className={`stack-kind kind-${row.kind}`}>{kindLabels[row.kind]}</span></td>
        <td><span className="stack-cell-text" title={row.vendor ?? undefined}>{row.vendor ?? 'Не указан'}</span></td>
        <td><code className="stack-cell-text" title={row.product}>{row.product}</code></td>
        <td><span className="stack-cell-text numeric" title={row.version ?? undefined}>{row.version ?? 'Не указана'}</span></td>
        <td><span className="stack-identifiers">{row.purl && <span title={row.purl}>PURL</span>}{row.cpe23 && <span title={row.cpe23}>CPE 2.3</span>}{!row.purl && !row.cpe23 && 'Не указаны'}</span></td>
        <td className="date-cell">{stackDate(row.updatedAt)}</td>
        <td><Button variant="ghost" size="icon" aria-label={`Удалить ${row.name}`} disabled={blocked} onClick={event => remove(row, event.currentTarget)}><Trash2 aria-hidden="true" /></Button></td>
      </tr>)}</tbody>
    </table></div>
    <footer className="pagination" aria-label="Страницы стека"><p role="status">{page.offset + 1}–{page.offset + page.items.length} из {page.total.toLocaleString('ru-RU')}</p>
      <div className="pagination-controls"><label htmlFor="stack-page-size">Строк на странице</label><NativeSelect id="stack-page-size" value={query.limit ?? 50} onChange={event => filter({ limit: Number(event.target.value) })}>
        {[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect>
        <Button variant="outline" size="icon" aria-label="Предыдущая страница" disabled={page.offset === 0} onClick={() => go(Math.max(0, page.offset - page.limit))}><ChevronLeft aria-hidden="true" /></Button>
        <span className="page-number">{Math.floor(page.offset / page.limit) + 1} / {Math.max(1, Math.ceil(page.total / page.limit))}</span>
        <Button variant="outline" size="icon" aria-label="Следующая страница" disabled={page.offset + page.limit >= page.total || page.offset + page.limit > 1_000_000} onClick={() => go(page.offset + page.limit)}><ChevronRight aria-hidden="true" /></Button>
      </div>
    </footer>
  </>
}
