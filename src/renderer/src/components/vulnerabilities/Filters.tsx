import { useEffect, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Severity, VulnStatus, type FeedName } from '@shared/enums'
import { feedLabels, severityLabels, statusLabels } from '@renderer/lib/presentation'
import { useCatalog } from '@renderer/store/catalog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { NativeSelect } from '../ui/select'

export function Filters() {
  const query = useCatalog(state => state.query)
  const filter = useCatalog(state => state.filter)
  const reset = useCatalog(state => state.reset)
  const [search, setSearch] = useState(query.search ?? '')
  useEffect(() => { setSearch(query.search ?? '') }, [query.search])
  useEffect(() => {
    const timer = setTimeout(() => { if (search !== (query.search ?? '')) filter({ search }) }, 250)
    return () => clearTimeout(timer)
  }, [search, query.search, filter])
  const hasFilters = !!search || query.severity !== undefined || query.status !== undefined || query.feed !== undefined || query.knownExploited !== undefined
  return <section aria-label="Фильтры каталога" className="filter-panel">
    <div className="search-line">
      <div className="search-field"><Search size={17} aria-hidden="true" />
        <Input id="catalog-search" type="search" aria-label="Поиск по идентификатору или названию" placeholder="Поиск по CVE или названию…" maxLength={200} value={search}
          onChange={event => setSearch(event.target.value.replace(/[\u0000-\u001f\u007f]/g, ''))} />
        <kbd aria-hidden="true">Ctrl F</kbd>
      </div>
      <div className="quick-filters" aria-label="Быстрые фильтры">
        <button type="button" aria-pressed={!hasFilters} onClick={() => { setSearch(''); reset() }}>Все</button>
        <button type="button" aria-pressed={query.knownExploited === true} onClick={() => filter({ knownExploited: query.knownExploited === true ? undefined : true })}>CISA KEV</button>
        <button type="button" aria-pressed={query.status === VulnStatus.New} onClick={() => filter({ status: query.status === VulnStatus.New ? undefined : VulnStatus.New })}>Новые</button>
      </div>
    </div>
    <div className="filter-line">
      <span className="filter-caption"><SlidersHorizontal size={15} aria-hidden="true" />Фильтры</span>
      <label><span className="sr-only">Критичность</span><NativeSelect aria-label="Критичность" value={query.severity === undefined ? 'all' : query.severity ?? 'unknown'}
        onChange={event => filter({ severity: event.target.value === 'all' ? undefined : event.target.value === 'unknown' ? null : event.target.value as Severity })}>
        <option value="all">Любая критичность</option><option value="unknown">Неизвестна</option>
        {Object.values(Severity).map(value => <option key={value} value={value}>{severityLabels[value]}</option>)}
      </NativeSelect></label>
      <label><span className="sr-only">Статус</span><NativeSelect aria-label="Статус" value={query.status ?? 'all'} onChange={event => filter({ status: event.target.value === 'all' ? undefined : event.target.value as VulnStatus })}>
        <option value="all">Любой статус</option>{Object.values(VulnStatus).map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}
      </NativeSelect></label>
      <label><span className="sr-only">Источник</span><NativeSelect aria-label="Источник" value={query.feed ?? 'all'} onChange={event => filter({ feed: event.target.value === 'all' ? undefined : event.target.value as FeedName })}>
        <option value="all">Все источники</option>{Object.entries(feedLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </NativeSelect></label>
      <label><span className="sr-only">Эксплуатация KEV</span><NativeSelect aria-label="Эксплуатация KEV" value={query.knownExploited === undefined ? 'all' : String(query.knownExploited)} onChange={event => filter({ knownExploited: event.target.value === 'all' ? undefined : event.target.value === 'true' })}>
        <option value="all">KEV: все</option><option value="true">Только KEV</option><option value="false">Без отметки KEV</option>
      </NativeSelect></label>
      {hasFilters && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); reset() }}><X aria-hidden="true" />Сбросить</Button>}
    </div>
  </section>
}
