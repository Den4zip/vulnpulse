import { describe, expect, it } from 'vitest'
import { Severity, VulnStatus } from '@shared/enums'

describe('skeleton smoke', () => {
  it('shared enums are importable through the @shared alias', () => {
    expect(VulnStatus.New).toBe('New')
    expect(VulnStatus.InProgress).toBe('In Progress')
    expect(Severity.Critical).toBe('Critical')
  })
})
