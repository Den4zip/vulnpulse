import { useEffect, useRef, useState } from 'react'
import type { VulnerabilityQuery } from '@shared/api'
import { AppShell, type WorkspaceView } from './components/layout/AppShell'
import { Vulnerabilities } from './views/Vulnerabilities'
import { Dashboard } from './views/Dashboard'
import { useCatalog } from './store/catalog'
import { Stack } from './views/Stack'
import { Workflow } from './views/Workflow'
import { useWorkflow } from './store/workflow'
import { Settings } from './views/Settings'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<WorkspaceView>('catalog')
  const previous = useRef(view)
  useEffect(() => {
    if (previous.current !== view) {
      if (view !== 'catalog' || useCatalog.getState().selectedId === null) document.querySelector<HTMLElement>('main h2')?.focus()
      previous.current = view
    }
  }, [view])
  const openCatalog = (query: VulnerabilityQuery) => { useCatalog.getState().open(query); setView('catalog') }
  const openWorkflow = (id: number) => { useCatalog.getState().select(null); useWorkflow.getState().select(id); setView('workflow') }
  const openOwner = (id: number, label: string) => { useCatalog.getState().open({}); useCatalog.getState().select(id, label); setView('catalog') }
  return <AppShell view={view} navigate={setView}>{view === 'dashboard' ? <Dashboard openCatalog={openCatalog} /> : view === 'stack' ? <Stack />
    : view === 'workflow' ? <Workflow openOwner={openOwner} /> : view === 'settings' ? <Settings /> : <Vulnerabilities openWorkflow={openWorkflow} />}</AppShell>
}
