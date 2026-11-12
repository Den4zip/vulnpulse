import { describe, expect, it } from 'vitest'
import { inputToUtc, utcToInput } from '../../src/renderer/src/lib/workflow'

describe('explicit UTC SLA form transport', () => {
  it.each([
    ['2026-12-01T15:00', '2026-12-01T15:00:00.000Z'],
    ['2026-12-01T15:00:23', '2026-12-01T15:00:23.000Z'],
    ['2026-12-01T15:00:23.7', '2026-12-01T15:00:23.700Z'],
    ['2026-12-01T15:00:23.007', '2026-12-01T15:00:23.007Z'],
    ['2028-02-29T00:00', '2028-02-29T00:00:00.000Z']
  ])('serializes %s without using the machine timezone or dropping milliseconds', (input, expected) => {
    expect(inputToUtc(input)).toBe(expected)
    expect(inputToUtc(utcToInput(expected))).toBe(expected)
  })
  it.each(['', '2026-12-01', '2026-12-01T15:00Z', '2026-12-01T15:00+03:00', '2026-02-29T15:00',
    '2026-02-30T15:00', '2026-12-01T24:00', '2026-12-01T15:00:60', '2026-12-01T15:00:00.1234'])('rejects ambiguous or invalid input %s', input => {
    expect(inputToUtc(input)).toBeNull()
  })
  it.each(['2026-12-01', '2026-12-01T15:00:00+03:00', '2026-02-30T15:00:00.000Z', 'unknown'])('leaves legacy value %s unset for explicit correction', value => {
    expect(utcToInput(value)).toBe('')
  })
})
