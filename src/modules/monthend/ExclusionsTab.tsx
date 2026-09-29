// Month End's own shop-exclusion settings (2026-09-28 ask, extended
// 2026-09-28 follow-up with AM/Region filters + multi-select bulk update) —
// a company-wide list (persists across sessions AND months, unlike a
// per-user preference) of shops to leave out of Month End's aggregate
// totals. See useMonthEndExclusions.ts's own header comment for why this is
// a new, separate mechanism rather than reusing core.location_exclusions
// (that one is per-user and explicitly excludes Month End by design).
import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Input, Select } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useMonthEndExclusions, type MonthEndExclusionReason } from './useMonthEndExclusions'

const REASON_OPTIONS = [
  { value: '', label: 'Included' },
  { value: 'overview_only', label: 'Overview Only' },
  { value: 'everything', label: 'Everywhere (all Month End tabs)' },
]
const BULK_REASON_OPTIONS = [
  { value: 'overview_only', label: 'Overview Only' },
  { value: 'everything', label: 'Everywhere (all Month End tabs)' },
  { value: 'clear', label: 'Clear exclusion (include again)' },
]

export function ExclusionsTab() {
  const loc = useLocations()
  const { exclusions, setReason, setReasonBulk, loaded } = useMonthEndExclusions()
  const [search, setSearch] = useState('')
  const [amFilter, setAmFilter] = useState('')
  const [regionFilter, setRegionFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkReason, setBulkReason] = useState('overview_only')

  const reasonByShop = useMemo(() => new Map(exclusions.map((e) => [e.location_id, e.reason])), [exclusions])

  const amOptions = useMemo(() => {
    const s = new Set(loc.locations.map((l) => (l.area_manager ?? '').trim()).filter(Boolean))
    return [{ value: '', label: 'All Area Managers' }, ...[...s].sort().map((v) => ({ value: v, label: v }))]
  }, [loc.locations])
  const regionOptions = useMemo(() => {
    const s = new Set(loc.locations.map((l) => (l.region ?? '').trim()).filter(Boolean))
    return [{ value: '', label: 'All Regions' }, ...[...s].sort().map((v) => ({ value: v, label: v }))]
  }, [loc.locations])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const byId = new Map(loc.locations.map((l) => [l.id, l]))
    return loc.options
      .filter((o) => !q || o.label.toLowerCase().includes(q))
      .filter((o) => !amFilter || (byId.get(o.value)?.area_manager ?? '').trim() === amFilter)
      .filter((o) => !regionFilter || (byId.get(o.value)?.region ?? '').trim() === regionFilter)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [loc.locations, loc.options, search, amFilter, regionFilter])

  const allFilteredSelected = rows.length > 0 && rows.every((r) => selected.has(r.value))
  function toggleAllFiltered() {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev)
        for (const r of rows) next.delete(r.value)
        return next
      }
      const next = new Set(prev)
      for (const r of rows) next.add(r.value)
      return next
    })
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function applyBulk() {
    if (!selected.size) return
    setReasonBulk([...selected], bulkReason === 'clear' ? null : (bulkReason as MonthEndExclusionReason))
    toast.success(`Updated ${selected.size} shop${selected.size === 1 ? '' : 's'}`)
    setSelected(new Set())
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Month End Exclusions</h2>
        <p className="text-xs text-inky mt-0.5">
          Exclude specific shops from Month End's own aggregate totals — persists across sessions and months, for
          every user. <strong>Overview Only</strong> hides a shop just from the Overview tab's totals/table/outliers;{' '}
          <strong>Everywhere</strong> hides it from every Month End tab.
        </p>
      </div>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shops…" className="w-56" />
            <div className="w-48"><Select value={amFilter} onChange={(e) => setAmFilter(e.target.value)} options={amOptions} /></div>
            <div className="w-48"><Select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} options={regionOptions} /></div>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-sky/60 bg-sky/10 px-3 py-2">
              <span className="text-xs font-mono text-navy">{selected.size} selected</span>
              <div className="w-64">
                <Select value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} options={BULK_REASON_OPTIONS} />
              </div>
              <Button size="sm" onClick={applyBulk}>Apply to {selected.size} selected</Button>
              <button type="button" onClick={() => setSelected(new Set())} className="text-[10px] font-mono text-inky/60 hover:underline">
                Clear selection
              </button>
            </div>
          )}

          {!loaded ? (
            <p className="text-xs font-mono text-inky/50">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs font-mono text-inky/50">No shops match.</p>
          ) : (
            <div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="sticky top-0 border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 w-8">
                      <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} className="accent-sky cursor-pointer" />
                    </th>
                    <th className="px-3 py-2 text-left">Shop</th>
                    <th className="px-3 py-2 text-left w-72">Exclusion</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.value} className="border-b border-navy/20">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggleOne(o.value)} className="accent-sky cursor-pointer" />
                      </td>
                      <td className="px-3 py-2 text-navy">{o.label}</td>
                      <td className="px-3 py-2">
                        <Select
                          value={reasonByShop.get(o.value) ?? ''}
                          onChange={(e) => setReason(o.value, (e.target.value || null) as MonthEndExclusionReason | null)}
                          options={REASON_OPTIONS}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
