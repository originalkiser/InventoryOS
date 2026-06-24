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
  category: string
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

// ---------------------------------------------------------------------------
function CategoryDropdown({
  categories,
  selected,
  onChange,
}: {
  categories: string[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  function toggle(cat: string) {
    onChange(selected.includes(cat) ? selected.filter((c) => c !== cat) : [...selected, cat])
  }
  const allSelected = categories.length > 0 && selected.length === categories.length
  const label =
    selected.length === 0
      ? 'none'
      : `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'}`

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded border border-navy/30 px-2 py-0.5 text-xs font-mono text-navy hover:border-navy"
      >
        {label} <span className="text-inky/50 ml-0.5">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 top-full mt-1 left-0 min-w-[200px] max-h-64 overflow-auto rounded border border-navy/30 bg-cream shadow-xl py-1">
            {categories.length === 0 ? (
              <p className="px-3 py-2 text-xs font-body italic text-inky/60">No categories in data yet</p>
            ) : (
              <>
                <button
                  onClick={() => onChange(allSelected ? [] : [...categories])}
                  className="w-full px-3 py-1.5 text-left text-xs font-body text-inky hover:bg-navy/5"
                >
                  {allSelected ? '✓ All selected' : 'Select all'}
                </button>
                <div className="border-t border-navy/10 mt-1 pt-1">
                  {categories.map((cat) => (
                    <label key={cat} className="flex items-center gap-2 px-3 py-1.5 hover:bg-navy/5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.includes(cat)}
                        onChange={() => toggle(cat)}
                        className="accent-inky"
                      />
                      <span className="text-xs font-body text-navy">{cat || '(Uncategorized)'}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
const sc = createColumnHelper<SummaryResultRow>()
const pc = createColumnHelper<ProductResultRow>()

const rowKey = (r: SummaryResultRow) => `${r.location_id ?? ''}|${r.count_type ?? ''}|${r.count_date ?? ''}`

export function CountsResultsTable({ summaryRows, productRows, lookbackN, loading }: Props) {
  const [view, setView] = useState<'summary' | 'product'>('summary')

  // ---- Summary: allowable type rules (per-type: include / exclude / allow_if_over) ----
  const distinctTypes = useMemo(() => Array.from(new Set(summaryRows.map((r) => r.count_type ?? '—'))).sort(), [summaryRows])

  type TypeRuleMode = 'include' | 'exclude' | 'allow_if_over'
  interface TypeRule { mode: TypeRuleMode; threshold: number | null }
  const [typeRules, setTypeRules] = useAppSetting<Record<string, TypeRule>>('monthend.allowableTypeRules', {})
  const [overrides, setOverrides] = useState<Record<string, 'include' | 'exclude'>>({})
  const [rulePopover, setRulePopover] = useState<string | null>(null)
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, string>>({})

  function getRule(t: string): TypeRule {
    return typeRules[t] ?? { mode: 'include', threshold: null }
  }

  function setRule(t: string, rule: TypeRule) {
    setTypeRules({ ...typeRules, [t]: rule })
    setRulePopover(null)
  }

  function included(r: SummaryResultRow): boolean {
    const ov = overrides[rowKey(r)]
    if (ov) return ov === 'include'
    const rule = getRule(r.count_type ?? '—')
    if (rule.mode === 'exclude') return false
    if (rule.mode === 'allow_if_over') {
      return rule.threshold == null || (r.total_adjustments ?? 0) > rule.threshold
    }
    return true
  }

  function toggleOverride(r: SummaryResultRow) {
    const k = rowKey(r)
    const next = included(r) ? 'exclude' : 'include'
    setOverrides((o) => ({ ...o, [k]: next }))
  }

  const filteredSummary = useMemo(() => summaryRows.filter(included), [summaryRows, typeRules, overrides]) // eslint-disable-line react-hooks/exhaustive-deps
  const excludedCount = summaryRows.length - filteredSummary.length

  // ---- Product: zero on-hand filter + per-category exceptions ----
  const [excludeZeroOH, setExcludeZeroOH] = useAppSetting<boolean>('monthend.excludeZeroOnHand', true)
  const [includedZeroCats, setIncludedZeroCats] = useAppSetting<string[]>('monthend.includedZeroCategories', [])

  const distinctCategories = useMemo(
    () => Array.from(new Set(productRows.map((p) => p.category || ''))).filter(Boolean).sort(),
    [productRows]
  )

  const filteredProducts = useMemo(() => {
    if (!excludeZeroOH) return productRows
    return productRows.filter(
      (p) => (p.on_hand ?? 0) > 0 || includedZeroCats.includes(p.category ?? '')
    )
  }, [productRows, excludeZeroOH, includedZeroCats])

  const zeroExcludedCount = productRows.length - filteredProducts.length

  // ---- Columns ----
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
  ], [lookbackN, typeRules, overrides]) // eslint-disable-line react-hooks/exhaustive-deps

  const productColumns = useMemo(() => [
    pc.accessor('location_label', { header: 'Location' }),
    pc.accessor('product_id', { header: 'Product' }),
    pc.accessor('category', { header: 'Category', cell: (i) => i.getValue() || '—' }),
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
  const productTbl = useTable(filteredProducts, productColumns)

  // ---- CSV exports ----
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

  const productExport = useMemo(() => filteredProducts.map((r) => ({
    location: r.location_label,
    product_id: r.product_id,
    category: r.category,
    on_hand: r.on_hand,
    sold: r.sold,
    adjusted: r.adjusted,
    ending_value: r.ending_value,
    batch_count: r.batch_count,
  })), [filteredProducts])

  return (
    <div className="flex flex-col gap-3">
      {/* View toggle */}
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

      {/* Summary: allowable type filter */}
      {view === 'summary' && distinctTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-navy/30 bg-cream px-3 py-2">
          <span className="text-xs font-mono uppercase tracking-wide text-inky">Allowable types:</span>
          {distinctTypes.map((t) => {
            const rule = getRule(t)
            const chipColor =
              rule.mode === 'exclude' ? 'border-red-300 bg-red-50 text-red-600' :
              rule.mode === 'allow_if_over' ? 'border-amber-400 bg-amber-50 text-amber-700' :
              'border-navy bg-navy/10 text-navy'
            const chipLabel =
              rule.mode === 'exclude' ? `✕ ${t}` :
              rule.mode === 'allow_if_over' ? `≥${rule.threshold ?? '?'} adj · ${t}` :
              `✓ ${t}`
            return (
              <div key={t} className="relative">
                <button
                  onClick={() => {
                    setRulePopover(rulePopover === t ? null : t)
                    setThresholdDraft((d) => ({ ...d, [t]: String(getRule(t).threshold ?? '') }))
                  }}
                  className={['rounded border px-2 py-0.5 text-xs font-mono transition-colors', chipColor].join(' ')}>
                  {chipLabel}
                </button>
                {rulePopover === t && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setRulePopover(null)} />
                    <div className="absolute z-50 top-full mt-1 left-0 min-w-[220px] rounded border border-navy/30 bg-cream shadow-xl p-3 flex flex-col gap-2">
                      <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-1">{t}</p>
                      <button
                        onClick={() => setRule(t, { mode: 'include', threshold: null })}
                        className={['flex items-center gap-2 text-xs font-mono px-2 py-1.5 rounded border transition-colors', rule.mode === 'include' ? 'border-navy bg-navy/10 text-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
                        <span className="text-green-600">✓</span> Include (always allowed)
                      </button>
                      <button
                        onClick={() => setRule(t, { mode: 'exclude', threshold: null })}
                        className={['flex items-center gap-2 text-xs font-mono px-2 py-1.5 rounded border transition-colors', rule.mode === 'exclude' ? 'border-red-400 bg-red-50 text-red-600' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
                        <span className="text-red-500">✕</span> Don't allow
                      </button>
                      <div className={['flex flex-col gap-1.5 rounded border px-2 py-2 transition-colors', rule.mode === 'allow_if_over' ? 'border-amber-400 bg-amber-50' : 'border-navy/20'].join(' ')}>
                        <button
                          onClick={() => setRule(t, { mode: 'allow_if_over', threshold: Number(thresholdDraft[t]) || null })}
                          className="flex items-center gap-2 text-xs font-mono text-left">
                          <span className={rule.mode === 'allow_if_over' ? 'text-amber-600' : 'text-inky/40'}>◎</span>
                          <span className={rule.mode === 'allow_if_over' ? 'text-amber-700' : 'text-inky'}>Allow if over X adjustments</span>
                        </button>
                        <div className="flex items-center gap-1.5 pl-5">
                          <span className="text-[10px] font-mono text-inky">Threshold:</span>
                          <input
                            type="number"
                            min={0}
                            value={thresholdDraft[t] ?? ''}
                            onChange={(e) => setThresholdDraft((d) => ({ ...d, [t]: e.target.value }))}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="e.g. 5"
                            className="w-16 rounded border border-navy/30 bg-cream px-1.5 py-0.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none"
                          />
                          <button
                            onClick={() => setRule(t, { mode: 'allow_if_over', threshold: Number(thresholdDraft[t]) || null })}
                            className="text-[10px] font-mono border border-navy/20 rounded px-1.5 py-0.5 text-inky hover:border-navy/40">
                            Set
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })}
          {excludedCount > 0 && <span className="text-xs font-mono text-orange-600">{excludedCount} row{excludedCount !== 1 ? 's' : ''} excluded</span>}
        </div>
      )}

      {/* Product: zero on-hand filter banner */}
      {view === 'product' && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-navy/20 bg-cream px-3 py-2">
          <span className="text-xs font-mono text-inky">
            {excludeZeroOH
              ? <>0 on-hands excluded{zeroExcludedCount > 0 && <span className="text-orange-600"> · {zeroExcludedCount.toLocaleString()} hidden</span>}</>
              : 'Showing all products'}
          </span>
          <button
            onClick={() => setExcludeZeroOH(!excludeZeroOH)}
            className="text-xs font-mono text-inky/60 hover:text-navy underline"
          >
            {excludeZeroOH ? 'show all' : 'hide zero on-hands'}
          </button>
          {excludeZeroOH && (
            <>
              <span className="text-navy/30 text-xs">·</span>
              <span className="text-xs font-mono text-inky">include by category:</span>
              <CategoryDropdown
                categories={distinctCategories}
                selected={includedZeroCats}
                onChange={setIncludedZeroCats}
              />
            </>
          )}
        </div>
      )}

      {/* Tables */}
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
          exportData={productExport}
          loading={loading}
        />
      )}
    </div>
  )
}
