import { describe, it, expect } from 'vitest'
import { normalizeFilter, packFilter, rowMatchesFilter, numMatches, filterActiveCount } from './columnFilterValue'

describe('column filter values', () => {
  it('treats a bare array as the legacy list filter', () => {
    expect(rowMatchesFilter(['a', 'b'], { value: 'a' })).toBe(true)
    expect(rowMatchesFilter(['a', 'b'], { value: 'c' })).toBe(false)
    expect(rowMatchesFilter([], { value: 'c' })).toBe(true)
  })
  it('numeric: less than / greater than / between (inclusive, either order)', () => {
    expect(numMatches(5, { op: 'lt', a: 10 })).toBe(true)
    expect(numMatches(10, { op: 'lt', a: 10 })).toBe(false)
    expect(numMatches(11, { op: 'gt', a: 10 })).toBe(true)
    expect(numMatches(10, { op: 'between', a: 5, b: 10 })).toBe(true)
    expect(numMatches(7, { op: 'between', a: 10, b: 5 })).toBe(true)
    expect(numMatches(null, { op: 'gt', a: 0 })).toBe(false)
  })
  it('combines list + number + color tests with AND', () => {
    const f = { kind: 'adv' as const, num: { op: 'gt' as const, a: 10 }, colors: ['red'] }
    expect(rowMatchesFilter(f, { value: 20, color: 'red' })).toBe(true)
    expect(rowMatchesFilter(f, { value: 20, color: 'green' })).toBe(false)
    expect(rowMatchesFilter(f, { value: 5, color: 'red' })).toBe(false)
  })
  it('multi-valued rows match when ANY value is in the list', () => {
    expect(rowMatchesFilter(['Over capacity'], { value: '', multi: ['Case min', 'Over capacity'] })).toBe(true)
    expect(rowMatchesFilter(['Out of stock'], { value: '', multi: ['Case min'] })).toBe(false)
  })
  it('packs to the smallest representation and counts active parts', () => {
    expect(packFilter(normalizeFilter(undefined))).toBeUndefined()
    expect(packFilter({ list: ['a'], num: null, colors: [] })).toEqual(['a'])
    expect(filterActiveCount({ kind: 'adv', list: ['a'], num: { op: 'lt', a: 1 }, colors: ['red', 'green'] })).toBe(4)
  })
})
