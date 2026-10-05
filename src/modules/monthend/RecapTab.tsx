// Month End Count Recap — direct ask 2026-10-02, recreates the hand-built
// "Month End Count Recap" exec deck's 3 content slides natively instead of
// a one-off PowerPoint each month. Reuses Procurement Deck's generic
// GridSection/ListSection components (see useMonthEndRecap.ts's own header
// comment for why this feature gets its own tables rather than reusing
// procurement_deck_grid_cells directly).
//
// March-August 2026 are seeded verbatim from that deck (migration
// 20260930ca) — they predate this app's own live tracking (inventory.counts
// only goes back to June 2026, recount_requests only to Aug 19, 2026) and
// can never be recomputed; they're still editable/re-uploadable here like
// any other cell. September 2026 onward is a deliberate scope cut for this
// first pass — building a correct live day-by-day recompute (matching
// RecountLogicTab's own median-variance rule and counts.uploaded_at
// granularity exactly) is a bigger follow-up; for now, new months are
// entered/edited the same way any seeded cell is.
import { useMemo, useState } from 'react'
import { SbLoader, Button } from '@/components/ui'
import toast from 'react-hot-toast'
import { Card, CardBody } from '@/components/ui'
import { GridSection } from '@/modules/inventory/procurementDeck/GridSection'
import { ListSection } from '@/modules/inventory/procurementDeck/ListSection'
import { useMonthEndRecap } from './useMonthEndRecap'

const REGION_ROWS = [
  'Central - Ryan Bolden',
  'East - Robert Soler',
  'Midwest - Thomas Huffman',
  'North - Andy Martin',
  'West - Jay Johnson',
]

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Last month's first day as YYYY-MM-01 — the month most likely to be recapped. */
function defaultMonth(): string {
  const d = new Date(); d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function RecapTab() {
  const recap = useMonthEndRecap()
  const [month, setMonth] = useState(defaultMonth())
  const [filling, setFilling] = useState(false)
  const [fillNote, setFillNote] = useState<string | null>(null)
  // Daily compliance is one count cycle at a time: August's seeded one plus any month filled in from the app's own data.
  const cycles = useMemo(() => {
    const keys = [...new Set(recap.cells.map((c) => c.table_key).filter((k) => k === 'daily_compliance' || /^daily_compliance_\d{6}$/.test(k)))]
    const label = (k: string) => (k === 'daily_compliance' ? 'August 2026' : `${MONTH_NAMES[Number(k.slice(-2)) - 1]} ${k.slice(-6, -2)}`)
    return keys.sort((a, b) => (a === 'daily_compliance' ? '202608' : a.slice(-6)).localeCompare(b === 'daily_compliance' ? '202608' : b.slice(-6)))
      .map((k) => ({ key: k, label: label(k) }))
  }, [recap.cells])
  const [cycleKey, setCycleKey] = useState<string | null>(null)
  const activeCycle = cycleKey && cycles.some((c) => c.key === cycleKey) ? cycleKey : (cycles[cycles.length - 1]?.key ?? 'daily_compliance')

  async function fill() {
    setFilling(true); setFillNote(null)
    const r = await recap.fillMonth(`${month}-01`)
    setFilling(false)
    if (!r) return
    setCycleKey(r.cycleKey)
    const t = r.result.trends
    setFillNote(
      `${r.result.monthLabel}: ${r.result.totalShops} shops — ${t.complete} complete, ${t.recount} recount, ${t.partial} partial recount, ${t.notSubmitted} not submitted. ` +
      `Count cycle starts Monday ${r.result.cycleStart}.` +
      (r.added.length ? ` Added area manager row${r.added.length === 1 ? '' : 's'} not in the deck: ${r.added.join(', ')}.` : ''),
    )
    toast.success(`Filled in ${r.result.monthLabel} from the app's data`)
  }

  const saveCell = (tableKey: string) =>
    (rowLabel: string, rowSort: number, colKey: string, colLabel: string, colSort: number, value: number | null) =>
      recap.saveCell(tableKey, rowLabel, rowSort, colKey, colLabel, colSort, value)
  const deleteRow = (tableKey: string) => (rowLabel: string) => recap.deleteGridRow(tableKey, rowLabel)
  const upload = (tableKey: string) => (headers: string[], rows: Record<string, string>[]) => recap.uploadGrid(tableKey, headers, rows)

  if (recap.loading) return <div className="py-10 flex justify-center"><SbLoader size={32} /></div>

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs font-mono text-inky/60 max-w-3xl">
        Recreates the monthly "Month End Count Recap" deck natively — March through August 2026 are seeded from that
        deck, editable the same as any cell below and re-uploadable via each section's Upload button. Later months can
        be filled in from the app's own counts, manual "marked counted" entries and recount requests with the button
        below (shops = active corporate shops in the deck's five regions; a shop is "complete" once it has a Weekly/Monthly-type
        count and any recount it was asked for is done). Anything it writes is an ordinary editable cell.
      </p>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-0.5 text-[11px] font-mono text-inky/60">Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-sm font-mono text-navy" />
        </label>
        <Button size="sm" loading={filling} onClick={() => void fill()}>Fill from app data</Button>
        {fillNote && <p className="text-[11px] font-mono text-navy max-w-3xl">{fillNote}</p>}
      </div>

      <Card><CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Daily Month-End Count Compliance</h2>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[11px] font-mono text-inky/60">Count cycle:</span>
            {cycles.map((c) => (
              <button key={c.key} type="button" onClick={() => setCycleKey(c.key)}
                className={`text-[11px] font-mono rounded border px-2 py-0.5 ${c.key === activeCycle ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <ListSection title="Notes" items={recap.listOf(activeCycle)}
          onAdd={(t) => recap.addListItem(activeCycle, t)}
          onSave={recap.saveListItem} onDelete={recap.deleteListItem}
          onMove={(id, dir) => recap.moveListItem(activeCycle, id, dir)} />
        <GridSection key={activeCycle} title="Daily Month-End Count Compliance" slideKey="monthend_recap" tableKey={activeCycle}
          cells={recap.gridOf(activeCycle)} format="number"
          rowFormats={{ 'Percent Complete': 'percent' }}
          onSaveCell={saveCell(activeCycle)} onDeleteRow={deleteRow(activeCycle)} onUpload={upload(activeCycle)} />
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Recount Compliance by Area</h2>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">Monthly recount rate by region and area manager.</p>
        </div>
        <ListSection title="Notes" items={recap.listOf('area_compliance')}
          onAdd={(t) => recap.addListItem('area_compliance', t)}
          onSave={recap.saveListItem} onDelete={recap.deleteListItem}
          onMove={(id, dir) => recap.moveListItem('area_compliance', id, dir)} />
        <GridSection title="Recount Compliance by Area" slideKey="monthend_recap" tableKey="area_compliance"
          cells={recap.gridOf('area_compliance')} format="percent"
          chart={{ rows: REGION_ROWS, lineRows: REGION_ROWS }}
          onSaveCell={saveCell('area_compliance')} onDeleteRow={deleteRow('area_compliance')} onUpload={upload('area_compliance')} />
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Compliance Trends MoM</h2>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">Month-over-month comparison: initial completion accuracy.</p>
        </div>
        <GridSection title="Initial Completion Accuracy" slideKey="monthend_recap" tableKey="trends"
          cells={recap.gridOf('trends')} format="number"
          chart={{ rows: ['Complete', 'Recount', 'Partial Recount', 'Not Submitted'], stacked: true }}
          onSaveCell={saveCell('trends')} onDeleteRow={deleteRow('trends')} onUpload={upload('trends')} />
      </CardBody></Card>
    </div>
  )
}
