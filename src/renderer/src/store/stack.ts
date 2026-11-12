import { create } from 'zustand'
import type { StackQuery } from '@shared/api'

const defaults = (): StackQuery => ({ search: '', sort: 'name', direction: 'asc', offset: 0, limit: 50 })
interface StackState {
  query: StackQuery
  revision: number
  filter: (patch: Partial<StackQuery>) => void
  page: (offset: number) => void
  sort: (column: NonNullable<StackQuery['sort']>) => void
  reset: () => void
  refresh: () => void
}
/** UI query and invalidation only; components and business rules stay in Main. */
export const useStackStore = create<StackState>()(set => ({
  query: defaults(), revision: 0,
  filter: patch => set(state => ({ query: { ...state.query, ...patch, offset: 0 } })),
  page: offset => set(state => ({ query: { ...state.query, offset } })),
  sort: column => set(state => ({ query: { ...state.query, sort: column, offset: 0,
    direction: state.query.sort === column && state.query.direction === 'asc' ? 'desc' : 'asc' } })),
  reset: () => set({ query: defaults() }), refresh: () => set(state => ({ revision: state.revision + 1 }))
}))
