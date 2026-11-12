import { useEffect, useRef, useState } from 'react'
import { Database, FileJson, FileCode2, Info, LoaderCircle, RefreshCw, Upload } from 'lucide-react'
import { useCatalog } from '@renderer/store/catalog'
import { useVulnerabilities } from '@renderer/hooks/useVulnerabilities'
import { useCatalogActivity } from '@renderer/hooks/useCatalogActivity'
import { errorText, feedLabels, recordCount } from '@renderer/lib/presentation'
import { Filters } from '../components/vulnerabilities/Filters'
import { CatalogTable } from '../components/vulnerabilities/CatalogTable'
import { VulnerabilityDetail } from '../components/vulnerabilities/VulnerabilityDetail'
import { LoadingState, ErrorState } from '../components/common/feedback'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog'

export function Vulnerabilities({ openWorkflow }: { openWorkflow: (id: number) => void }) {
  const query = useCatalog(state => state.query)
  const revision = useCatalog(state => state.revision)
  const selected = useCatalog(state => state.selectedId)
  const select = useCatalog(state => state.select)
  const refresh = useCatalog(state => state.refresh)
  const resource = useVulnerabilities(query, revision)
  const activity = useCatalogActivity()
  const [importOpen, setImportOpen] = useState(false)
  const selectedLabel = useCatalog(state => state.selectedLabel)
  const trigger = useRef<HTMLElement | null>(null)
  const importTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (selected !== null || importOpen || event.defaultPrevented || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') || (!event.ctrlKey && !event.metaKey && event.key === '/')) {
        event.preventDefault(); document.getElementById('catalog-search')?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [selected, importOpen])
  useEffect(() => {
    const page = resource.data
    if (!resource.loading && page && page.items.length === 0 && page.offset > 0) {
      useCatalog.getState().page(Math.min(1_000_000, Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit)))
    }
  }, [resource.data, resource.loading])
  const active = activity.status?.active
  const hasFilters = !!query.search || query.severity !== undefined || query.status !== undefined || query.feed !== undefined || query.knownExploited !== undefined
  return <>
    <header className="page-header"><div><p className="eyebrow">РАБОТА С УГРОЗАМИ</p><h2 tabIndex={-1}>Уязвимости</h2><p className="page-description">Единый каталог источников для анализа и отслеживания.</p></div>
      <div className="header-actions"><Button variant="outline" onClick={refresh} disabled={resource.loading}><RefreshCw className={resource.loading ? 'animate-spin' : ''} aria-hidden="true" />Обновить</Button>
        <Button ref={importTrigger} onClick={() => setImportOpen(true)} disabled={!activity.status || !!active || activity.starting || activity.status.settingsBusy}><Upload aria-hidden="true" />Импорт</Button></div>
    </header>
    <div className="catalog-notice"><Info size={16} aria-hidden="true" /><p>Каталог источников. Применимость к стеку пока не рассчитана. Статус относится ко всей уязвимости.</p></div>
    {active && <div className="operation-strip" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /><span>{active.phase === 'selecting' ? 'Выберите локальный файл…' : active.kind === 'sync' ? `Обновляется ${feedLabels[active.target as keyof typeof feedLabels]}…` : 'Импортируются локальные данные…'}{active.cancelRequested ? ' Запрошена отмена.' : ''}</span>
      <Button variant="ghost" size="sm" disabled={active.cancelRequested} onClick={() => { void activity.cancel() }}>Отменить</Button></div>}
    {activity.error && <p className="activity-message" role="alert">Состояние обновлений: {errorText(activity.error)}</p>}
    {!active && activity.status?.lastImport?.phase === 'failed' && <p className="activity-message" role="alert">Файл не импортирован. Проверьте формат и доступность файла.</p>}
    {!active && activity.status?.lastImport?.phase === 'cancelled' && activity.status.lastImport.cancelRequested && <p className="mb-2 text-xs text-muted-foreground" role="status">Импорт отменён.</p>}
    <section className="catalog-card" aria-label="Каталог уязвимостей" aria-busy={resource.loading}>
      <div className="catalog-heading"><div><h3>Каталог</h3><p>Сохранённые данные NVD, OSV, CISA KEV и БДУ ФСТЭК</p></div><span className="catalog-count">{resource.error ? 'Недоступно' : resource.data && !resource.loading ? recordCount(resource.data.total) : 'Загрузка…'}</span></div>
      <Filters />
      {resource.loading ? <LoadingState /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} />
        : resource.data?.items.length ? <CatalogTable page={resource.data} onOpen={(row, element) => { trigger.current = element; select(row.id, row.extId) }} />
          : <div className="empty-state"><span className="empty-icon"><Database size={25} aria-hidden="true" /></span><h3>{hasFilters ? 'Ничего не найдено' : 'Каталог пока пуст'}</h3>
            <p>{hasFilters ? 'Попробуйте изменить запрос или сбросить фильтры.' : 'Импортируйте локальный OSV JSON или XML БДУ ФСТЭК. Обновление сетевых источников доступно в меню «Данные».'}</p>
            {hasFilters ? <Button variant="outline" onClick={useCatalog.getState().reset}>Сбросить фильтры</Button> : <Button variant="outline" disabled={!activity.status || !!active || activity.starting || activity.status.settingsBusy} onClick={() => setImportOpen(true)}><Upload aria-hidden="true" />Выбрать файл</Button>}
          </div>}
    </section>
    <footer className="catalog-footnote"><span>Данные хранятся на устройстве</span><span>Даты показаны в UTC</span></footer>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) select(null) }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); (trigger.current?.isConnected ? trigger.current : document.getElementById('catalog-search'))?.focus() }}>
        <div className="detail-header"><p className="eyebrow">КАРТОЧКА УЯЗВИМОСТИ</p><DialogTitle className="detail-id">{selectedLabel}</DialogTitle><DialogDescription>Сохранённые сведения и общий рабочий статус.</DialogDescription></div>
        {selected !== null && <VulnerabilityDetail key={selected} id={selected} openWorkflow={() => openWorkflow(selected)} />}
      </DialogContent>
    </Dialog>
    <Dialog open={importOpen} onOpenChange={setImportOpen}>
      <DialogContent className="import-dialog" onCloseAutoFocus={event => { event.preventDefault(); importTrigger.current?.focus() }}>
        <div className="p-6 pr-14"><DialogTitle className="text-xl font-semibold">Локальный импорт</DialogTitle><DialogDescription className="mt-2 text-muted-foreground">Выберите формат. Файл останется на устройстве.</DialogDescription></div>
        <div className="flex flex-col gap-3 overflow-auto px-6 pb-6">
          <Button variant="outline" className="import-option" onClick={() => { setImportOpen(false); void activity.importFile('osv') }}><FileJson aria-hidden="true" /><span>OSV JSON<small>Одна запись или массив advisory</small></span><Upload aria-hidden="true" /></Button>
          <Button variant="outline" className="import-option" onClick={() => { setImportOpen(false); void activity.importFile('fstec') }}><FileCode2 aria-hidden="true" /><span>БДУ ФСТЭК XML<small>XML или XML.GZ</small></span><Upload aria-hidden="true" /></Button>
          <p className="text-xs leading-relaxed text-muted-foreground">JSON-инвентарь ПО загружается отдельно: Данные → Загрузить локальную конфигурацию ПО.</p>
        </div>
      </DialogContent>
    </Dialog>
  </>
}
