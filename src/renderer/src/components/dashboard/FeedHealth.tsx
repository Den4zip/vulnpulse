import { Clock3, Database } from 'lucide-react'
import type { DashboardFeed } from '@shared/api'
import { feedLabels } from '@renderer/lib/presentation'

const states: Record<DashboardFeed['runState'], string> = {
  untracked: 'Дата импорта не хранится', never: 'Запусков не записано', running: 'Выполняется',
  completed: 'Завершено без ошибки', failed: 'Ошибка', cancelled: 'Отменено', interrupted: 'Прервано', unknown: 'Состояние неизвестно'
}
const modes: Record<DashboardFeed['mode'], string> = { local: 'Локальный JSON', manual: 'Авто выключено', scheduled: 'По расписанию' }
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })
export function dashboardTime(value: string): string { return dateFormat.format(new Date(value)) }

export function FeedHealth({ feeds }: { feeds: DashboardFeed[] }) {
  return <section className="overview-panel feed-health" aria-labelledby="feeds-heading">
    <div className="overview-panel-heading"><div><h3 id="feeds-heading">Состояние источников</h3><p>Последнее сетевое задание · UTC</p></div><Clock3 size={18} aria-hidden="true" /></div>
    <ul className="feed-health-list">{feeds.map(feed => <li key={feed.name} data-feed={feed.name}>
      <div className="feed-health-title"><strong>{feedLabels[feed.name]}</strong><span>{modes[feed.mode]}</span></div>
      <p className={`feed-run-state run-${feed.runState}`}>{states[feed.runState]}</p>
      {feed.lastStartedAt && <p className="feed-time">Начало: <time dateTime={feed.lastStartedAt}>{dashboardTime(feed.lastStartedAt)}</time></p>}
      {feed.lastFinishedAt && <p className="feed-time">Завершение: <time dateTime={feed.lastFinishedAt}>{dashboardTime(feed.lastFinishedAt)}</time></p>}
      <p className="feed-records"><Database size={12} aria-hidden="true" />Записей источника: <span className="numeric">{feed.recordCount.toLocaleString('ru-RU')}</span></p>
    </li>)}</ul>
    <p className="overview-note">Время завершения включает ошибки и отмены. Даты локальных импортов не сохраняются. Число записей источника может отличаться от числа карточек каталога.</p>
  </section>
}
