// Month End's own shop-exclusion settings (2026-09-28 ask) — a company-wide
// list (persists across sessions AND months, unlike a per-user preference)
// of shops to leave out of Month End's aggregate totals. See
// useMonthEndExclusions.ts's own header comment for why this is a new,
// separate mechanism rather than reusing core.location_exclusions (that one
// is per-user and explicitly excludes Month End by design).
import { useMemo, useState } from 'react'
import { Card, CardBody, Input, Select } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useMonthEndExclusions, type MonthEndExclusionReason } from './useMonthEndExclusions'

const REASON_OPTIONS = [
  { value: '', label: 'Included' },
  { value: 'overview_only', label: 'Overview Only' },
  { value: 'everything', label: 'Everywhere (all Month End tabs)' },
]

export function ExclusionsTab() {
  const loc = useLocations()
  const { exclusions, setReason, loaded } = useMonthEndExclusions()
  const [search, setSearch] = useState('')

  const reasonByShop = useMemo(() => new Map(exclusions.map((e) => [e.location_id, e.reason])), [exclusions])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return loc.options
      .filter((o) => !q || o.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [loc.options, search])

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
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shops…" className="w-72" />
          {!loaded ? (
            <p className="text-xs font-mono text-inky/50">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs font-mono text-inky/50">No shops match.</p>
          ) : (
            <div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="sticky top-0 border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left">Shop</th>
                    <th className="px-3 py-2 text-left w-72">Exclusion</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.value} className="border-b border-navy/20">
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
