import { useEffect, useRef, useState } from 'react'
import { Info, Layers3, LoaderCircle, Plus, RefreshCw, Upload } from 'lucide-react'
import { useStackStore } from '@renderer/store/stack'
import { useStack } from '@renderer/hooks/useStack'
import { useCatalogActivity } from '@renderer/hooks/useCatalogActivity'
import { useSearchShortcut } from '@renderer/hooks/useSearchShortcut'
import { errorText, recordCount } from '@renderer/lib/presentation'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog'
import { LoadingState, ErrorState } from '../components/common/feedback'
import { StackFilters } from '../components/stack/StackFilters'
import { StackTable } from '../components/stack/StackTable'
import { StackEditor, StackDelete } from '../components/stack/StackEditor'

interface Editor { mode: 'create' | 'edit' | 'remove'; id: number | null; session: number }
export function Stack() {
  const query = useStackStore(state => state.query)
  const revision = useStackStore(state => state.revision)
  const refresh = useStackStore(state => state.refresh)
  const resource = useStack(query, revision)
  const activity = useCatalogActivity()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const session = useRef(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const blockReason = !activity.status ? 'Состояние импорта пока недоступно. Запись станет доступна после проверки.'
    : activity.status.active?.kind === 'import' ? 'Запись временно недоступна: дождитесь завершения локального импорта.' : null
  const blocked = blockReason !== null
  const importBlocked = !activity.status || !!activity.status.active || activity.status.settingsBusy || activity.starting
  useSearchShortcut('stack-search', editor !== null)
  useEffect(() => {
    const page = resource.data
    if (!resource.loading && page && page.items.length === 0 && page.offset > 0) {
      useStackStore.getState().page(Math.min(1_000_000, Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit)))
    }
  }, [resource.data, resource.loading])
  const open = (mode: Editor['mode'], id: number | null, button: HTMLButtonElement) => {
    trigger.current = button; setMessage(null); setEditor({ mode, id, session: ++session.current })
  }
  const finish = (key: number, text: string) => {
    if (key !== session.current) return
    setMessage(text); setEditor(null)
  }
  const restoreFocus = () => {
    if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus()
    else document.getElementById('stack-search')?.focus()
  }
  const active = activity.status?.active
  const imported = activity.status?.lastImport
  const hasFilters = !!query.search || query.kind !== undefined
  return <>
    <header className="page-header stack-page-header"><div><p className="eyebrow">ПРОГРАММНЫЙ КОНТУР</p><h2 tabIndex={-1}>Стек ПО</h2><p className="page-description">Установленные компоненты, версии и идентификаторы.</p></div>
      <div className="header-actions"><Button variant="outline" disabled={resource.loading} onClick={refresh}><RefreshCw className={resource.loading ? 'animate-spin' : ''} aria-hidden="true" />Обновить</Button>
        <Button variant="outline" disabled={importBlocked} onClick={() => { void activity.importFile('stack') }}><Upload aria-hidden="true" />Импорт JSON</Button>
        <Button disabled={blocked} onClick={event => open('create', null, event.currentTarget)}><Plus aria-hidden="true" />Добавить</Button></div>
    </header>
    <div className="catalog-notice"><Info size={16} aria-hidden="true" /><p>Локальный инвентарь ПО. Применимость к уязвимостям пока не пересчитана; отсутствие совпадений не означает, что компонент безопасен.</p></div>
    {active?.kind === 'import' && <div className="operation-strip" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /><span>{active.phase === 'selecting' ? 'Выберите локальный файл…' : 'Импортируются локальные данные…'}{active.cancelRequested ? ' Запрошена отмена.' : ''}</span>
      <Button variant="ghost" size="sm" disabled={active.cancelRequested} onClick={() => { void activity.cancel() }}>Отменить</Button></div>}
    {activity.error && <p className="activity-message" role="alert">Состояние импорта: {errorText(activity.error)}</p>}
    {!active && imported?.target === 'stack' && imported.phase === 'failed' && <p className="activity-message" role="alert">Конфигурация не загружена. Проверьте формат файла и конфликты компонентов.</p>}
    {!active && imported?.target === 'stack' && imported.phase === 'cancelled' && imported.cancelRequested && <p className="stack-result-message" role="status">Импорт конфигурации отменён.</p>}
    {!active && imported?.target === 'stack' && imported.phase === 'completed' && imported.result && 'added' in imported.result && <p className="stack-result-message" role="status">Последний импорт: добавлено {imported.result.added}, уже загружено {imported.result.skipped}. Всего после импорта: {imported.result.total}.</p>}
    {message && <p className="stack-result-message" role="status">{message}</p>}
    <section className="catalog-card" aria-label="Стек программного обеспечения" aria-busy={resource.loading}>
      <div className="catalog-heading"><div><h3>Компоненты</h3><p>Локальная конфигурация и добавленные вручную записи</p></div><span className="catalog-count">{resource.error ? 'Недоступно' : resource.data && !resource.loading ? recordCount(resource.data.total) : 'Загрузка…'}</span></div>
      <StackFilters />
      {resource.loading ? <LoadingState label="Загрузка стека…" /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} />
        : resource.data?.items.length ? <StackTable page={resource.data} blocked={blocked} edit={(row, button) => open('edit', row.id, button)} remove={(row, button) => open('remove', row.id, button)} />
          : <div className="empty-state"><span className="empty-icon"><Layers3 size={25} aria-hidden="true" /></span><h3>{hasFilters ? 'Компоненты не найдены' : 'Стек пока пуст'}</h3>
            <p>{hasFilters ? 'Измените запрос или сбросьте фильтры.' : 'Импортируйте JSON-конфигурацию ПО или добавьте установленный компонент вручную. Этот формат отличается от OSV advisory.'}</p>
            {hasFilters ? <Button variant="outline" onClick={useStackStore.getState().reset}>Сбросить фильтры</Button>
              : <Button variant="outline" disabled={importBlocked} onClick={() => { void activity.importFile('stack') }}><Upload aria-hidden="true" />Выбрать конфигурацию JSON</Button>}</div>}
    </section>
    <footer className="catalog-footnote"><span>Компоненты хранятся на устройстве</span><span>Даты показаны в UTC</span></footer>
    <Dialog open={editor !== null} onOpenChange={value => { if (!value) { session.current++; setEditor(null) } }}>
      <DialogContent className={editor?.mode === 'remove' ? 'stack-delete-dialog' : 'stack-editor-dialog'} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }}>
        <div className="detail-header"><p className="eyebrow">ЛОКАЛЬНЫЙ КОМПОНЕНТ</p><DialogTitle className="text-xl font-semibold mt-2">{editor?.mode === 'create' ? 'Добавить компонент' : editor?.mode === 'remove' ? 'Удалить компонент?' : 'Изменить компонент'}</DialogTitle>
          <DialogDescription className="mt-2">{editor?.mode === 'remove' ? 'Подтвердите удаление выбранной записи.' : 'Название, установленная версия и согласованные CPE / PURL.'}</DialogDescription></div>
        {editor && (editor.mode === 'remove' && editor.id !== null ? <StackDelete key={editor.session} id={editor.id} blockReason={blockReason} close={() => { session.current++; setEditor(null) }}
          removed={result => finish(editor.session, `Компонент удалён. Прежних совпадений удалено: ${result.removedMatches}.`)} />
          : <StackEditor key={editor.session} id={editor.id} blockReason={blockReason} close={() => { session.current++; setEditor(null) }}
            saved={result => finish(editor.session, `Компонент «${result.item.name}» сохранён. Прежних совпадений сброшено: ${result.invalidatedMatches}. Пересчёт применимости пока не выполняется.`)} />)}
      </DialogContent>
    </Dialog>
  </>
}
