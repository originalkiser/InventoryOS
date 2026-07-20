import { useMemo, useState } from 'react'
import { useLocations } from '@/hooks/useLocations'
import {
  useLocationExclusions,
  EXCLUDABLE_COLUMNS,
  locExclusionValue,
} from '@/hooks/useLocationExclusions'

// Profile-panel section: choose a column, then multi-select or type values to
// hide matching locations from the Locations page, Lookup panel, and dashboard.
export function LocationExclusionsConfig() {
  const { locations } = useLocations()
  const { rules, setRules, isExcluded } = useLocationExclusions()
  const [field, setField] = useState(EXCLUDABLE_COLUMNS[0].field)
  const [custom, setCustom] = useState('')

  const currentValues = useMemo(
    () => rules.find((r) => r.field === field)?.values ?? [],
    [rules, field],
  )

  // All distinct values for the selected column (with a count of matching
  // locations), unioned with any already-excluded values so typed-in entries
  // still appear as checked options.
  const options = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of locations) {
      const v = locExclusionValue(l, field).trim()
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    for (const v of currentValues) if (!counts.has(v)) counts.set(v, 0)
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }))
  }, [locations, field, currentValues])

  const hiddenCount = useMemo(() => locations.filter(isExcluded).length, [locations, isExcluded])
  const labelFor = (f: string) => EXCLUDABLE_COLUMNS.find((c) => c.field === f)?.label ?? f

  // Replace the selected column's excluded values (drop the rule if empty).
  function setValuesForField(f: string, values: string[]) {
    const others = rules.filter((r) => r.field !== f)
    setRules(values.length ? [...others, { field: f, values }] : others)
  }

  function toggleValue(value: string) {
    if (currentValues.some((x) => x.toLowerCase() === value.toLowerCase())) {
      setValuesForField(field, currentValues.filter((x) => x.toLowerCase() !== value.toLowerCase()))
    } else {
      setValuesForField(field, [...currentValues, value])
    }
  }

  function addCustom() {
    const v = custom.trim()
    if (!v) return
    if (!currentValues.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setValuesForField(field, [...currentValues, v])
    }
    setCustom('')
  }

  function removeValue(f: string, value: string) {
    setValuesForField(f, (rules.find((r) => r.field === f)?.values ?? []).filter((x) => x !== value))
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

      {/* Active rules across all columns */}
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

      {/* Add / edit: column + multi-select values + free text */}
      <div className="flex flex-col gap-2">
        <select value={field} onChange={(e) => setField(e.target.value)} className={inputCls}>
          {EXCLUDABLE_COLUMNS.map((c) => (
            <option key={c.field} value={c.field}>{c.label}</option>
          ))}
        </select>

        {/* Inline multi-select checklist — check every value to exclude */}
        {options.length > 0 ? (
          <div className="max-h-40 overflow-y-auto rounded border border-navy/30 dark:border-[#F2F1E6]/20 bg-cream dark:bg-[#0e2638] p-1 flex flex-col gap-px">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-navy/5 dark:hover:bg-[#F2F1E6]/5 select-none">
                <input
                  type="checkbox"
                  checked={currentValues.some((x) => x.toLowerCase() === o.value.toLowerCase())}
                  onChange={() => toggleValue(o.value)}
                  className="accent-navy w-3.5 h-3.5 shrink-0"
                />
                <span className="text-xs font-mono text-navy dark:text-[#F2F1E6] flex-1 truncate">{o.value}</span>
                <span className="text-[10px] font-mono text-inky/40 shrink-0">{o.count}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-[10px] font-mono text-inky/50 dark:text-[#F2F1E6]/40 px-1">No values available for this column.</p>
        )}

        <div className="flex items-center gap-2">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }}
            placeholder="…or type a value to exclude"
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={addCustom}
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
