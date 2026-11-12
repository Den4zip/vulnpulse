import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Info, NotebookPen, Plus, RefreshCw } from 'lucide-react'
import type { VulnerabilityDetail } from '@shared/api'
import { useWorkflow } from '@renderer/store/workflow'
import { useNotes, useSla, useWorkflowOwner } from '@renderer/hooks/useWorkflow'
import { useSearchShortcut } from '@renderer/hooks/useSearchShortcut'
import { useCatalogActivity } from '@renderer/hooks/useCatalogActivity'
import { errorText, recordCount } from '@renderer/lib/presentation'
import { slaLabels, workflowTime } from '@renderer/lib/workflow'
import { Button } from '../components/ui/button'
import { ErrorState, LoadingState } from '../components/common/feedback'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog'
import { OwnerPicker } from '../components/workflow/OwnerPicker'
import { NoteEditor } from '../components/workflow/NoteEditor'
import { SlaEditor } from '../components/workflow/SlaEditor'

export function Workflow({ openOwner }: { openOwner: (id: number, label: string) => void }) {
  const owner = useWorkflow(state => state.ownerId)
  const refresh = useWorkflow(state => state.refresh)
  const activity = useCatalogActivity()
  // The shortcut also checks the active element's dialog ancestry.
  useSearchShortcut('workflow-search', false)
  return <>
    <header className="page-header"><div><p className="eyebrow">РАБОТА ПО УЯЗВИМОСТИ</p><h2 tabIndex={-1}>Заметки / SLA</h2><p className="page-description">Результаты анализа, срок и отметка исполнения.</p></div>
      <Button variant="outline" onClick={refresh}><RefreshCw aria-hidden="true" />Обновить</Button></header>
    <div className="catalog-notice"><Info size={16} aria-hidden="true" /><p>Заметки и SLA относятся ко всей выбранной уязвимости. Исполнение SLA и рабочий статус меняются отдельно.</p></div>
    {activity.error && <p className="activity-message" role="alert">Состояние обновлений: {errorText(activity.error)}</p>}
    <div className="workflow-layout"><OwnerPicker /><div className="workflow-main">
      {owner === null ? <div className="overview-panel empty-state"><span className="empty-icon"><NotebookPen size={25} aria-hidden="true" /></span><h3>Выберите уязвимость</h3><p>Найдите запись слева или откройте заметки и SLA из карточки каталога.</p></div>
        : <SelectedWorkflow key={owner} id={owner} openOwner={openOwner} />}
    </div></div>
  </>
}

function SelectedWorkflow({ id, openOwner }: { id: number; openOwner: (id: number, label: string) => void }) {
  const resource = useWorkflowOwner(id)
  if (resource.loading) return <section className="overview-panel"><LoadingState label="Загрузка выбранной уязвимости…" /></section>
  if (resource.error) return <section className="overview-panel"><ErrorState message={errorText(resource.error)} retry={resource.reload} /></section>
  return resource.data && <WorkflowBoard owner={resource.data} openOwner={openOwner} />
}

type Action = 'note-create' | 'note-edit' | 'note-remove' | 'sla-edit' | 'sla-remove'
interface Editor { action: Action; noteId: number | null; session: number }
function WorkflowBoard({ owner, openOwner }: { owner: VulnerabilityDetail; openOwner: (id: number, label: string) => void }) {
  const offset = useWorkflow(state => state.notesOffset)
  const revision = useWorkflow(state => state.revision)
  const go = useWorkflow(state => state.notesPage)
  const notes = useNotes(owner.id, offset, revision)
  const sla = useSla(owner.id, revision, true)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const session = useRef(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const page = notes.data
    if (!notes.loading && page && !page.items.length && page.offset > 0) go(Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit))
  }, [notes.data, notes.loading, go])
  const open = (action: Action, button: HTMLButtonElement, noteId: number | null = null) => { trigger.current = button; setMessage(null); setEditor({ action, noteId, session: ++session.current }) }
  const close = () => { session.current++; setEditor(null) }
  const saved = (current: Editor) => {
    if (session.current !== current.session) return
    setMessage(current.action === 'note-remove' ? 'Заметка удалена.' : current.action.startsWith('note') ? 'Заметка сохранена.' : current.action === 'sla-remove' ? 'SLA удалён.' : 'SLA сохранён. Рабочий статус уязвимости не изменён.')
    setEditor(null)
  }
  const record = sla.data?.record
  return <>
    <section className="overview-panel workflow-owner-heading"><div><p className="eyebrow">ВЫБРАННАЯ УЯЗВИМОСТЬ</p><h3 id="workflow-owner-heading" tabIndex={-1}>{owner.extId}</h3><p>{owner.title ?? 'Без названия'}{owner.titleTruncated ? '…' : ''}</p></div>
      <Button variant="outline" size="sm" onClick={() => openOwner(owner.id, owner.extId)}><ExternalLink aria-hidden="true" />Открыть карточку</Button></section>
    {message && <p className="stack-result-message" role="status">{message}</p>}
    <section className="overview-panel" aria-label="SLA выбранной уязвимости" aria-busy={sla.loading}><div className="workflow-card-heading"><h3>Срок и исполнение</h3>
      <Button variant="ghost" size="sm" onClick={sla.reload} disabled={sla.loading}>Обновить SLA</Button></div>
      {sla.loading ? <LoadingState label="Загрузка SLA…" /> : sla.error ? <ErrorState message={errorText(sla.error)} retry={sla.reload} />
        : sla.data && <>{record ? <><p className={`workflow-sla-state sla-${record.state}`}>{slaLabels[record.state]}</p>
          <dl className="workflow-sla-facts"><div><dt>Срок · UTC</dt><dd>{record.dueAt}</dd></div><div><dt>Исполнение · UTC</dt><dd>{record.patchedAt ?? 'Не отмечено'}</dd></div></dl>
          <p className="workflow-help">Текущая просрочка: {record.isOverdue === null ? 'не определена' : record.isOverdue ? 'да' : 'нет'} · Нарушение срока: {record.missedDeadline === null ? 'не определено' : record.missedDeadline ? 'да' : 'нет'}</p>
          {record.dateValuesTruncated && <p className="truncation-note">Сохранённые даты показаны частично. Для исправления введите новые точные значения.</p>}
          <div className="workflow-card-actions"><Button variant="outline" size="sm" onClick={event => open('sla-edit', event.currentTarget)}>Изменить SLA</Button><Button variant="ghost" size="sm" onClick={event => open('sla-remove', event.currentTarget)}>Удалить SLA</Button></div></>
          : <div className="workflow-sla-empty"><p>SLA не назначен.</p><Button className="mt-3" variant="outline" size="sm" onClick={event => open('sla-edit', event.currentTarget)}>Назначить SLA</Button></div>}
          <p className="workflow-evaluated">Состояние на {sla.data.evaluatedAt} · перечитывается каждые 30 секунд.</p></>}
    </section>
    <section className="overview-panel workflow-notes" aria-label="Заметки выбранной уязвимости" aria-busy={notes.loading}><div className="workflow-card-heading"><div><h3>Заметки</h3><p className="workflow-help">{notes.error ? 'Число недоступно' : notes.data && !notes.loading ? recordCount(notes.data.total) : 'Загрузка…'} · новые сначала</p></div>
      <Button size="sm" onClick={event => open('note-create', event.currentTarget)}><Plus aria-hidden="true" />Добавить заметку</Button></div>
      {notes.loading ? <LoadingState label="Загрузка заметок…" /> : notes.error ? <ErrorState message={errorText(notes.error)} retry={notes.reload} />
        : notes.data?.items.length ? <><ul className="workflow-note-list">{notes.data.items.map(note => <li key={note.id}>
          <div className="workflow-note-heading"><span>#{note.id} · <time dateTime={workflowTime(note.createdAt)}>{workflowTime(note.createdAt)}</time></span><div>
            <Button variant="ghost" size="sm" aria-label={`Изменить заметку #${note.id}`} onClick={event => open('note-edit', event.currentTarget, note.id)}>Изменить</Button>
            <Button variant="ghost" size="sm" aria-label={`Удалить заметку #${note.id}`} onClick={event => open('note-remove', event.currentTarget, note.id)}>Удалить</Button></div></div>
          <p className="workflow-note-body">{note.body}</p>{note.bodyTruncated && <p className="truncation-note">Показана только часть сохранённой заметки.</p>}</li>)}</ul>
          <div className="workflow-note-pages"><span>{notes.data.offset + 1}–{notes.data.offset + notes.data.items.length} из {notes.data.total}</span><div>
            <Button variant="outline" size="icon" aria-label="Предыдущие заметки" disabled={offset === 0} onClick={() => go(Math.max(0, offset - notes.data!.limit))}><ChevronLeft aria-hidden="true" /></Button>
            <Button variant="outline" size="icon" aria-label="Следующие заметки" disabled={offset + notes.data.limit >= notes.data.total || offset + notes.data.limit > 1_000_000} onClick={() => go(offset + notes.data!.limit)}><ChevronRight aria-hidden="true" /></Button></div></div></>
          : <p className="workflow-empty-notes">Заметок пока нет.</p>}
    </section>
    <Dialog open={editor !== null} onOpenChange={value => { if (!value) close() }}><DialogContent className="workflow-editor-dialog" onCloseAutoFocus={event => {
      event.preventDefault(); if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus(); else document.getElementById('workflow-owner-heading')?.focus()
    }}>
      <div className="detail-header"><p className="eyebrow">РАБОТА ПО УЯЗВИМОСТИ</p><DialogTitle className="text-xl font-semibold mt-2">{editor?.action === 'note-remove' ? 'Удалить заметку?' : editor?.action === 'note-edit' ? 'Изменить заметку' : editor?.action === 'note-create' ? 'Добавить заметку' : editor?.action === 'sla-remove' ? 'Удалить SLA?' : 'Срок и исполнение SLA'}</DialogTitle>
        <DialogDescription className="workflow-dialog-owner">{owner.extId} · данные относятся ко всей уязвимости.</DialogDescription></div>
      {editor && (editor.action.startsWith('note') ? <NoteEditor key={editor.session} ownerId={owner.id} noteId={editor.noteId} remove={editor.action === 'note-remove'} close={close} saved={() => saved(editor)} />
        : <SlaEditor key={editor.session} ownerId={owner.id} remove={editor.action === 'sla-remove'} close={close} saved={() => saved(editor)} />)}
    </DialogContent></Dialog>
  </>
}
