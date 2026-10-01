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
import { SbLoader } from '@/components/ui'
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

export function RecapTab() {
  const recap = useMonthEndRecap()

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
        deck (it predates this app's own day-by-day tracking), editable the same as any cell below, and re-uploadable
        via each section's Upload button. September onward can be entered the same way until live tracking is built
        for it.
      </p>

      <Card><CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Daily Month-End Count Compliance</h2>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">August 2026 count cycle (Mon 8/24 - Mon 8/31).</p>
        </div>
        <ListSection title="Notes" items={recap.listOf('daily_compliance')}
          onAdd={(t) => recap.addListItem('daily_compliance', t)}
          onSave={recap.saveListItem} onDelete={recap.deleteListItem}
          onMove={(id, dir) => recap.moveListItem('daily_compliance', id, dir)} />
        <GridSection title="Daily Month-End Count Compliance" slideKey="monthend_recap" tableKey="daily_compliance"
          cells={recap.gridOf('daily_compliance')} format="number"
          rowFormats={{ 'Percent Complete': 'percent' }}
          onSaveCell={saveCell('daily_compliance')} onDeleteRow={deleteRow('daily_compliance')} onUpload={upload('daily_compliance')} />
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
