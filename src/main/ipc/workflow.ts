import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/api'
import type { NoteService } from '../services/workflow/notes'
import type { SlaService } from '../services/workflow/sla'
import { installHandlers } from './handlers'

export function installWorkflowIpc(notes: NoteService, sla: SlaService, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  return installHandlers([
    [IPC_CHANNELS.notesList, (input) => notes.list(input)],
    [IPC_CHANNELS.notesGet, (input) => notes.get(input)],
    [IPC_CHANNELS.notesCreate, (input) => notes.create(input)],
    [IPC_CHANNELS.notesUpdate, (input) => notes.update(input)],
    [IPC_CHANNELS.notesRemove, (input) => notes.remove(input)],
    [IPC_CHANNELS.slaGet, (input) => sla.get(input)],
    [IPC_CHANNELS.slaSet, (input) => sla.set(input)],
    [IPC_CHANNELS.slaRemove, (input) => sla.remove(input)]
  ], trusted)
}
