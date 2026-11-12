import { useState, type ReactNode } from 'react'
import { Database, LayoutDashboard, Layers3, ListChecks, NotebookPen, Settings2, ShieldCheck, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

export type WorkspaceView = 'catalog' | 'dashboard' | 'stack' | 'workflow' | 'settings'

export function AppShell({ children, view, navigate }: { children: ReactNode; view: WorkspaceView; navigate: (view: WorkspaceView) => void }) {
  const [about, setAbout] = useState(false)
  return <div className="app-shell">
    <a href={view === 'catalog' ? '#catalog-search' : view === 'stack' ? '#stack-search' : view === 'workflow' ? '#workflow-search' : view === 'settings' ? '#settings-heading' : '#dashboard-heading'} className="skip-link">{view === 'dashboard' || view === 'settings' ? 'Перейти к содержимому' : 'Перейти к поиску'}</a>
    <aside className="sidebar" aria-label="Боковая панель">
      <div className="brand"><span className="brand-mark"><ShieldCheck size={24} aria-hidden="true" /></span>
        <div><h1>VulnPulse Desktop</h1><p>Vulnerability Hub</p></div>
      </div>
      <p className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</p>
      <nav aria-label="Основные разделы" className="nav-items">
        <a className={`nav-item ${view === 'catalog' ? 'active' : ''}`} href="#catalog" aria-label="Уязвимости" aria-current={view === 'catalog' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('catalog') }}><ListChecks size={19} aria-hidden="true" /><span>Уязвимости</span></a>
        <a className={`nav-item ${view === 'dashboard' ? 'active' : ''}`} href="#dashboard" aria-label="Обзор" aria-current={view === 'dashboard' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('dashboard') }}><LayoutDashboard size={19} aria-hidden="true" /><span>Обзор</span></a>
        <a className={`nav-item ${view === 'stack' ? 'active' : ''}`} href="#stack" aria-label="Стек ПО" aria-current={view === 'stack' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('stack') }}><Layers3 size={19} aria-hidden="true" /><span>Стек ПО</span></a>
        <a className={`nav-item ${view === 'workflow' ? 'active' : ''}`} href="#workflow" aria-label="Заметки / SLA" aria-current={view === 'workflow' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('workflow') }}><NotebookPen size={19} aria-hidden="true" /><span>Заметки / SLA</span></a>
        <a className={`nav-item ${view === 'settings' ? 'active' : ''}`} href="#settings" aria-current={view === 'settings' ? 'page' : undefined}
          onClick={event => { event.preventDefault(); navigate('settings') }}><Settings2 size={19} aria-hidden="true" /><span>Настройки</span></a>
      </nav>
      <div className="sidebar-bottom">
        <div className="local-workspace"><Database size={17} aria-hidden="true" /><div><strong>Локальная база</strong><p>На этом устройстве</p></div></div>
        <button className="about-button" onClick={() => setAbout(true)}><Info size={14} aria-hidden="true" /><span>О дизайне · Mint / Ali</span></button>
      </div>
    </aside>
    <main id={view} className="workspace">{children}</main>
    <Dialog open={about} onOpenChange={setAbout}>
      <DialogContent className="about-dialog" onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('.about-button')?.focus() }}>
        <div className="p-6 pr-14"><DialogTitle className="text-xl font-semibold">О дизайне</DialogTitle>
          <DialogDescription className="mt-2 text-muted-foreground">VulnPulse Desktop · адаптация визуальной основы Mint</DialogDescription></div>
        <div className="overflow-auto p-6 pt-0 leading-relaxed"><p>Основа: Free Admin Dashboard UI Kit / Mint. Автор: Ali (@malik_ali). Лицензия: CC BY 4.0.</p>
          <p className="mt-3 break-all text-muted-foreground">Источник: figma.com/community/file/1244293267600418871</p>
          <p className="mt-2 break-all text-muted-foreground">Лицензия: creativecommons.org/licenses/by/4.0/</p>
          <p className="mt-3">В VulnPulse изменены навигация, таблицы, формы и предметные показатели. Это адаптация по публичному превью, а не точная копия слоёв Figma.</p>
          <p className="mt-3">UI-примитивы основаны на shadcn/ui (MIT), иконки — Lucide (ISC). Используется системный шрифт с поддержкой кириллицы.</p>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
