import { describe, it, expect } from 'vitest'
import { normalizeConfigUom, uomDisplayLabel, isBulkUom } from './types'

describe('normalizeConfigUom — tank labels normalize to bulk (2026-09-30)', () => {
  it('recognizes every real production "*Tank*" label as bulk', () => {
    for (const raw of ['Medium Tanks', 'Large Tanks', 'Small Tanks', 'Tote Tanks', 'Bulk Tank']) {
      const normalized = normalizeConfigUom(raw)
      expect(normalized).toBe('bulk')
      expect(isBulkUom(normalized)).toBe(true)
    }
  })

  it('still recognizes the existing discrete-unit labels', () => {
    expect(normalizeConfigUom('Bay Box')).toBe('bay_box')
    expect(normalizeConfigUom('Drum')).toBe('drum')
    expect(normalizeConfigUom('12 Qt Case')).toBe('case')
  })

  it('leaves an already-bulk label alone', () => {
    expect(normalizeConfigUom('Bulk')).toBe('bulk')
  })
})

describe('uomDisplayLabel', () => {
  it('shows a clean label for the fixed types', () => {
    expect(uomDisplayLabel('bay_box')).toBe('Bay Box')
    expect(uomDisplayLabel('drum')).toBe('Drum')
    expect(uomDisplayLabel('bulk')).toBe('Bulk')
  })

  it('shows Bulk for a legacy pre-fix tank value already stored on an old line', () => {
    expect(uomDisplayLabel('medium_tanks')).toBe('Bulk')
    expect(uomDisplayLabel('tote_tanks')).toBe('Bulk')
  })

  it('title-cases anything unrecognized instead of showing raw underscored text', () => {
    expect(uomDisplayLabel('4_gal_case')).toBe('4 Gal Case')
  })

  it('falls back to an em dash for nothing', () => {
    expect(uomDisplayLabel(null)).toBe('—')
    expect(uomDisplayLabel('')).toBe('—')
  })
})
