import type { FeedSettingsMap, NetworkFeed } from '@shared/api'
import { integer, invalid, object } from '../validation'

export const NETWORK_FEEDS: readonly NetworkFeed[] = ['cisa', 'nvd', 'fstec']
export const DEFAULT_FEEDS: FeedSettingsMap = {
  cisa: { enabled: false, intervalMinutes: 60 }, nvd: { enabled: false, intervalMinutes: 120 },
  fstec: { enabled: false, intervalMinutes: 1440 }
}
export const MINUTES: Record<NetworkFeed, readonly [number, number]> = { cisa: [60, 10080], nvd: [120, 10080], fstec: [1440, 43200] }

export function revision(value: unknown): number { return integer(value, 1, Number.MAX_SAFE_INTEGER) }

export function feedSettings(input: unknown): FeedSettingsMap {
  const raw = object(input, NETWORK_FEEDS)
  const result = {} as FeedSettingsMap
  for (const name of NETWORK_FEEDS) {
    const feed = object(raw[name], ['enabled', 'intervalMinutes'])
    if (typeof feed.enabled !== 'boolean') return invalid()
    result[name] = { enabled: feed.enabled, intervalMinutes: integer(feed.intervalMinutes, ...MINUTES[name]) }
  }
  return result
}

export function settingsUpdate(input: unknown) {
  const raw = object(input, ['expectedRevision', 'feeds'])
  return { expectedRevision: revision(raw.expectedRevision), feeds: feedSettings(raw.feeds) }
}

export function validKey(input: unknown): input is string { return typeof input === 'string' && /^[\x21-\x7e]{1,256}$/.test(input) }

export function keyWrite(input: unknown) {
  const raw = object(input, ['expectedRevision', 'apiKey'])
  if (!validKey(raw.apiKey)) return invalid()
  return { expectedRevision: revision(raw.expectedRevision), apiKey: raw.apiKey }
}

export function keyRemove(input: unknown) {
  const raw = object(input, ['expectedRevision'])
  return { expectedRevision: revision(raw.expectedRevision) }
}

export function readSettings(value: string): FeedSettingsMap {
  const parsed = object(JSON.parse(value), ['version', 'feeds'])
  if (parsed.version !== 1) return invalid()
  return feedSettings(parsed.feeds)
}
