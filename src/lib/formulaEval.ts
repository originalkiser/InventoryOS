// Safe arithmetic evaluator for Form Builder's "Formula" calculating field
// (2026-09-16) — no eval()/new Function(), a hand-written recursive-descent
// parser over +, -, *, /, parentheses, and numeric literals only, so a
// user-typed formula string can never execute arbitrary code.

/** Evaluates a plain arithmetic expression (already free of field tokens). Returns null on any parse/eval error rather than throwing. */
export function evaluateArithmetic(expr: string): number | null {
  const s = expr
  let i = 0

  // Whitespace is only a token separator, never stripped up front — doing
  // that previously let "2 3" silently collapse into the single number 23
  // instead of being rejected as two tokens with no operator between them.
  function skipSpace() { while (i < s.length && /\s/.test(s[i])) i++ }
  function peek(): string | undefined { skipSpace(); return s[i] }

  function parseExpr(): number {
    let value = parseTerm()
    for (;;) {
      const c = peek()
      if (c === '+') { i++; value += parseTerm() }
      else if (c === '-') { i++; value -= parseTerm() }
      else break
    }
    return value
  }
  function parseTerm(): number {
    let value = parseFactor()
    for (;;) {
      const c = peek()
      if (c === '*') { i++; value *= parseFactor() }
      else if (c === '/') { i++; const d = parseFactor(); if (d === 0) throw new Error('division by zero'); value /= d }
      else break
    }
    return value
  }
  function parseFactor(): number {
    const c = peek()
    if (c === '+') { i++; return parseFactor() }
    if (c === '-') { i++; return -parseFactor() }
    if (c === '(') {
      i++
      const v = parseExpr()
      if (peek() !== ')') throw new Error('unbalanced parens')
      i++
      return v
    }
    skipSpace()
    const start = i
    while (i < s.length && /[0-9.]/.test(s[i])) i++
    if (start === i) throw new Error('unexpected token')
    const num = Number(s.slice(start, i))
    if (Number.isNaN(num)) throw new Error('bad number')
    return num
  }

  if (!s.trim()) return null
  try {
    const result = parseExpr()
    skipSpace()
    if (i !== s.length) return null // trailing garbage — malformed expression
    return Number.isFinite(result) ? result : null
  } catch {
    return null
  }
}

/**
 * Substitutes `{Field Label}` tokens (case-insensitive, whitespace-trimmed
 * match against `valuesByLabel`'s keys) with their numeric value wrapped in
 * parens, then evaluates the result. A referenced field with no numeric
 * value yet makes the WHOLE formula return null rather than treating the
 * gap as 0 — a partially-filled-out form shouldn't show a confident-looking
 * calculated number built on a silent zero.
 */
export function evaluateFieldFormula(formula: string, valuesByLabel: Record<string, number | null>): number | null {
  if (!formula.trim()) return null
  let unresolved = false
  const entries = Object.entries(valuesByLabel)
  const substituted = formula.replace(/\{([^{}]+)\}/g, (_m, rawLabel: string) => {
    const key = rawLabel.trim().toLowerCase()
    const match = entries.find(([label]) => label.trim().toLowerCase() === key)
    const val = match?.[1]
    if (val == null || Number.isNaN(val)) { unresolved = true; return '0' }
    return `(${val})`
  })
  if (unresolved) return null
  return evaluateArithmetic(substituted)
}
