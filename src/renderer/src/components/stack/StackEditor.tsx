import { useState, type FormEvent } from 'react'
import type { StackComponentInput, StackDeleteResult, StackEntry, StackWriteResult } from '@shared/api'
import type { StackKind } from '@shared/enums'
import { useStackCommand, useStackEntry } from '@renderer/hooks/useStack'
import { errorText } from '@renderer/lib/presentation'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { NativeSelect } from '../ui/select'
import { ErrorState, LoadingState } from '../common/feedback'
import { kindLabels, stackDate, stackWriteError } from './presentation'

interface EditorProps { id: number | null; blockReason: string | null; close: () => void; saved: (value: StackWriteResult) => void }
export function StackEditor({ id, blockReason, close, saved }: EditorProps) {
  const resource = useStackEntry(id)
  return resource.loading ? <LoadingState label="Загрузка компонента…" /> : resource.error
    ? <ErrorState message={resource.error === 'NOT_FOUND' ? 'Компонент больше не найден. Обновите список.' : errorText(resource.error)} retry={resource.reload} />
    : <StackForm key={resource.generation} row={resource.data} blockReason={blockReason} close={close} saved={saved} reload={resource.reload} />
}

function StackForm({ row, blockReason, close, saved, reload }: {
  row: StackEntry | null; blockReason: string | null; close: () => void; saved: (value: StackWriteResult) => void; reload: () => void
}) {
  const blocked = blockReason !== null
  const [draft, setDraft] = useState(() => ({ kind: row?.kind ?? 'package' as StackKind, name: row?.name ?? '',
    vendor: row?.vendor ?? '', product: row?.product ?? '', version: row?.version ?? '', purl: row?.purl ?? '', cpe23: row?.cpe23 ?? '' }))
  const command = useStackCommand()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (blocked) return
    const component: StackComponentInput = { ...draft, vendor: draft.vendor === '' ? null : draft.vendor,
      purl: draft.purl === '' ? null : draft.purl, cpe23: draft.cpe23 === '' ? null : draft.cpe23 }
    void command.run(() => row ? window.electronAPI.stack.update({ id: row.id, expectedUpdatedAt: row.updatedAt, component })
      : window.electronAPI.stack.create(component), saved)
  }
  const field = (key: Exclude<keyof typeof draft, 'kind'>, label: string, required: boolean, hint?: string, placeholder?: string) =>
    <div className={`stack-form-field ${key === 'purl' || key === 'cpe23' || key === 'name' ? 'field-wide' : ''}`}>
      <label htmlFor={`stack-field-${key}`}>{label}{required ? ' *' : ''}</label><Input id={`stack-field-${key}`} name={key} autoFocus={key === 'name'} required={required} maxLength={2048}
        value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} placeholder={placeholder} autoComplete="off" spellCheck={false}
        aria-describedby={hint ? `stack-hint-${key}` : undefined} />
      {hint && <small id={`stack-hint-${key}`}>{hint}</small>}
    </div>
  return <form className="stack-form" onSubmit={submit}>
    <div className="stack-form-scroll">
      {row && <p className="stack-record-meta">Компонент #{row.id} · создан {stackDate(row.createdAt)} · изменён {stackDate(row.updatedAt)} UTC</p>}
      <p className="stack-form-intro">Укажите установленную версию и хотя бы один идентификатор: CPE или PURL. При смене версии обновите её также в идентификаторе.</p>
      <fieldset disabled={command.busy} className="stack-fields">
        {field('name', 'Название', true, undefined, 'Например, lodash / сервис авторизации')}
        <div className="stack-form-field"><label htmlFor="stack-field-kind">Тип *</label><NativeSelect id="stack-field-kind" value={draft.kind}
          onChange={event => setDraft(previous => ({ ...previous, kind: event.target.value as StackKind }))}>
          {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </NativeSelect></div>
        {field('vendor', 'Поставщик (vendor)', false, 'Обязателен для CPE.', 'Например, apache')}
        {field('product', 'Продукт (product)', true, 'Имя из CPE или каноническое имя PURL.', 'lodash / django / group:artifact')}
        {field('version', 'Версия', true, 'Конкретная версия, без диапазонов и *.', '4.17.21')}
        {field('purl', 'PURL', false, 'npm, PyPI или Maven; та же версия, без qualifiers и subpath.', 'pkg:npm/lodash@4.17.21')}
        {field('cpe23', 'CPE 2.3', false, 'Те же vendor, product и version.', 'cpe:2.3:a:apache:tomcat:9.0.80:*:*:*:*:*:*:*')}
      </fieldset>
      <p className="applicability-note">Пересчёт применимости пока не выполняется. Изменение версии или идентификаторов сбросит прежние вычисленные совпадения этого компонента.</p>
      {blockReason && <p className="stack-busy-note" role="status">{blockReason}</p>}
      {command.error && <div className="stack-form-error" role="alert"><p>{stackWriteError(command.error, row ? 'update' : 'create')}</p>
        {row && <Button variant="outline" size="sm" disabled={command.busy} onClick={reload}>Перечитать и заменить форму</Button>}</div>}
    </div>
    <footer className="stack-form-actions"><Button variant="outline" onClick={close}>Отмена</Button>
      <Button type="submit" disabled={command.busy || blocked}>{command.busy ? 'Сохранение…' : row ? 'Сохранить изменения' : 'Добавить компонент'}</Button></footer>
  </form>
}

export function StackDelete({ id, blockReason, close, removed }: { id: number; blockReason: string | null; close: () => void; removed: (value: StackDeleteResult) => void }) {
  const resource = useStackEntry(id)
  return resource.loading ? <LoadingState label="Загрузка компонента…" /> : resource.error
    ? <ErrorState message={resource.error === 'NOT_FOUND' ? 'Компонент больше не найден. Обновите список.' : errorText(resource.error)} retry={resource.reload} />
    : resource.data && <DeleteConfirmation key={resource.generation} row={resource.data} blockReason={blockReason} close={close} removed={removed} reload={resource.reload} />
}

function DeleteConfirmation({ row, blockReason, close, removed, reload }: {
  row: StackEntry; blockReason: string | null; close: () => void; removed: (value: StackDeleteResult) => void; reload: () => void
}) {
  const blocked = blockReason !== null
  const command = useStackCommand()
  return <div className="stack-delete-body"><p className="stack-delete-name">{row.name}</p><p className="stack-delete-identity">{row.product} · {row.version ?? 'Версия не указана'}</p>
    <p className="mt-4 leading-relaxed">Компонент будет удалён из стека вместе с его вычисленными совпадениями. Каталог уязвимостей, заметки и сроки SLA сохранятся.</p>
    {blockReason && <p className="stack-busy-note" role="status">{blockReason}</p>}
    {command.error && <div className="stack-form-error" role="alert"><p>{stackWriteError(command.error, 'remove')}</p>
      <Button variant="outline" size="sm" disabled={command.busy} onClick={reload}>Перечитать перед удалением</Button></div>}
    <div className="stack-delete-actions"><Button variant="outline" autoFocus onClick={close}>Отмена</Button>
      <Button className="stack-delete-confirm" disabled={command.busy || blocked} onClick={() => { void command.run(() => window.electronAPI.stack.remove({ id: row.id, expectedUpdatedAt: row.updatedAt }), removed) }}>{command.busy ? 'Удаление…' : 'Удалить компонент'}</Button></div>
  </div>
}
