import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { StackKind } from '@shared/enums'
import { useStackStore } from '@renderer/store/stack'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { NativeSelect } from '../ui/select'
import { kindLabels } from './presentation'

export function StackFilters() {
  const query = useStackStore(state => state.query)
  const filter = useStackStore(state => state.filter)
  const reset = useStackStore(state => state.reset)
  const [search, setSearch] = useState(query.search ?? '')
  useEffect(() => { setSearch(query.search ?? '') }, [query.search])
  useEffect(() => {
    const timer = setTimeout(() => { if (search !== (query.search ?? '')) filter({ search }) }, 250)
    return () => clearTimeout(timer)
  }, [search, query.search, filter])
  return <section aria-label="Фильтры стека" className="filter-panel stack-filters">
    <div className="search-line"><div className="search-field"><Search size={17} aria-hidden="true" />
      <Input id="stack-search" type="search" aria-label="Поиск по названию, поставщику, продукту или версии" placeholder="Название, поставщик, продукт или версия…" maxLength={200}
        value={search} onChange={event => setSearch(event.target.value.replace(/[\u0000-\u001f\u007f]/g, ''))} /><kbd aria-hidden="true">Ctrl F</kbd></div>
      <NativeSelect aria-label="Тип компонента" value={query.kind ?? 'all'} onChange={event => filter({ kind: event.target.value === 'all' ? undefined : event.target.value as StackKind })}>
        <option value="all">Все типы</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </NativeSelect>
      {(search || query.kind !== undefined) && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); reset() }}><X aria-hidden="true" />Сбросить</Button>}
    </div>
  </section>
}
