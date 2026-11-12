import { useState } from 'react'
import type { NoteEntry } from '@shared/api'
import { useNote, useWorkflowCommand } from '@renderer/hooks/useWorkflow'
import { errorText } from '@renderer/lib/presentation'
import { workflowWriteError } from '@renderer/lib/workflow'
import { Button } from '../ui/button'
import { ErrorState, LoadingState } from '../common/feedback'

export function NoteEditor({ ownerId, noteId, remove, close, saved }: {
  ownerId: number; noteId: number | null; remove: boolean; close: () => void; saved: () => void
}) {
  const resource = useNote(ownerId, noteId)
  return resource.loading ? <LoadingState label="Загрузка заметки…" /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} />
    : <NoteForm key={resource.generation} ownerId={ownerId} row={resource.data} remove={remove} close={close} saved={saved} reload={resource.reload} />
}

function NoteForm({ ownerId, row, remove, close, saved, reload }: {
  ownerId: number; row: NoteEntry | null; remove: boolean; close: () => void; saved: () => void; reload: () => void
}) {
  const replacementRequired = !!row && (row.bodyTruncated || row.body.length > 16_384)
  const [body, setBody] = useState(replacementRequired ? '' : row?.body ?? '')
  const [replace, setReplace] = useState(false)
  const command = useWorkflowCommand()
  return <form className="workflow-editor-form" onSubmit={event => {
    event.preventDefault()
    if (remove && row) void command.run(() => window.electronAPI.notes.remove({ id: row.id, expectedRevision: row.revision }), saved)
    else if (!replacementRequired || replace) void command.run(() => row
      ? window.electronAPI.notes.update({ id: row.id, expectedRevision: row.revision, body })
      : window.electronAPI.notes.create({ vulnerabilityId: ownerId, body }), saved)
  }}>
    <div className="workflow-editor-scroll">
      {remove ? <><p>Заметка будет удалена из выбранной уязвимости.</p><p className="workflow-note-preview mt-4">{row?.body}</p>
        {row?.bodyTruncated && <p className="truncation-note">Предпросмотр заметки обрезан.</p>}</>
        : <><label htmlFor="note-body" className="workflow-field-label">Текст заметки</label>
          {replacementRequired && <div className="workflow-legacy-warning"><p>Сохранённая заметка показана не полностью или превышает лимит редактора. Для замены введите новый текст целиком.</p>
            <details><summary>Показать доступный текст</summary><p className="workflow-note-preview">{row?.body}</p></details>
            <label className="workflow-check"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} disabled={command.busy} />Заменить заметку новым текстом целиком</label></div>}
          <textarea id="note-body" className="workflow-textarea" autoFocus required maxLength={16_384} value={body} disabled={command.busy}
            onChange={event => setBody(event.target.value)} aria-describedby="note-text-help" />
          <p id="note-text-help" className="workflow-help">Обычный текст, до 16 384 знаков. Переносы сохраняются; HTML не исполняется. Длина: {body.length} / 16 384.</p></>}
      {command.error && <div className="stack-form-error" role="alert"><p>{workflowWriteError(command.error)}</p>
        {row && <Button variant="outline" size="sm" disabled={command.busy} onClick={reload}>Перечитать и заменить форму</Button>}</div>}
    </div>
    <footer className="stack-form-actions"><Button variant="outline" autoFocus={remove} onClick={close}>Отмена</Button>
      <Button type="submit" className={remove ? 'stack-delete-confirm' : undefined} disabled={command.busy || !remove && replacementRequired && !replace}>
        {command.busy ? 'Отправка…' : remove ? 'Удалить заметку' : 'Сохранить заметку'}</Button></footer>
  </form>
}
