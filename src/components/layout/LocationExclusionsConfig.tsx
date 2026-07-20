import { useMemo, useState } from 'react'
import { useLocations } from '@/hooks/useLocations'
import {
  useLocationExclusions,
  EXCLUDABLE_COLUMNS,
  locExclusionValue,
} from '@/hooks/useLocationExclusions'

// Profile-panel section: choose a column, then pick or type values to hide
// matching locations from the Locations page, Lookup panel, and dashboard.
export function LocationExclusionsConfig() {
  const { locations } = useLocations()
  const { rules, setRules, isExcluded } = useLocationExclusions()
  const [field, setField] = useState(EXCLUDABLE_COLUMNS[0].field)
  const [custom, setCustom] = useState('')

  const currentValues = useMemo(
    () => rules.find((r) => r.field === field)?.values ?? [],
    [rules, field],
  )

  // Distinct values present for the selected column, minus ones already excluded.
  const distinct = useMemo(() => {
    const set = new Set<string>()
    for (const l of locations) {
      const v = locExclusionValue(l, field).trim()
      if (v) set.add(v)
    }
    return Array.from(set)
      .filter((v) => !currentValues.some((cv) => cv.toLowerCase() === v.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
  }, [locations, field, currentValues])

  const hiddenCount = useMemo(() => locations.filter(isExcluded).length, [locations, isExcluded])
  const labelFor = (f: string) => EXCLUDABLE_COLUMNS.find((c) => c.field === f)?.label ?? f

  function addValue(f: string, value: string) {
    const v = value.trim()
    if (!v) return
    const next = [...rules]
    const idx = next.findIndex((r) => r.field === f)
    if (idx >= 0) {
      if (!next[idx].values.some((x) => x.toLowerCase() === v.toLowerCase())) {
        next[idx] = { ...next[idx], values: [...next[idx].values, v] }
      }
    } else {
      next.push({ field: f, values: [v] })
    }
    setRules(next)
  }

  function removeValue(f: string, value: string) {
    setRules(
      rules
        .map((r) => (r.field === f ? { ...r, values: r.values.filter((x) => x !== value) } : r))
        .filter((r) => r.values.length > 0),
    )
  }

  const inputCls =
    'rounded border border-navy/30 dark:border-[#F2F1E6]/20 bg-cream dark:bg-[#0e2638] px-2 py-1.5 text-xs font-mono text-navy dark:text-[#F2F1E6] focus:border-sky focus:outline-none'

  return (
    <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
      <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">
        Location Exclusions
      </div>
      <p className="text-[10px] font-mono text-inky/60 dark:text-[#F2F1E6]/50 mb-3">
        Hide locations from the Locations page, Lookup, and dashboard. Orders, counts, and config are unaffected.
      </p>

      {/* Active rules */}
      {rules.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          {rules.map((r) => (
            <div key={r.field} className="flex flex-col gap-1">
              <span className="text-[10px] font-mono text-navy/70 dark:text-[#F2F1E6]/70 uppercase tracking-wide">
                {labelFor(r.field)}
              </span>
              <div className="flex flex-wrap gap-1">
                {r.values.map((v) => (
                  <span key={v} className="flex items-center gap-1 rounded-full bg-navy/10 dark:bg-[#F2F1E6]/10 px-2 py-0.5 text-[10px] font-mono text-navy dark:text-[#F2F1E6]">
                    {v}
                    <button
                      onClick={() => removeValue(r.field, v)}
                      className="text-inky/50 hover:text-[#C0392B] ml-0.5"
                      title="Remove"
                    >✕</button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add rule: column + value dropdown / free text */}
      <div className="flex flex-col gap-2">
        <select value={field} onChange={(e) => setField(e.target.value)} className={inputCls}>
          {EXCLUDABLE_COLUMNS.map((c) => (
            <option key={c.field} value={c.field}>{c.label}</option>
          ))}
        </select>

        <select
          value=""
          onChange={(e) => { if (e.target.value) addValue(field, e.target.value) }}
          className={inputCls}
          disabled={distinct.length === 0}
        >
          <option value="">{distinct.length ? 'Exclude a value…' : 'No values available'}</option>
          {distinct.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addValue(field, custom); setCustom('') } }}
            placeholder="…or type a value to exclude"
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={() => { addValue(field, custom); setCustom('') }}
            disabled={!custom.trim()}
            className="rounded bg-navy px-3 py-1.5 text-[10px] font-heading uppercase tracking-wide text-cream hover:bg-inky disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {rules.length > 0 && (
          <span className="text-[10px] font-mono text-inky/50 dark:text-[#F2F1E6]/40">
            {hiddenCount} location{hiddenCount !== 1 ? 's' : ''} hidden ·{' '}
            <button onClick={() => setRules([])} className="underline decoration-dotted hover:text-navy dark:hover:text-[#F2F1E6]">clear all</button>
          </span>
        )}
      </div>
    </div>
  )
}
