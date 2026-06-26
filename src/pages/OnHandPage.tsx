import { useEffect, useMemo, useState } from 'react'
import { useInventory, type InventoryRow } from '@/hooks/useInventory'
import { useLocations } from '@/hooks/useLocations'
import { FLAG_HEX, type FlagColor } from '@/lib/flagScale'
import { Modal, Button } from '@/components/ui'
import { FlagScaleEditor } from '@/components/inventory/InventoryView'

const SORT_KEY = 'onhand.sort'
const EXTRA_COLS_KEY = 'onhand.extraCols'

function dosText(d: number | null, onHands: number | null): string {
  if (d == null) return onHands != null && onHands > 0 ? '∞' : '—'
  return d.toFixed(1)
}

interface LocCol { key: string; label: string }

// ── Sortable column header ─────────────────────────────────────────────────
interface THProps {
  label: string
  sortKey?: string
  sort: { key: string; dir: 'asc' | 'desc' }
  onSort: (k: string) => void
  right?: boolean
}
function TH({ label, sortKey, sort, onSort, right }: THProps) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={sortKey ? () => onSort(sortKey) : undefined}
      className={[
        'px-2 py-1.5 whitespace-nowrap',
        right ? 'text-right' : 'text-left',
        sortKey ? 'cursor-pointer hover:opacity-80 select-none' : '',
      ].join(' ')}
    >
      {label}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

// ── Column picker modal ────────────────────────────────────────────────────
function ColsModal({ available, selected, onToggle, onClose }: {
  available: LocCol[]
  selected: string[]
  onToggle: (key: string) => void
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose} title="Location Columns">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-body text-inky">
          Add columns from location data alongside inventory rows.
        </p>
        <div className="flex flex-col gap-0.5 max-h-72 overflow-auto">
          {available.length === 0 ? (
            <p className="text-xs text-inky/60 italic py-2">
              No location fields found — upload locations with metadata first.
            </p>
          ) : available.map((c) => (
            <label key={c.key} className="flex items-center gap-2 cursor-pointer rounded px-1 py-1 hover:bg-navy/5">
              <input
                type="checkbox"
                checked={selected.includes(c.key)}
                onChange={() => onToggle(c.key)}
                className="accent-sky cursor-pointer"
              />
              <span className="text-xs font-body text-navy">{c.label}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Flag filter options ────────────────────────────────────────────────────
const FLAG_OPTS: Array<{ value: FlagColor | 'none' | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'red', label: 'Red' },
  { value: 'amber', label: 'Amber' },
  { value: 'green', label: 'Green' },
  { value: 'none', label: 'No flag' },
]

// ── Page ───────────────────────────────────────────────────────────────────
export function OnHandPage() {
  const { rows, flagConfig, setFlagConfig, loading } = useInventory()
  const loc = useLocations()

  const [search, setSearch] = useState('')
  const [flagFilter, setFlagFilter] = useState<FlagColor | 'none' | null>(null)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>(() => {
    try { return JSON.parse(localStorage.getItem(SORT_KEY) || 'null') ?? { key: 'days_of_supply', dir: 'asc' } }
    catch { return { key: 'days_of_supply', dir: 'asc' } }
  })
  const [extraCols, setExtraCols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(EXTRA_COLS_KEY) || '[]') }
    catch { return [] }
  })
  const [colsOpen, setColsOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => { localStorage.setItem(SORT_KEY, JSON.stringify(sort)) }, [sort])
  useEffect(() => { localStorage.setItem(EXTRA_COLS_KEY, JSON.stringify(extraCols)) }, [extraCols])

  // Derive available location columns from base fields + all metadata keys in use
  const availableLocCols = useMemo<LocCol[]>(() => {
    const metaKeys = new Set<string>()
    for (const l of loc.locations) {
      const m = l.metadata
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        for (const k of Object.keys(m as Record<string, unknown>)) metaKeys.add(k)
      }
    }
    return [
      { key: 'region', label: 'Region' },
      { key: 'name', label: 'Name' },
      ...Array.from(metaKeys).sort().map((k) => ({
        key: k,
        label: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    ]
  }, [loc.locations])

  // Only the selected columns that actually exist in availableLocCols (in selection order)
  const selectedLocCols = useMemo(
    () => extraCols.map((k) => availableLocCols.find((c) => c.key === k)).filter(Boolean) as LocCol[],
    [extraCols, availableLocCols]
  )

  // Filter + sort
  const view = useMemo(() => {
    const q = search.trim().toLowerCase()
    let r = q
      ? rows.filter((x) => x.product_id.toLowerCase().includes(q) || x.location_label.toLowerCase().includes(q))
      : rows
    if (flagFilter === 'none') r = r.filter((x) => x.flag === null)
    else if (flagFilter) r = r.filter((x) => x.flag === flagFilter)

    const { key, dir } = sort
    r = [...r].sort((a, b) => {
      if (key === 'days_of_supply') {
        const av = a.days_of_supply ?? Infinity, bv = b.days_of_supply ?? Infinity
        return dir === 'asc' ? av - bv : bv - av
      }
      if (key === 'location_label' || key === 'product_id') {
        const av = String(a[key as keyof InventoryRow] ?? '')
        const bv = String(b[key as keyof InventoryRow] ?? '')
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      // Location metadata / base column sort
      const av = loc.fieldValue(a.location_id, key)
      const bv = loc.fieldValue(b.location_id, key)
      return dir === 'asc'
        ? av.localeCompare(bv, undefined, { numeric: true })
        : bv.localeCompare(av, undefined, { numeric: true })
    })
    return r
  }, [rows, search, flagFilter, sort, loc])

  const lowCount = rows.filter((r) => r.low).length
  const colCount = 5 + selectedLocCols.length

  function toggleSort(key: string) {
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))
  }

  function toggleExtraCol(key: string) {
    setExtraCols((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])
  }

  function handleExport() {
    const cols = [
      { label: 'Location', get: (r: InventoryRow) => loc.codeOf(r.location_id) },
      { label: 'Product', get: (r: InventoryRow) => r.product_id },
      ...selectedLocCols.map((c) => ({
        label: c.label,
        get: (r: InventoryRow) => loc.fieldValue(r.location_id, c.key),
      })),
      { label: 'On Hand', get: (r: InventoryRow) => String(r.on_hands ?? '') },
      { label: 'Usage/day', get: (r: InventoryRow) => String(r.daily_usage ?? '') },
      { label: 'Days of Supply', get: (r: InventoryRow) => r.days_of_supply != null ? r.days_of_supply.toFixed(1) : '' },
      { label: 'Flag', get: (r: InventoryRow) => r.flag ?? '' },
    ]
    const esc = (v: string) =>
      v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v
    const lines = [
      cols.map((c) => c.label).join(','),
      ...view.map((r) => cols.map((c) => esc(c.get(r))).join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'on_hand.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">On Hand</h1>
          <p className="text-xs text-inky mt-0.5">
            {loading ? 'Loading…' : (
              <>
                {view.length.toLocaleString()} of {rows.length.toLocaleString()} rows
                {flagFilter && <> · <span className="font-semibold">{flagFilter === 'none' ? 'unflagged' : flagFilter}</span> only</>}
              </>
            )}
          </p>
        </div>
        <button
          onClick={handleExport}
          className="rounded border border-navy/30 px-3 py-1.5 text-xs font-mono text-inky hover:text-navy hover:border-navy transition-colors"
        >
          ↓ Export CSV
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter products / locations…"
          className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none w-52"
        />

        {/* Flag filter pills */}
        <div className="flex items-center gap-1">
          {FLAG_OPTS.map((f) => {
            const active = flagFilter === f.value
            const dotColor = f.value && f.value !== 'none' ? FLAG_HEX[f.value as FlagColor] : undefined
            return (
              <button
                key={String(f.value)}
                onClick={() => setFlagFilter(active ? null : f.value)}
                className={[
                  'flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono border transition-colors',
                  active ? 'bg-navy text-cream border-navy' : 'border-navy/30 text-inky hover:border-navy',
                ].join(' ')}
              >
                {dotColor && (
                  <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                )}
                {f.label}
              </button>
            )
          })}
        </div>

        {lowCount > 0 && (
          <span className="text-xs font-mono" style={{ color: FLAG_HEX.red }}>
            {lowCount} below threshold
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setColsOpen(true)}
            className="rounded border border-navy/30 px-2 py-1 text-xs font-mono text-inky hover:text-navy hover:border-navy transition-colors"
          >
            Columns{selectedLocCols.length > 0 ? ` +${selectedLocCols.length}` : ''}
          </button>
          <button
            onClick={() => setEditorOpen(true)}
            className="rounded border border-navy/30 px-2 py-1 text-xs font-mono text-inky hover:text-navy hover:border-navy transition-colors"
          >
            ⚙ Scale
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-auto max-h-[calc(100vh-280px)] rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-navy text-inky uppercase tracking-wide">
            <tr>
              <TH label="Location" sortKey="location_label" sort={sort} onSort={toggleSort} />
              <TH label="Product" sortKey="product_id" sort={sort} onSort={toggleSort} />
              {selectedLocCols.map((c) => (
                <TH key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={toggleSort} />
              ))}
              <TH label="On Hand" sort={sort} onSort={toggleSort} right />
              <TH label="Usage/day" sort={sort} onSort={toggleSort} right />
              <TH label="Days" sortKey="days_of_supply" sort={sort} onSort={toggleSort} right />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="px-2 py-8 text-center text-inky/60">Loading…</td></tr>
            ) : view.length === 0 ? (
              <tr><td colSpan={colCount} className="px-2 py-8 text-center text-inky/60">No results</td></tr>
            ) : view.map((r) => (
              <tr
                key={r.id}
                className="border-t border-navy/10"
                style={r.flag ? { borderLeft: `3px solid ${FLAG_HEX[r.flag]}` } : undefined}
              >
                <td className="px-2 py-1 text-navy">{loc.codeOf(r.location_id)}</td>
                <td className="px-2 py-1 text-navy">{r.product_id}</td>
                {selectedLocCols.map((c) => (
                  <td key={c.key} className="px-2 py-1 text-inky">
                    {loc.fieldValue(r.location_id, c.key) || '—'}
                  </td>
                ))}
                <td className="px-2 py-1 text-right text-inky">{r.on_hands ?? '—'}</td>
                <td className="px-2 py-1 text-right text-inky">{r.daily_usage ?? '—'}</td>
                <td
                  className="px-2 py-1 text-right font-semibold"
                  style={{ color: r.flag ? FLAG_HEX[r.flag] : '#9ca3af' }}
                >
                  {dosText(r.days_of_supply, r.on_hands)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {colsOpen && (
        <ColsModal
          available={availableLocCols}
          selected={extraCols}
          onToggle={toggleExtraCol}
          onClose={() => setColsOpen(false)}
        />
      )}

      <Modal open={editorOpen} onClose={() => setEditorOpen(false)} title="Days-of-Supply Flag Scale" size="lg">
        <FlagScaleEditor config={flagConfig} onChange={setFlagConfig} onClose={() => setEditorOpen(false)} />
      </Modal>
    </div>
  )
}
