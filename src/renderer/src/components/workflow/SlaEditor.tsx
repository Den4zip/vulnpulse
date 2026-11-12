import { useState } from 'react'
import type { SlaView } from '@shared/api'
import { useSla, useWorkflowCommand } from '@renderer/hooks/useWorkflow'
import { errorText } from '@renderer/lib/presentation'
import { inputToUtc, utcToInput, workflowWriteError } from '@renderer/lib/workflow'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ErrorState, LoadingState } from '../common/feedback'

export function SlaEditor({ ownerId, remove, close, saved }: { ownerId: number; remove: boolean; close: () => void; saved: () => void }) {
  const resource = useSla(ownerId)
  return resource.loading ? <LoadingState label="Загрузка SLA…" /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} />
    : resource.data && <SlaForm key={resource.generation} view={resource.data} remove={remove} close={close} saved={saved} reload={resource.reload} />
}

function SlaForm({ view, remove, close, saved, reload }: { view: SlaView; remove: boolean; close: () => void; saved: () => void; reload: () => void }) {
  const row = view.record
  const [due, setDue] = useState(row && !row.dateValuesTruncated ? utcToInput(row.dueAt) : '')
  const [completed, setCompleted] = useState(row?.patchedAt != null)
  const [patched, setPatched] = useState(row?.patchedAt && !row.dateValuesTruncated ? utcToInput(row.patchedAt) : '')
  const [replace, setReplace] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const command = useWorkflowCommand()
  const expected = row ? { id: row.id, revision: row.revision } : null
  if (remove && !row) return <div className="workflow-editor-scroll"><p>SLA уже отсутствует.</p><Button className="mt-4" variant="outline" onClick={close}>Закрыть форму</Button></div>
  return <form className="workflow-editor-form" onSubmit={event => {
    event.preventDefault(); setDateError(null)
    if (remove && expected) { void command.run(() => window.electronAPI.sla.remove({ vulnerabilityId: view.vulnerabilityId, expected }), saved); return }
    const dueAt = inputToUtc(due)
    const patchedAt = completed ? inputToUtc(patched) : null
    if (!dueAt || completed && !patchedAt) { setDateError('Укажите полную дату и время UTC.'); return }
    if (row?.dateValuesTruncated && !replace) return
    void command.run(() => window.electronAPI.sla.set({ vulnerabilityId: view.vulnerabilityId, dueAt, patchedAt, expected }), saved)
  }}>
    <div className="workflow-editor-scroll">
      <p className="workflow-help">Срок и исполнение относятся ко всей уязвимости. Отметка исполнения не меняет её рабочий статус.</p>
      {remove ? <><p className="mt-4">Удалить назначенный SLA? Заметки и рабочий статус уязвимости сохранятся.</p><p className="workflow-raw-date mt-3">Сохранённый срок: {row?.dueAt}</p></>
        : <><p className="workflow-utc-notice">Время вводится в UTC, независимо от часового пояса устройства.</p>
          {row && (!utcToInput(row.dueAt) || row.dateValuesTruncated) && <div className="workflow-legacy-warning"><p>Сохранённый срок неоднозначен или обрезан: <span className="workflow-raw-date">{row.dueAt}</span>. Введите полную дату UTC.</p></div>}
          {row?.patchedAt && (!utcToInput(row.patchedAt) || row.dateValuesTruncated) && <p className="workflow-legacy-warning">Сохранённое исполнение: <span className="workflow-raw-date">{row.patchedAt}</span>. Уточните дату UTC или снимите отметку исполнения.</p>}
          <fieldset disabled={command.busy} className="workflow-sla-fields">
            <div className="stack-form-field"><label htmlFor="sla-due">Срок · UTC</label><Input id="sla-due" type="datetime-local" step="0.001" required autoFocus value={due} onChange={event => setDue(event.target.value)} /></div>
            <label className="workflow-check"><input type="checkbox" checked={completed} onChange={event => setCompleted(event.target.checked)} />Отметить исполнение</label>
            {completed && <div className="stack-form-field"><label htmlFor="sla-patched">Время исполнения · UTC</label><Input id="sla-patched" type="datetime-local" step="0.001" required value={patched} onChange={event => setPatched(event.target.value)} /><small>Исполнение не может быть в будущем.</small></div>}
            {row?.dateValuesTruncated && <label className="workflow-check"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Заменить обрезанные даты новыми значениями</label>}
          </fieldset></>}
      {dateError && <p className="form-error" role="alert">{dateError}</p>}
      {command.error && <div className="stack-form-error" role="alert"><p>{workflowWriteError(command.error)}</p><Button variant="outline" size="sm" disabled={command.busy} onClick={reload}>Перечитать и заменить форму</Button></div>}
    </div>
    <footer className="stack-form-actions"><Button variant="outline" autoFocus={remove} onClick={close}>Отмена</Button>
      <Button type="submit" className={remove ? 'stack-delete-confirm' : undefined} disabled={command.busy || !remove && !!row?.dateValuesTruncated && !replace}>
        {command.busy ? 'Отправка…' : remove ? 'Удалить SLA' : 'Сохранить SLA'}</Button></footer>
  </form>
}
