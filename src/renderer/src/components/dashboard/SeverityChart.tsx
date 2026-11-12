import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { DashboardView, VulnerabilityQuery } from '@shared/api'
import { severityLabels } from '@renderer/lib/presentation'

export function SeverityChart({ rows, openCatalog }: {
  rows: DashboardView['severity']; openCatalog: (query: VulnerabilityQuery) => void
}) {
  const data = rows.map(row => ({ ...row, label: row.severity === null ? 'Не определена' : severityLabels[row.severity] }))
  return <section className="overview-panel" aria-labelledby="severity-heading">
    <div className="overview-panel-heading"><div><h3 id="severity-heading">Критичность каталога</h3><p>Сохранённые карточки по severity</p></div></div>
    <div className="chart-key"><span><i className="chart-total" />Всего</span><span><i className="chart-kev" />Из них KEV</span></div>
    <div className="severity-chart">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 500, height: 280 }}>
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 18, top: 8, bottom: 0 }} accessibilityLayer
          title="Критичность сохранённых карточек" desc="Число карточек и входящие в него карточки с отметкой KEV. Точные значения и переходы доступны в таблице под графиком.">
          <CartesianGrid horizontal={false} stroke="#e6e2ec" strokeDasharray="3 3" />
          <XAxis type="number" allowDecimals={false} tick={{ fill: '#6c6575', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={108} tick={{ fill: '#6c6575', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: '#f6f4fa' }} contentStyle={{ borderColor: '#e6e2ec', borderRadius: 6, fontSize: 12 }} />
          <Bar dataKey="count" name="Всего" fill="#6e39cb" radius={[0, 3, 3, 0]} isAnimationActive={false} maxBarSize={13} />
          <Bar dataKey="knownExploited" name="Из них KEV" fill="#b1254b" radius={[0, 3, 3, 0]} isAnimationActive={false} maxBarSize={9} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-values"><summary>Числа и переходы в каталог</summary>
      <table><caption className="sr-only">Карточки по критичности и KEV</caption><thead><tr><th scope="col">Критичность</th><th scope="col">Всего</th><th scope="col">Из них KEV</th></tr></thead>
        <tbody>{data.map(row => <tr key={row.severity ?? 'unknown'}><th scope="row">{row.label}</th>
          <td><button onClick={() => openCatalog({ severity: row.severity })} aria-label={`${row.label}: все ${row.count}`}>{row.count.toLocaleString('ru-RU')}</button></td>
          <td><button onClick={() => openCatalog({ severity: row.severity, knownExploited: true })} aria-label={`${row.label}: KEV ${row.knownExploited}`}>{row.knownExploited.toLocaleString('ru-RU')}</button></td>
        </tr>)}</tbody>
      </table>
    </details>
  </section>
}
