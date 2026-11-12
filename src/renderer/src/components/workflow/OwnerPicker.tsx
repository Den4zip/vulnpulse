import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useWorkflow } from '@renderer/store/workflow'
import { useWorkflowOwners } from '@renderer/hooks/useWorkflow'
import { errorText, recordCount } from '@renderer/lib/presentation'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ErrorState, LoadingState } from '../common/feedback'

export function OwnerPicker() {
  const query = useWorkflow(state => state.query)
  const selected = useWorkflow(state => state.ownerId)
  const select = useWorkflow(state => state.select)
  const search = useWorkflow(state => state.search)
  const go = useWorkflow(state => state.page)
  const revision = useWorkflow(state => state.revision)
  const [draft, setDraft] = useState(query.search ?? '')
  const resource = useWorkflowOwners(query, revision)
  useEffect(() => { const timer = setTimeout(() => { if (draft !== query.search) search(draft) }, 250); return () => clearTimeout(timer) }, [draft, query.search, search])
  useEffect(() => {
    if (resource.data && !resource.loading && !resource.data.items.length && resource.data.offset > 0) go(Math.max(0, Math.floor((resource.data.total - 1) / resource.data.limit) * resource.data.limit))
  }, [resource.data, resource.loading, go])
  return <section className="overview-panel workflow-owner-picker" aria-label="Выбор уязвимости">
    <h3>Уязвимости каталога</h3><p className="workflow-help">Выберите владельца заметок и SLA.</p>
    <div className="search-field mt-4"><Search size={16} aria-hidden="true" /><Input id="workflow-search" type="search" aria-label="Поиск уязвимости для заметок и SLA" placeholder="CVE или название…" maxLength={200} value={draft}
      onChange={event => setDraft(event.target.value.replace(/[\u0000-\u001f\u007f]/g, ''))} /></div>
    {resource.loading ? <LoadingState label="Загрузка владельцев…" /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} />
      : resource.data?.items.length ? <><p className="workflow-owner-count">{recordCount(resource.data.total)}</p><ul className="workflow-owner-list">{resource.data.items.map(row => <li key={row.id}>
        <button aria-label={`Выбрать ${row.extId}`} aria-pressed={selected === row.id} onClick={() => select(row.id)}><strong>{row.extId}</strong><span>{row.title ?? 'Без названия'}{row.titleTruncated ? '…' : ''}</span></button></li>)}</ul>
        <div className="workflow-owner-pages"><Button size="icon" variant="outline" aria-label="Предыдущие уязвимости" disabled={resource.data.offset === 0} onClick={() => go(Math.max(0, resource.data!.offset - resource.data!.limit))}><ChevronLeft aria-hidden="true" /></Button>
          <span>{resource.data.offset + 1}–{resource.data.offset + resource.data.items.length}</span><Button size="icon" variant="outline" aria-label="Следующие уязвимости" disabled={resource.data.offset + resource.data.limit >= resource.data.total || resource.data.offset + resource.data.limit > 1_000_000}
            onClick={() => go(resource.data!.offset + resource.data!.limit)}><ChevronRight aria-hidden="true" /></Button></div></>
        : <p className="workflow-empty-owner">{query.search ? 'Уязвимости не найдены.' : 'Каталог пуст. Импортируйте записи в разделе «Уязвимости».'}</p>}
  </section>
}
