import { useEffect, useState } from 'react'
import type { ApiResult, FeedSettingsMap, NetworkFeed, SettingsView } from '@shared/api'
import { errorText, feedLabels } from '@renderer/lib/presentation'
import { Button } from '../components/ui/button'

const feeds: { name: NetworkFeed; min: number; max: number }[] = [
  { name: 'cisa', min: 60, max: 10080 }, { name: 'nvd', min: 120, max: 10080 }, { name: 'fstec', min: 1440, max: 43200 }
]

export function Settings() {
  const [data, setData] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<FeedSettingsMap | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function reload() {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.electronAPI.settings.get()
      if (!result.ok) setError(errorText(result.error.code))
      else { setData(result.value); setDraft(result.value.feeds) }
    } catch { setError('Не удалось загрузить настройки. Повторите попытку.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void reload() }, [])

  async function write(action: () => Promise<ApiResult<SettingsView>>, success: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await action()
      if (!result.ok) setError(errorText(result.error.code))
      else { setData(result.value); setMessage(success) }
    } catch { setError('Результат операции неизвестен. Обновите настройки перед повтором.') }
    finally { setBusy(false) }
  }
  return <>
    <header className="page-header"><div><p className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p><h2 id="settings-heading" tabIndex={-1}>Настройки</h2><p className="page-description">Расписание источников и доступ к NVD.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void reload()}>Обновить</Button></header>
    {error && <p className="activity-message" role="alert">{error}</p>}{message && <p className="catalog-notice" role="status">{message}</p>}
    {!data || !draft ? <p>{busy ? 'Загрузка настроек…' : 'Настройки не загружены. Нажмите «Обновить».'}</p> : <div className="settings-content">
      <section className="overview-panel settings-panel"><h3>Автоматическое обновление</h3><p>Включённые источники используют сеть. Интервал указан в минутах.</p>
        <form onSubmit={event => { event.preventDefault(); void write(async () => {
          const result = await window.electronAPI.settings.update({ expectedRevision: data.revision, feeds: draft })
          if (result.ok) setDraft(result.value.feeds)
          return result
        }, 'Расписание сохранено.') }}>
          {feeds.map(({ name, min, max }) => <div className="settings-feed" key={name}>
            <label><input type="checkbox" checked={draft[name].enabled} disabled={busy} onChange={event => setDraft({ ...draft, [name]: { ...draft[name], enabled: event.target.checked } })} /> {feedLabels[name]}</label>
            <label>Интервал, мин <input type="number" required min={min} max={max} step={1} disabled={busy} value={Number.isNaN(draft[name].intervalMinutes) ? '' : draft[name].intervalMinutes} onChange={event => setDraft({ ...draft, [name]: { ...draft[name], intervalMinutes: event.target.valueAsNumber } })} /><small>{min}–{max}</small></label>
          </div>)}
          <Button type="submit" disabled={busy}>Сохранить расписание</Button>
        </form>
      </section>
      <section className="overview-panel settings-panel"><h3>Ключ API NVD</h3>
        <p>{data.nvdKey.status === 'available' ? 'Ключ сохранён и доступен.' : data.nvdKey.status === 'unavailable' ? 'Сохранённый ключ недоступен. Обновление NVD заблокировано до восстановления или удаления ключа.' : 'Ключ не задан; NVD использует анонимный лимит.'}</p>
        {!data.nvdKey.storageAvailable && <p>Защищённое хранилище системы недоступно; сохранить ключ сейчас нельзя.</p>}
        {data.nvdKey.needsReencrypt && <p>Для обновления защиты сохраните ключ повторно.</p>}
        <form onSubmit={event => { event.preventDefault(); const submitted = key; setKey(''); void write(() => window.electronAPI.settings.setNvdApiKey({ expectedRevision: data.nvdKey.revision, apiKey: submitted }), 'Ключ сохранён.') }}>
          <label className="settings-key">Новый ключ <input type="password" autoComplete="off" value={key} maxLength={256} required disabled={busy || !data.nvdKey.storageAvailable} onChange={event => setKey(event.target.value)} /></label>
          <div className="settings-actions"><Button type="submit" disabled={busy || !data.nvdKey.storageAvailable || !key}>Сохранить ключ</Button>
            {data.nvdKey.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => { setKey(''); void write(() => window.electronAPI.settings.removeNvdApiKey({ expectedRevision: data.nvdKey.revision }), 'Ключ удалён.') }}>Удалить ключ</Button>}</div>
        </form>
        <p>Ключ хранится в защищённом системном хранилище и не отображается после сохранения.</p>
      </section>
      <section className="overview-panel settings-panel"><h3>OSV</h3><p>Локальный импорт JSON. Данные стека не отправляются в OSV.</p></section>
    </div>}
  </>
}
