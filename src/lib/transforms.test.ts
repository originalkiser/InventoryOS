import { describe, it, expect } from 'vitest'
import { applyTransforms, formatPhone, type Transform } from './transforms'

describe('applyTransforms', () => {
  it('multiplies and divides by a user number', () => {
    expect(applyTransforms('10', [{ kind: 'multiply', by: 4 }])).toBe('40')
    expect(applyTransforms('10', [{ kind: 'divide', by: 4 }])).toBe('2.5')
  })

  it('gallon/quart presets', () => {
    expect(applyTransforms('3', [{ kind: 'gal_to_qt' }])).toBe('12')
    expect(applyTransforms('12', [{ kind: 'qt_to_gal' }])).toBe('3')
  })

  it('parses number after a delimiter (VALUE(TEXTAFTER))', () => {
    expect(applyTransforms('Item #42', [{ kind: 'parse_after', delimiter: '#' }])).toBe('42')
    expect(applyTransforms('SKU: 7.5 units', [{ kind: 'parse_after', delimiter: ':' }])).toBe('7.5')
  })

  it('parses number before a delimiter', () => {
    expect(applyTransforms('001 - Thomasville', [{ kind: 'parse_before', delimiter: '-' }])).toBe('001')
    expect(applyTransforms('42 | extra', [{ kind: 'parse_before', delimiter: '|' }])).toBe('42')
  })

  it('extracts the POS location number', () => {
    expect(applyTransforms('1 - Thomasville', [{ kind: 'pos_location' }])).toBe('1')
    expect(applyTransforms('12 - Raleigh North', [{ kind: 'pos_location' }])).toBe('12')
  })

  it('formats phone from the last 10 digits', () => {
    expect(formatPhone('+1 (336) 555-1234')).toBe('(336) 555-1234')
    expect(formatPhone('13365551234')).toBe('(336) 555-1234')
    expect(formatPhone('555')).toBe('555') // too short → raw
  })

  it('strips currency symbols to a numeric string', () => {
    expect(applyTransforms('$1,234.50', [{ kind: 'currency' }])).toBe('1234.5')
  })

  it('chains transforms in order', () => {
    // "Tank #100" → after '#' = 100 → ÷4 = 25
    const chain: Transform[] = [{ kind: 'parse_after', delimiter: '#' }, { kind: 'divide', by: 4 }]
    expect(applyTransforms('Tank #100', chain)).toBe('25')
  })

  it('parses a date to yyyy-MM-dd', () => {
    expect(applyTransforms('2026-06-13T09:30:00Z', [{ kind: 'date' }])).toBe('2026-06-13')
  })
})
