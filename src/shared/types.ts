import type { InferInsertModel } from 'drizzle-orm'
import type {
  feeds,
  vulnerabilities,
  stack,
  matches,
  notes,
  sla
} from '../main/db/schema'

export type { FeedName, StackKind } from './enums'

export type FeedInfo = InferInsertModel<typeof feeds>

export type Vulnerability = Omit<
  InferInsertModel<typeof vulnerabilities>,
  'rawJson' | 'createdAt'
>

export type StackItem = Omit<InferInsertModel<typeof stack>, 'createdAt' | 'updatedAt'>

export type MatchRecord = Omit<InferInsertModel<typeof matches>, 'createdAt'> & {
  confidence: number
}

export type Note = Omit<InferInsertModel<typeof notes>, 'createdAt'>

export type SlaRecord = InferInsertModel<typeof sla>
