import { lazy, Suspense } from 'react'
import { Database, Flame, Info, ListChecks, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react'
import type { VulnerabilityQuery } from '@shared/api'
import { Severity, VulnStatus } from '@shared/enums'
import { useCatalog } from '@renderer/store/catalog'
import { useDashboard } from '@renderer/hooks/useDashboard'
import { useCatalogActivity } from '@renderer/hooks/useCatalogActivity'
import { errorText, statusLabels } from '@renderer/lib/presentation'
import { Button } from '../components/ui/button'
import { LoadingState, ErrorState } from '../components/common/feedback'
import { FeedHealth, dashboardTime } from '../components/dashboard/FeedHealth'

// Keep Recharts out of the initial catalog bundle; load it when a nonempty overview needs it.
const SeverityChart = lazy(() => import('../components/dashboard/SeverityChart').then(module => ({ default: module.SeverityChart })))

export function Dashboard({ openCatalog }: { openCatalog: (query: VulnerabilityQuery) => void }) {
  const revision = useCatalog(state => state.revision)
  const refresh = useCatalog(state => state.refresh)
  const activity = useCatalogActivity()
  // Presentation refresh signal only; all aggregate and job-state decisions belong to Main.
  const activityVersion = JSON.stringify(activity.status?.feeds)
  const resource = useDashboard(revision, activityVersion ?? '')
  const data = resource.data
  return <>
    <header className="page-header"><div><p className="eyebrow">ЛОКАЛЬНЫЙ КАТАЛОГ</p><h2 id="dashboard-heading" tabIndex={-1}>Обзор</h2>
      <p className="page-description">Критичность, KEV и состояние источников.</p></div>
      <div className="header-actions"><Button variant="outline" onClick={refresh} disabled={resource.loading}><RefreshCw className={resource.loading ? 'animate-spin' : ''} aria-hidden="true" />Обновить</Button>
        <Button onClick={() => openCatalog({})}><ListChecks aria-hidden="true" />Открыть каталог</Button></div>
    </header>
    <div className="catalog-notice"><Info size={16} aria-hidden="true" /><p>Считаются сохранённые карточки всего каталога. Полнота источников не оценена; применимость к стеку пока не рассчитана. Статусы общие для уязвимости.</p></div>
    {activity.error && <p className="activity-message" role="alert">Состояние обновлений: {errorText(activity.error)} Данные обзора — на время указанного снимка.</p>}
    <div className="dashboard-content" aria-busy={resource.loading}>
      {resource.loading ? <LoadingState label="Загрузка обзора…" /> : resource.error ? <ErrorState message={errorText(resource.error)} retry={resource.reload} /> : data && <>
        <section className="overview-metrics" aria-label="Показатели каталога">
          {[{ key: 'total', label: 'Карточек в каталоге', value: data.total, icon: Database, query: {} },
            { key: 'critical', label: 'Критических', value: data.criticalCount, icon: ShieldAlert, query: { severity: Severity.Critical } },
            { key: 'kev', label: 'С отметкой KEV', value: data.knownExploited, icon: Flame, query: { knownExploited: true } },
            { key: 'new', label: 'Со статусом «Новая»', value: data.newCount, icon: Sparkles, query: { status: VulnStatus.New } }].map(metric =>
            <button className={`metric-card metric-${metric.key}`} key={metric.key} onClick={() => openCatalog(metric.query)} aria-label={`${metric.label}: ${metric.value}`}>
              <span className="metric-label">{metric.label}</span><metric.icon size={20} aria-hidden="true" />
              <strong className="numeric">{metric.value.toLocaleString('ru-RU')}</strong><span className="metric-link">Показать в каталоге →</span>
            </button>)}
        </section>
        {data.total === 0 && <section className="overview-panel empty-state"><span className="empty-icon"><Database size={25} aria-hidden="true" /></span>
          <h3>Нет сохранённых карточек</h3><p>Импортируйте локальный файл в каталоге или обновите сетевой источник через меню «Данные».</p>
          <Button variant="outline" onClick={() => openCatalog({})}>Перейти к импорту</Button></section>}
        <div className="overview-grid"><div className="overview-main">
          {data.total > 0 && <Suspense fallback={<LoadingState label="Загрузка графика…" />}><SeverityChart rows={data.severity} openCatalog={openCatalog} /></Suspense>}
          <section className="overview-panel" aria-labelledby="statuses-heading"><div className="overview-panel-heading"><div><h3 id="statuses-heading">Общие рабочие статусы</h3><p>Число карточек; состояние отдельных компонентов не отражено</p></div></div>
            <ul className="overview-statuses">{data.statuses.map(row => <li key={row.status}><button onClick={() => openCatalog({ status: row.status })}>
              <span>{statusLabels[row.status]}</span><strong className="numeric">{row.count.toLocaleString('ru-RU')}</strong></button></li>)}</ul>
          </section>
        </div><FeedHealth feeds={data.feeds} /></div>
        <p className="overview-snapshot">Снимок: <time dateTime={data.evaluatedAt}>{dashboardTime(data.evaluatedAt)} UTC</time> · «Обновить» перечитывает локальную базу.</p>
      </>}
    </div>
  </>
}
