import { create } from 'zustand'
import type { VulnerabilityQuery } from '@shared/api'

const defaults = (): VulnerabilityQuery => ({ search: '', sort: 'modifiedAt', direction: 'desc', offset: 0, limit: 50 })
interface CatalogState {
  query: VulnerabilityQuery
  selectedId: number | null
  selectedLabel: string
  revision: number
  filter: (patch: Partial<VulnerabilityQuery>) => void
  page: (offset: number) => void
  sort: (column: NonNullable<VulnerabilityQuery['sort']>) => void
  reset: () => void
  select: (id: number | null, label?: string) => void
  refresh: () => void
  open: (query: VulnerabilityQuery) => void
}
/** UI state only; catalog rows and business rules remain outside Zustand. */
export const useCatalog = create<CatalogState>()(set => ({
  query: defaults(), selectedId: null, selectedLabel: 'Уязвимость', revision: 0,
  filter: patch => set(state => ({ query: { ...state.query, ...patch, offset: 0 } })),
  page: offset => set(state => ({ query: { ...state.query, offset } })),
  sort: column => set(state => ({ query: { ...state.query, sort: column, offset: 0,
    direction: state.query.sort === column && state.query.direction === 'desc' ? 'asc' : 'desc' } })),
  reset: () => set({ query: defaults() }), select: (selectedId, selectedLabel = 'Уязвимость') => set({ selectedId, selectedLabel }),
  refresh: () => set(state => ({ revision: state.revision + 1 })),
  open: query => set({ query: { ...defaults(), ...query, offset: 0 }, selectedId: null, selectedLabel: 'Уязвимость' })
}))
