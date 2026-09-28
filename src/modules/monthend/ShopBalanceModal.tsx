// Opens from a Shop Balances row click (OverviewTab.tsx, 2026-09-28 ask) —
// deliberately does no fetching until it's actually open, so the page's own
// initial load stays fast regardless of how many shops the table lists.
// Two lazy layers: 12-month history (chart + table) loads the moment the
// modal opens; the shop's individual on-hand products load only once
// "View Product Detail" is clicked, since that's the heavier, less-often-
// needed drill-down.
import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { format, parseISO, subMonths } from 'date-fns'
import { Button, Modal, SbLoader } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { supabase } from '@/lib/supabase'
import { usd, LOOKBACK_MONTHS } from './OverviewTab'

interface HistoryRow { count_month: string; oil: number; parts: number; additives: number; other: number; total: number }
interface ProductRow { product_id: string; category: string | null; on_hand: number; ending_value: number }

// Same stacked-bar palette order (oil/parts/additives/other) the rest of
// this app's Droptop-derived charts use — sky/inky/green/orange, brand
// tokens, no new hex values.
const CATEGORY_COLORS = { Oil: '#B7E0DE', Parts: '#4F7489', Additives: '#2ECC71', Other: '#E67E22' }
const PRODUCT_TABLE_KEY = 'monthend:shop-product-detail'

export function ShopBalanceModal({ open, onClose, companyId, locationId, shopLabel, countMonth }: {
  open: boolean
  onClose: () => void
  companyId: string
  locationId: string
  shopLabel: string
  countMonth: string
}) {
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [showProducts, setShowProducts] = useState(false)
  const [products, setProducts] = useState<ProductRow[] | null>(null)
  const [productsLoading, setProductsLoading] = useState(false)
  const [productsError, setProductsError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setShowProducts(false); setProducts(null); setProductsError(null)
    setHistoryLoading(true); setHistoryError(null)
    let cancelled = false
    const startMonth = format(subMonths(parseISO(countMonth), LOOKBACK_MONTHS), 'yyyy-MM-01')
    ;(supabase as any).rpc('get_shop_category_balance_history', {
      p_company_id: companyId, p_location_id: locationId, p_start_month: startMonth, p_end_month: countMonth,
    }).then(({ data, error }: { data: any[] | null; error: { message: string } | null }) => {
      if (cancelled) return
      if (error) { setHistoryError(error.message); setHistoryLoading(false); return }
      setHistory((data ?? []).map((r) => ({
        count_month: r.count_month, oil: Number(r.oil ?? 0), parts: Number(r.parts ?? 0),
        additives: Number(r.additives ?? 0), other: Number(r.other ?? 0), total: Number(r.total ?? 0),
      })))
      setHistoryLoading(false)
    })
    return () => { cancelled = true }
  }, [open, locationId, companyId, countMonth])

  function loadProducts() {
    setShowProducts(true)
    if (products || productsLoading) return
    setProductsLoading(true); setProductsError(null)
    ;(supabase as any).rpc('get_shop_product_detail', {
      p_company_id: companyId, p_location_id: locationId, p_count_month: countMonth,
    }).then(({ data, error }: { data: any[] | null; error: { message: string } | null }) => {
      if (error) { setProductsError(error.message); setProductsLoading(false); return }
      setProducts((data ?? []).map((r) => ({
        product_id: r.product_id, category: r.category, on_hand: Number(r.on_hand ?? 0), ending_value: Number(r.ending_value ?? 0),
      })))
      setProductsLoading(false)
    })
  }

  const chartData = useMemo(() => history.map((r) => ({
    month: format(parseISO(r.count_month), 'MMM yy'),
    Oil: r.oil, Parts: r.parts, Additives: r.additives, Other: r.other,
  })), [history])

  const productCol = useMemo(() => createColumnHelper<ProductRow>(), [])
  const productColumns = useMemo(() => [
    productCol.accessor('product_id', { header: 'Product' }),
    productCol.accessor('category', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
    productCol.accessor('on_hand', { header: 'On Hand', cell: (i) => <div className="text-right">{i.getValue().toLocaleString(undefined, { maximumFractionDigits: 2 })}</div> }),
    productCol.accessor('ending_value', { header: 'Ending Value', cell: (i) => <div className="text-right font-bold">{usd(i.getValue())}</div> }),
  ], [productCol])

  const {
    table: productTable, globalFilter: productGlobalFilter, setGlobalFilter: setProductGlobalFilter,
    columnVisibility: productColumnVisibility, columnOrder: productColumnOrder, setColumnOrder: setProductColumnOrder,
  } = useTable(products ?? [], productColumns, {
    persistKey: PRODUCT_TABLE_KEY,
    initialPageSize: 50,
    initialSorting: [{ id: 'ending_value', desc: true }],
  })
  useColumnPrefs(PRODUCT_TABLE_KEY, productTable, productColumnVisibility, productColumnOrder, setProductColumnOrder)

  return (
    <Modal open={open} onClose={onClose} title={`Shop Balance — ${shopLabel}`} size="2xl">
      <div className="flex flex-col gap-4">
        {historyLoading ? (
          <div className="py-10 flex justify-center"><SbLoader size={32} /></div>
        ) : historyError ? (
          <p className="text-xs font-mono text-[#C0392B]">{historyError}</p>
        ) : (
          <>
            <div className="rounded-lg bg-sb-navy px-4 py-4">
              <div className="text-center text-sm font-heading mb-2 text-sb-cream">{LOOKBACK_MONTHS}-Month History</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#F2F1E6', fontSize: 10, fontFamily: '"DM Mono", monospace' }} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
                  <YAxis tick={{ fill: '#F2F1E6', fontSize: 10, fontFamily: '"DM Mono", monospace' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => usd(v)} width={70} />
                  <Tooltip
                    contentStyle={{ background: '#002745', border: '1px solid rgba(183,224,222,0.3)', borderRadius: 4, fontFamily: '"DM Mono", monospace', fontSize: 11, color: '#F2F1E6' }}
                    formatter={(v: number) => usd(v)}
                  />
                  <Legend wrapperStyle={{ fontFamily: '"DM Mono", monospace', fontSize: 11, color: '#F2F1E6' }} />
                  <Bar dataKey="Oil" stackId="a" fill={CATEGORY_COLORS.Oil} />
                  <Bar dataKey="Parts" stackId="a" fill={CATEGORY_COLORS.Parts} />
                  <Bar dataKey="Additives" stackId="a" fill={CATEGORY_COLORS.Additives} />
                  <Bar dataKey="Other" stackId="a" fill={CATEGORY_COLORS.Other} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-auto rounded border border-navy/30 max-h-56">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="sticky top-0 border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left">Month</th>
                    <th className="px-3 py-2 text-right">Oil</th>
                    <th className="px-3 py-2 text-right">Parts</th>
                    <th className="px-3 py-2 text-right">Additives</th>
                    <th className="px-3 py-2 text-right">Other</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((r) => (
                    <tr key={r.count_month} className="border-b border-navy/20">
                      <td className="px-3 py-2 text-navy font-bold">{format(parseISO(r.count_month), 'MMM yyyy')}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.oil)}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.parts)}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.additives)}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.other)}</td>
                      <td className="px-3 py-2 text-right text-navy font-bold">{usd(r.total)}</td>
                    </tr>
                  ))}
                  {history.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-inky/50">No history for this shop yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="border-t border-navy/20 pt-3 flex flex-col gap-3">
          {!showProducts ? (
            <Button size="sm" variant="secondary" onClick={loadProducts}>View Product Detail</Button>
          ) : productsLoading ? (
            <div className="py-8 flex justify-center"><SbLoader size={28} /></div>
          ) : productsError ? (
            <p className="text-xs font-mono text-[#C0392B]">{productsError}</p>
          ) : (
            <>
              <span className="text-xs font-mono text-navy uppercase tracking-wide">
                Products On Hand — {format(parseISO(countMonth), 'MMMM yyyy')}
              </span>
              <DataTable
                table={productTable}
                globalFilter={productGlobalFilter}
                onGlobalFilterChange={setProductGlobalFilter}
                exportFilename={`${shopLabel} Product Detail`}
              />
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
