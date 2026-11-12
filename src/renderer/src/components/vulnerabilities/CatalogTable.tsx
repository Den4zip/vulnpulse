import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import type { VulnerabilityPage, VulnerabilityQuery, VulnerabilitySummary } from '@shared/api'
import { displayDate, feedLabels } from '@renderer/lib/presentation'
import { useCatalog } from '@renderer/store/catalog'
import { SeverityBadge, StatusBadge, KevBadge } from '../common/badges'
import { Button } from '../ui/button'
import { NativeSelect } from '../ui/select'

export function CatalogTable({ page, onOpen }: { page: VulnerabilityPage; onOpen: (row: Pick<VulnerabilitySummary, 'id' | 'extId'>, trigger: HTMLButtonElement) => void }) {
  const query = useCatalog(state => state.query)
  const sort = useCatalog(state => state.sort)
  const go = useCatalog(state => state.page)
  const filter = useCatalog(state => state.filter)
  const header = (label: string, column: NonNullable<VulnerabilityQuery['sort']>) => <th scope="col" aria-sort={query.sort === column ? query.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button type="button" onClick={() => sort(column)}>{label}{query.sort === column ? query.direction === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" /> : null}</button>
  </th>
  return <>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Таблица уязвимостей, прокрутка">
      <table className="catalog-table">
        <caption className="sr-only">Каталог уязвимостей. Статус относится ко всей уязвимости.</caption>
        <thead><tr><th scope="col">Идентификатор</th><th scope="col">Название</th>{header('Критичность', 'severity')}<th scope="col">CVSS</th><th scope="col">KEV</th><th scope="col">Источники</th><th scope="col">Статус</th>{header('Обновлена', 'modifiedAt')}</tr></thead>
        <tbody>{page.items.map(row => <tr key={row.id}>
          <td><button type="button" className="identifier-link" aria-label={`Открыть ${row.extId}`} onClick={event => onOpen(row, event.currentTarget)}>{row.extId}</button></td>
          <td><span className="table-title" title={row.title ?? undefined}>{row.title ?? 'Без названия'}{row.titleTruncated ? '…' : ''}</span></td>
          <td><SeverityBadge value={row.severity} /></td><td className="numeric">{row.cvssScore === null ? <span className="text-muted-foreground" aria-label="CVSS неизвестен">—</span> : row.cvssScore.toFixed(1)}</td>
          <td>{row.isKnownExploited ? <KevBadge /> : <span className="text-muted-foreground" aria-label="Без отметки KEV">—</span>}</td>
          <td><span className="feed-list">{row.sources.map(name => feedLabels[name]).join(' · ') || 'Нет данных'}</span></td>
          <td><StatusBadge value={row.status} /></td><td className="date-cell">{displayDate(row.modifiedAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <footer className="pagination" aria-label="Страницы каталога">
      <p role="status">{page.total === 0 ? '0 записей' : `${page.offset + 1}–${page.offset + page.items.length} из ${page.total.toLocaleString('ru-RU')}`}</p>
      <div className="pagination-controls"><label htmlFor="page-size">Строк на странице</label><NativeSelect id="page-size" value={query.limit ?? 50} onChange={event => filter({ limit: Number(event.target.value) })}>
        {[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}
      </NativeSelect><Button variant="outline" size="icon" aria-label="Предыдущая страница" disabled={page.offset === 0} onClick={() => go(Math.max(0, page.offset - page.limit))}><ChevronLeft aria-hidden="true" /></Button>
        <span className="page-number">{Math.floor(page.offset / page.limit) + 1} / {Math.max(1, Math.ceil(page.total / page.limit))}</span>
        <Button variant="outline" size="icon" aria-label="Следующая страница" disabled={page.offset + page.limit >= page.total || page.offset + page.limit > 1_000_000} onClick={() => go(page.offset + page.limit)}><ChevronRight aria-hidden="true" /></Button>
      </div>
    </footer>
  </>
}
