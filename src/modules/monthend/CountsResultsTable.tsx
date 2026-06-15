import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Badge } from '@/components/ui'
import { useAppSetting } from '@/hooks/useAppSetting'
import { RECOUNT_FLAG_LABELS } from '@/lib/recountEngine'
import { format } from 'date-fns'

export interface SummaryResultRow {
  location_id: string | null
  location_label: string
  count_type: string | null
  count_date: string | null
  total_adjustments: number | null
  adjustment_value: number | null
  abs_adjustment_value: number | null
  ending_inventory_cost: number | null
  prev_month_ending: number | null
  median: number
  var_vs_last_month: number
  var_vs_median: number
  flags: string[]
}

export interface ProductResultRow {
  location_label: string
  product_id: string
  on_hand: number
  sold: number
  adjusted: number
  ending_value: number
  batch_count: number
}

interface Props {
  summaryRows: SummaryResultRow[]
  productRows: ProductResultRow[]
  lookbackN: number
  loading?: boolean
}

const num = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })

function pct(v: number): string {
  if (!isFinite(v) || v === 0) return '0%'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

function varColor(v: number): string {
  const a = Math.abs(v)
  if (a >= 0.15) return 'text-red-400'
  if (a >= 0.05) return 'text-orange-600'
  return 'text-inky'
}

function flagColor(code: string): 'red' | 'amber' {
  return code.startsWith('variance') || code.startsWith('high') ? 'red' : 'amber'
}

const sc = createColumnHelper<SummaryResultRow>()
const pc = createColumnHelper<ProductResultRow>()

const rowKey = (r: SummaryResultRow) => `${r.location_id ?? ''}|${r.count_type ?? ''}|${r.count_date ?? ''}`

export function CountsResultsTable({ summaryRows, productRows, lookbackN, loading }: Props) {
  const [view, setView] = useState<'summary' | 'product'>('summary')

  // G1 — Allowable types: types present, which are allowable (empty = all),
  // and per-row include/exclude overrides.
  const distinctTypes = useMemo(() => Array.from(new Set(summaryRows.map((r) => r.count_type ?? '—'))).sort(), [summaryRows])
  const [allowable, setAllowable] = useAppSetting<string[]>('monthend.allowableTypes', [])
  const [overrides, setOverrides] = useState<Record<string, 'include' | 'exclude'>>({})
  const allowableSet = useMemo(() => new Set(allowable), [allowable])
  function included(r: SummaryResultRow): boolean {
    const ov = overrides[rowKey(r)]
    if (ov) return ov === 'include'
    return allowable.length === 0 || allowableSet.has(r.count_type ?? '—')
  }
  function toggleType(t: string) {
    // First interaction seeds from "all" so unticking one keeps the rest.
    const base = allowable.length === 0 ? distinctTypes : allowable
    setAllowable(base.includes(t) ? base.filter((x) => x !== t) : [...base, t])
  }
  function toggleOverride(r: SummaryResultRow) {
    const k = rowKey(r); const next = included(r) ? 'exclude' : 'include'
    setOverrides((o) => ({ ...o, [k]: next }))
  }
  const filteredSummary = useMemo(() => summaryRows.filter(included), [summaryRows, allowable, overrides]) // eslint-disable-line react-hooks/exhaustive-deps
  const excludedCount = summaryRows.length - filteredSummary.length

  const summaryColumns = useMemo(() => [
    { id: 'incl', header: '', enableSorting: false, enableColumnFilter: false, cell: (i: any) => { const r = i.row.original as SummaryResultRow; const inc = included(r); return <button onClick={() => toggleOverride(r)} title={inc ? 'Exclude this row' : 'Include this row'} className={inc ? 'text-green-700' : 'text-inky/70'}>{inc ? '✓' : '✕'}</button> } },
    sc.accessor('location_label', { header: 'Location' }),
    sc.accessor('count_type', { header: 'Type', cell: (i) => i.getValue() ?? '—' }),
    sc.accessor('count_date', {
      header: 'Count Date',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—'),
    }),
    sc.accessor('total_adjustments', { header: 'Adjustments', cell: (i) => num(i.getValue()) }),
    sc.accessor('adjustment_value', { header: 'Adj Value', cell: (i) => num(i.getValue()) }),
    sc.accessor('abs_adjustment_value', { header: 'Abs Adj Value', cell: (i) => num(i.getValue()) }),
    sc.accessor('ending_inventory_cost', {
      header: 'Ending Balance',
      cell: (i) => <span className="text-navy">{num(i.getValue())}</span>,
    }),
    sc.accessor('prev_month_ending', { header: 'Prev Month', cell: (i) => num(i.getValue()) }),
    sc.accessor('median', { header: `Median(${lookbackN})`, cell: (i) => num(i.getValue()) }),
    sc.accessor('var_vs_last_month', {
      header: 'Var vs Last',
      cell: (i) => <span className={varColor(i.getValue())}>{pct(i.getValue())}</span>,
    }),
    sc.accessor('var_vs_median', {
      header: 'Var vs Median',
      cell: (i) => <span className={varColor(i.getValue())}>{pct(i.getValue())}</span>,
    }),
    sc.accessor('flags', {
      header: 'Recount Flags',
      enableSorting: false,
      cell: (i) => {
        const flags = i.getValue()
        if (!flags.length) return <span className="text-inky/70">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <Badge key={f} color={flagColor(f)}>{RECOUNT_FLAG_LABELS[f] ?? f}</Badge>
            ))}
          </div>
        )
      },
    }),
  ], [lookbackN, allowable, overrides]) // eslint-disable-line react-hooks/exhaustive-deps

  const productColumns = useMemo(() => [
    pc.accessor('location_label', { header: 'Location' }),
    pc.accessor('product_id', { header: 'Product' }),
    pc.accessor('on_hand', { header: 'On Hand', cell: (i) => num(i.getValue()) }),
    pc.accessor('sold', { header: 'Sold', cell: (i) => num(i.getValue()) }),
    pc.accessor('adjusted', { header: 'Adjusted', cell: (i) => num(i.getValue()) }),
    pc.accessor('ending_value', {
      header: 'Ending Value',
      cell: (i) => <span className="text-navy">{num(i.getValue())}</span>,
    }),
    pc.accessor('batch_count', {
      header: 'Batches',
      cell: (i) => <span className="text-inky">{i.getValue()}</span>,
    }),
  ], [])

  const summaryTbl = useTable(filteredSummary, summaryColumns)
  const productTbl = useTable(productRows, productColumns)

  // Flattened CSV export rows
  const summaryExport = useMemo(() => filteredSummary.map((r) => ({
    location: r.location_label,
    count_type: r.count_type ?? '',
    count_date: r.count_date ?? '',
    total_adjustments: r.total_adjustments ?? '',
    adjustment_value: r.adjustment_value ?? '',
    abs_adjustment_value: r.abs_adjustment_value ?? '',
    ending_inventory_cost: r.ending_inventory_cost ?? '',
    prev_month_ending: r.prev_month_ending ?? '',
    median: r.median,
    var_vs_last_month: pct(r.var_vs_last_month),
    var_vs_median: pct(r.var_vs_median),
    flags: r.flags.map((f) => RECOUNT_FLAG_LABELS[f] ?? f).join(' | '),
  })), [filteredSummary])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-inky uppercase tracking-wide mr-1">View</span>
        <div className="flex rounded border border-navy/30 overflow-hidden">
          {(['summary', 'product'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={[
                'px-3 py-1 text-xs font-mono transition-colors capitalize',
                view === v ? 'bg-sky/20 text-navy font-bold' : 'text-inky hover:text-navy',
              ].join(' ')}
            >
              {v === 'summary' ? 'Summary' : 'Product Detail'}
            </button>
          ))}
        </div>
      </div>

      {view === 'summary' && distinctTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-navy/30 bg-cream px-3 py-2">
          <span className="text-xs font-mono uppercase tracking-wide text-inky">Allowable types:</span>
          {distinctTypes.map((t) => {
            const on = allowable.length === 0 || allowableSet.has(t)
            return (
              <button key={t} onClick={() => toggleType(t)}
                className={['rounded border px-2 py-0.5 text-xs font-mono', on ? 'border-navy bg-navy/10 text-navy' : 'border-navy/30 text-inky/70'].join(' ')}>
                {on ? '✓ ' : ''}{t}
              </button>
            )
          })}
          {excludedCount > 0 && <span className="text-xs font-mono text-orange-600">{excludedCount} row{excludedCount !== 1 ? 's' : ''} excluded</span>}
        </div>
      )}

      {view === 'summary' ? (
        <DataTable
          table={summaryTbl.table}
          globalFilter={summaryTbl.globalFilter}
          onGlobalFilterChange={summaryTbl.setGlobalFilter}
          exportFilename="month_end_summary.csv"
          exportData={summaryExport}
          loading={loading}
        />
      ) : (
        <DataTable
          table={productTbl.table}
          globalFilter={productTbl.globalFilter}
          onGlobalFilterChange={productTbl.setGlobalFilter}
          exportFilename="month_end_products.csv"
          exportData={productRows}
          loading={loading}
        />
      )}
    </div>
  )
}
