import { create } from 'zustand'
import type { VulnerabilityQuery } from '@shared/api'

interface WorkflowState {
  ownerId: number | null
  query: VulnerabilityQuery
  notesOffset: number
  revision: number
  select: (id: number) => void
  search: (value: string) => void
  page: (offset: number) => void
  notesPage: (offset: number) => void
  refresh: () => void
}
/** Selection and pagination only. Notes, deadlines and SLA decisions belong to Main. */
export const useWorkflow = create<WorkflowState>()(set => ({
  ownerId: null, query: { search: '', sort: 'modifiedAt', direction: 'desc', offset: 0, limit: 25 }, notesOffset: 0, revision: 0,
  select: id => set(state => ({ ownerId: id, notesOffset: state.ownerId === id ? state.notesOffset : 0 })),
  search: search => set(state => ({ query: { ...state.query, search, offset: 0 } })),
  page: offset => set(state => ({ query: { ...state.query, offset } })),
  notesPage: notesOffset => set({ notesOffset }), refresh: () => set(state => ({ revision: state.revision + 1 }))
}))
