import { Tabs, TabsList, TabsTrigger, TabsContent, SbLoader } from '@/components/ui'
import { useProcurementDeck } from './procurementDeck/useProcurementDeck'
import { GridSection } from './procurementDeck/GridSection'
import { KpiSection } from './procurementDeck/KpiSection'
import { ListSection } from './procurementDeck/ListSection'

// Mirrors the monthly "Procurement Update" exec deck one tab per slide, each
// with an editable table backing its own chart (rebuilt from
// inventory.procurement_deck_grid_cells/kpis/list_items — see that
// migration's header comment for why one flexible schema covers every
// slide's shape) plus a file upload to refresh it next month instead of
// clicking through every cell by hand. Seeded from the July 2026 deck and
// its source workbook; update in place for August onward rather than
// re-seeding.
export function ProcurementDeckPage() {
  const deck = useProcurementDeck()

  if (deck.loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>

  const grid = (slideKey: string, tableKey: string) => deck.gridOf(slideKey, tableKey)
  const saveCell = (slideKey: string, tableKey: string) =>
    (row: string, rowSort: number, colKey: string, colLabel: string, colSort: number, value: number | null) =>
      deck.saveCell(slideKey, tableKey, row, rowSort, colKey, colLabel, colSort, value)
  const deleteRow = (slideKey: string, tableKey: string) => (row: string) => deck.deleteGridRow(slideKey, tableKey, row)
  const upload = (slideKey: string, tableKey: string) => (headers: string[], rows: Record<string, string>[]) => deck.uploadGrid(slideKey, tableKey, headers, rows)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Procurement Deck</h1>
        <p className="text-xs text-inky mt-0.5">One tab per slide of the monthly Procurement Update — edit a cell directly, upload a file to refresh a whole table, or add a row/item as things change month to month.</p>
      </div>

      <Tabs defaultValue="exec_summary">
        <TabsList>
          <TabsTrigger value="title">Title</TabsTrigger>
          <TabsTrigger value="exec_summary">Exec Summary</TabsTrigger>
          <TabsTrigger value="ending_balance">Ending Balance</TabsTrigger>
          <TabsTrigger value="cogs">COGS</TabsTrigger>
          <TabsTrigger value="reladyne_purchases">RelaDyne Purchases</TabsTrigger>
          <TabsTrigger value="reladyne_fulfillment">RelaDyne Fulfillment</TabsTrigger>
          <TabsTrigger value="valvoline_purchases">Valvoline Purchases</TabsTrigger>
          <TabsTrigger value="mighty_purchases">Mighty Purchases</TabsTrigger>
          <TabsTrigger value="mighty_fulfillment">Mighty Fulfillment</TabsTrigger>
          <TabsTrigger value="po_match">3-Way PO Match</TabsTrigger>
          <TabsTrigger value="appendix">Appendix</TabsTrigger>
          <TabsTrigger value="daily_compliance">Daily Count Compliance</TabsTrigger>
          <TabsTrigger value="recount_by_area">Recount by Area</TabsTrigger>
          <TabsTrigger value="compliance_trends">Compliance Trends</TabsTrigger>
        </TabsList>

        <TabsContent value="title">
          <p className="text-xs font-mono text-inky/50 py-8 text-center italic">Title slide — no data to track.</p>
        </TabsContent>

        <TabsContent value="exec_summary">
          <div className="flex flex-col gap-5">
            <KpiSection
              title="Month-End Highlights"
              items={deck.kpisOf('exec_summary', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('exec_summary', 'kpi', k, l, v, s)}
              onAdd={(l) => deck.addKpi('exec_summary', 'kpi', l)}
              onDelete={deck.deleteKpi}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <ListSection title="Wins" accent="green" items={deck.listOf('exec_summary', 'wins')}
                onAdd={(t) => deck.addListItem('exec_summary', 'wins', t)} onSave={deck.saveListItem} onDelete={deck.deleteListItem}
                onMove={(id, dir) => deck.moveListItem('exec_summary', 'wins', id, dir)} />
              <ListSection title="Opportunities" accent="orange" items={deck.listOf('exec_summary', 'opportunities')}
                onAdd={(t) => deck.addListItem('exec_summary', 'opportunities', t)} onSave={deck.saveListItem} onDelete={deck.deleteListItem}
                onMove={(id, dir) => deck.moveListItem('exec_summary', 'opportunities', id, dir)} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="ending_balance">
          <GridSection title="Average Ending Balance per Shop" slideKey="ending_balance" tableKey="series"
            cells={grid('ending_balance', 'series')} format="currency"
            chart={{ rows: ['Oil', 'Part', 'Additive'], stacked: true }}
            onSaveCell={saveCell('ending_balance', 'series')} onDeleteRow={deleteRow('ending_balance', 'series')} onUpload={upload('ending_balance', 'series')} />
        </TabsContent>

        <TabsContent value="cogs">
          <GridSection title="Reported vs. Recast COGS (% of Revenue)" slideKey="cogs" tableKey="series"
            cells={grid('cogs', 'series')} format="percent"
            chart={{ rows: ['Reported COGS %', 'Recast COGS %'], lineRows: ['Reported COGS %', 'Recast COGS %'] }}
            onSaveCell={saveCell('cogs', 'series')} onDeleteRow={deleteRow('cogs', 'series')} onUpload={upload('cogs', 'series')} />
        </TabsContent>

        <TabsContent value="reladyne_purchases">
          <div className="flex flex-col gap-5">
            <KpiSection title="Contract Snapshot" items={deck.kpisOf('reladyne_purchases', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('reladyne_purchases', 'kpi', k, l, v, s)} onAdd={(l) => deck.addKpi('reladyne_purchases', 'kpi', l)} onDelete={deck.deleteKpi} />
            <KpiSection title="July Rebates" items={deck.kpisOf('reladyne_purchases', 'rebates')}
              onSave={(k, l, v, s) => deck.saveKpi('reladyne_purchases', 'rebates', k, l, v, s)} onAdd={(l) => deck.addKpi('reladyne_purchases', 'rebates', l)} onDelete={deck.deleteKpi} />
            <GridSection title="RelaDyne Gallons Purchased — Cumulative (000's)" slideKey="reladyne_purchases" tableKey="series"
              cells={grid('reladyne_purchases', 'series')} format="number"
              chart={{ rows: ['Corp', 'FZ', 'Target'], stacked: true, lineRows: ['Target'] }}
              onSaveCell={saveCell('reladyne_purchases', 'series')} onDeleteRow={deleteRow('reladyne_purchases', 'series')} onUpload={upload('reladyne_purchases', 'series')} />
          </div>
        </TabsContent>

        <TabsContent value="reladyne_fulfillment">
          <div className="flex flex-col gap-5">
            <GridSection title="RelaDyne Fulfillment Rates — Corporate" slideKey="reladyne_fulfillment" tableKey="otif_corp"
              cells={grid('reladyne_fulfillment', 'otif_corp')} format="percent"
              chart={{ rows: ['OTIF %', 'On Time %', 'In Full %'], lineRows: ['OTIF %', 'On Time %', 'In Full %'] }}
              onSaveCell={saveCell('reladyne_fulfillment', 'otif_corp')} onDeleteRow={deleteRow('reladyne_fulfillment', 'otif_corp')} onUpload={upload('reladyne_fulfillment', 'otif_corp')} />
            <GridSection title="RelaDyne Fulfillment Rates — Franchise (FZ)" slideKey="reladyne_fulfillment" tableKey="otif_fz"
              cells={grid('reladyne_fulfillment', 'otif_fz')} format="percent"
              chart={{ rows: ['OTIF %', 'On Time %', 'In Full %'], lineRows: ['OTIF %', 'On Time %', 'In Full %'] }}
              onSaveCell={saveCell('reladyne_fulfillment', 'otif_fz')} onDeleteRow={deleteRow('reladyne_fulfillment', 'otif_fz')} onUpload={upload('reladyne_fulfillment', 'otif_fz')} />
            <GridSection title="RelaDyne Product Mix" slideKey="reladyne_fulfillment" tableKey="product_mix"
              cells={grid('reladyne_fulfillment', 'product_mix')} format="percent"
              chart={{ rows: ['Bulk', 'Drum', 'Package'], stacked: true }}
              onSaveCell={saveCell('reladyne_fulfillment', 'product_mix')} onDeleteRow={deleteRow('reladyne_fulfillment', 'product_mix')} onUpload={upload('reladyne_fulfillment', 'product_mix')} />
          </div>
        </TabsContent>

        <TabsContent value="valvoline_purchases">
          <div className="flex flex-col gap-5">
            <KpiSection title="Contract Snapshot" items={deck.kpisOf('valvoline_purchases', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('valvoline_purchases', 'kpi', k, l, v, s)} onAdd={(l) => deck.addKpi('valvoline_purchases', 'kpi', l)} onDelete={deck.deleteKpi} />
            <KpiSection title="July Rebates" items={deck.kpisOf('valvoline_purchases', 'rebates')}
              onSave={(k, l, v, s) => deck.saveKpi('valvoline_purchases', 'rebates', k, l, v, s)} onAdd={(l) => deck.addKpi('valvoline_purchases', 'rebates', l)} onDelete={deck.deleteKpi} />
            <GridSection title="Valvoline Gallons Purchased — Cumulative (000's)" slideKey="valvoline_purchases" tableKey="series"
              cells={grid('valvoline_purchases', 'series')} format="number"
              chart={{ rows: ['Corp', 'FZ', 'Target (Full)'], stacked: true, lineRows: ['Target (Full)'] }}
              onSaveCell={saveCell('valvoline_purchases', 'series')} onDeleteRow={deleteRow('valvoline_purchases', 'series')} onUpload={upload('valvoline_purchases', 'series')} />
          </div>
        </TabsContent>

        <TabsContent value="mighty_purchases">
          <div className="flex flex-col gap-5">
            <KpiSection items={deck.kpisOf('mighty_purchases', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('mighty_purchases', 'kpi', k, l, v, s)} onAdd={(l) => deck.addKpi('mighty_purchases', 'kpi', l)} onDelete={deck.deleteKpi} />
            <GridSection title="Mighty Spend — Cumulative vs. Target (000's)" slideKey="mighty_purchases" tableKey="series"
              cells={grid('mighty_purchases', 'series')} format="number"
              chart={{ rows: ['Cumulative Total', 'Target'], lineRows: ['Cumulative Total', 'Target'] }}
              onSaveCell={saveCell('mighty_purchases', 'series')} onDeleteRow={deleteRow('mighty_purchases', 'series')} onUpload={upload('mighty_purchases', 'series')} />
          </div>
        </TabsContent>

        <TabsContent value="mighty_fulfillment">
          <div className="flex flex-col gap-5">
            <KpiSection title="Shop-Level Variance" items={deck.kpisOf('mighty_fulfillment', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('mighty_fulfillment', 'kpi', k, l, v, s)} onAdd={(l) => deck.addKpi('mighty_fulfillment', 'kpi', l)} onDelete={deck.deleteKpi} />
            <GridSection title="Mighty Available for Sale (AFS)" slideKey="mighty_fulfillment" tableKey="afs"
              cells={grid('mighty_fulfillment', 'afs')} format="percent"
              chart={{ rows: ['Air Filter', 'Cabin Air Filter'], lineRows: ['Air Filter', 'Cabin Air Filter'] }}
              onSaveCell={saveCell('mighty_fulfillment', 'afs')} onDeleteRow={deleteRow('mighty_fulfillment', 'afs')} onUpload={upload('mighty_fulfillment', 'afs')} />
            <GridSection title="M5% — Air Filter and Cabin Air Filter" slideKey="mighty_fulfillment" tableKey="m5"
              cells={grid('mighty_fulfillment', 'm5')} format="percent"
              chart={{ rows: ['Air Filter', 'Cabin Air Filter'], lineRows: ['Air Filter', 'Cabin Air Filter'] }}
              onSaveCell={saveCell('mighty_fulfillment', 'm5')} onDeleteRow={deleteRow('mighty_fulfillment', 'm5')} onUpload={upload('mighty_fulfillment', 'm5')} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <GridSection title="Top 3 Mighty FZ (AF)" slideKey="mighty_fulfillment" tableKey="top_af" cells={grid('mighty_fulfillment', 'top_af')} format="percent"
                onSaveCell={saveCell('mighty_fulfillment', 'top_af')} onDeleteRow={deleteRow('mighty_fulfillment', 'top_af')} onUpload={upload('mighty_fulfillment', 'top_af')} />
              <GridSection title="Bottom 3 Mighty FZ (AF)" slideKey="mighty_fulfillment" tableKey="bottom_af" cells={grid('mighty_fulfillment', 'bottom_af')} format="percent"
                onSaveCell={saveCell('mighty_fulfillment', 'bottom_af')} onDeleteRow={deleteRow('mighty_fulfillment', 'bottom_af')} onUpload={upload('mighty_fulfillment', 'bottom_af')} />
              <GridSection title="Top 3 Mighty FZ (CAF)" slideKey="mighty_fulfillment" tableKey="top_caf" cells={grid('mighty_fulfillment', 'top_caf')} format="percent"
                onSaveCell={saveCell('mighty_fulfillment', 'top_caf')} onDeleteRow={deleteRow('mighty_fulfillment', 'top_caf')} onUpload={upload('mighty_fulfillment', 'top_caf')} />
              <GridSection title="Bottom 3 Mighty FZ (CAF)" slideKey="mighty_fulfillment" tableKey="bottom_caf" cells={grid('mighty_fulfillment', 'bottom_caf')} format="percent"
                onSaveCell={saveCell('mighty_fulfillment', 'bottom_caf')} onDeleteRow={deleteRow('mighty_fulfillment', 'bottom_caf')} onUpload={upload('mighty_fulfillment', 'bottom_caf')} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="po_match">
          <div className="flex flex-col gap-5">
            <GridSection title="3-Way PO Match — Receiving Compliance" slideKey="po_match" tableKey="monthly"
              cells={grid('po_match', 'monthly')} format="number"
              rowFormats={{ 'Received % of Invoiced': 'percent' }}
              chart={{ rows: ['Total Ordered', 'Total Invoiced', 'Total Received'] }}
              onSaveCell={saveCell('po_match', 'monthly')} onDeleteRow={deleteRow('po_match', 'monthly')} onUpload={upload('po_match', 'monthly')} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <GridSection title="Top 3 Markets (Closest to 100%)" slideKey="po_match" tableKey="top3" cells={grid('po_match', 'top3')} format="number"
                columnFormats={{ pct: 'percent' }}
                onSaveCell={saveCell('po_match', 'top3')} onDeleteRow={deleteRow('po_match', 'top3')} onUpload={upload('po_match', 'top3')} />
              <GridSection title="Bottom 3 Markets (Furthest from 100%)" slideKey="po_match" tableKey="bottom3" cells={grid('po_match', 'bottom3')} format="number"
                columnFormats={{ pct: 'percent' }}
                onSaveCell={saveCell('po_match', 'bottom3')} onDeleteRow={deleteRow('po_match', 'bottom3')} onUpload={upload('po_match', 'bottom3')} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="appendix">
          <p className="text-xs font-mono text-inky/50 py-8 text-center italic">Appendix divider — no data to track.</p>
        </TabsContent>

        <TabsContent value="daily_compliance">
          <div className="flex flex-col gap-5">
            <KpiSection title="Manager Coverage on Count Day" items={deck.kpisOf('daily_compliance', 'kpi')}
              onSave={(k, l, v, s) => deck.saveKpi('daily_compliance', 'kpi', k, l, v, s)} onAdd={(l) => deck.addKpi('daily_compliance', 'kpi', l)} onDelete={deck.deleteKpi} />
            <GridSection title="Daily Month-End Count Compliance" slideKey="daily_compliance" tableKey="daily"
              cells={grid('daily_compliance', 'daily')} format="number"
              rowFormats={{ 'Percent Complete': 'percent' }}
              chart={{ rows: ['Shops Submitted', 'Shops Complete'] }}
              onSaveCell={saveCell('daily_compliance', 'daily')} onDeleteRow={deleteRow('daily_compliance', 'daily')} onUpload={upload('daily_compliance', 'daily')} />
            <ListSection title="Shops Still Needing a Recount / Not Yet Complete" items={deck.listOf('daily_compliance', 'still_open')}
              onAdd={(t) => deck.addListItem('daily_compliance', 'still_open', t)} onSave={deck.saveListItem} onDelete={deck.deleteListItem}
              onMove={(id, dir) => deck.moveListItem('daily_compliance', 'still_open', id, dir)} />
          </div>
        </TabsContent>

        <TabsContent value="recount_by_area">
          <GridSection title="Recount Compliance by Area" slideKey="recount_by_area" tableKey="by_area"
            cells={grid('recount_by_area', 'by_area')} format="percent"
            chart={{ rows: ['Central', 'East', 'Midwest', 'North', 'West'], lineRows: ['Central', 'East', 'Midwest', 'North', 'West'] }}
            onSaveCell={saveCell('recount_by_area', 'by_area')} onDeleteRow={deleteRow('recount_by_area', 'by_area')} onUpload={upload('recount_by_area', 'by_area')} />
        </TabsContent>

        <TabsContent value="compliance_trends">
          <GridSection title="Compliance Trends MoM — Initial Completion Accuracy" slideKey="compliance_trends" tableKey="monthly"
            cells={grid('compliance_trends', 'monthly')} format="number"
            rowFormats={{ '% Complete': 'percent' }}
            chart={{ rows: ['Complete', 'Recount', 'Partial Recount', 'Not Submitted'], stacked: true }}
            onSaveCell={saveCell('compliance_trends', 'monthly')} onDeleteRow={deleteRow('compliance_trends', 'monthly')} onUpload={upload('compliance_trends', 'monthly')} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
