import { describe, expect, it } from 'vitest'
import { evaluateArithmetic, evaluateFieldFormula } from './formulaEval'

describe('evaluateArithmetic', () => {
  it('handles basic operator precedence', () => {
    expect(evaluateArithmetic('2 + 3 * 4')).toBe(14)
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20)
  })
  it('handles negative numbers and unary plus', () => {
    expect(evaluateArithmetic('-5 + 3')).toBe(-2)
    expect(evaluateArithmetic('+5 - -3')).toBe(8)
  })
  it('handles decimals', () => {
    expect(evaluateArithmetic('1.5 * 2')).toBeCloseTo(3)
  })
  it('returns null on division by zero rather than throwing/Infinity', () => {
    expect(evaluateArithmetic('5 / 0')).toBeNull()
  })
  it('returns null on malformed input', () => {
    expect(evaluateArithmetic('2 + ')).toBeNull()
    expect(evaluateArithmetic('2 + (3')).toBeNull()
    expect(evaluateArithmetic('2 3')).toBeNull()
    expect(evaluateArithmetic('')).toBeNull()
  })
  it('never uses eval/Function — a string that looks like JS does not execute', () => {
    // Should just fail to parse as arithmetic, not run anything.
    expect(evaluateArithmetic('alert(1)')).toBeNull()
  })
})

describe('evaluateFieldFormula', () => {
  it('substitutes {Field Label} tokens and evaluates', () => {
    const result = evaluateFieldFormula('{Package Price} + {Filter Cost}', {
      'Package Price': 89.99,
      'Filter Cost': 8.5,
    })
    expect(result).toBeCloseTo(98.49)
  })
  it('is case-insensitive and trims whitespace in label matching', () => {
    const result = evaluateFieldFormula('{ package price }', { 'Package Price': 10 })
    expect(result).toBe(10)
  })
  it('returns null when a referenced field has no value yet (does not silently treat as 0)', () => {
    const result = evaluateFieldFormula('{Price} + {Tax}', { Price: 10, Tax: null })
    expect(result).toBeNull()
  })
  it('returns null for a blank formula', () => {
    expect(evaluateFieldFormula('', { Price: 10 })).toBeNull()
  })
  it('handles a formula with parentheses across multiple fields', () => {
    const result = evaluateFieldFormula('({A} + {B}) * {C}', { A: 2, B: 3, C: 4 })
    expect(result).toBe(20)
  })
})
