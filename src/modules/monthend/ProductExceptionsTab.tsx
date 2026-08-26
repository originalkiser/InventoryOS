import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Badge, Card, CardBody } from '@/components/ui'
import { CategorySimplificationTab } from '@/modules/config/tabs/CategorySimplificationTab'
import { CategoryExpectationsTab, TANK_VARIANCE_KEY, UNLISTED_LIMIT_KEY, DEFAULT_TANK_VARIANCE } from '@/modules/config/tabs/CategoryExpectationsTab'
import { ProductOverridesTab } from '@/modules/config/tabs/ProductOverridesTab'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

interface ExceptionRow {
  location_id: string | null
  product_id: string
  category: string | null
  on_hand: number
  expected_limit: number
  tank_reading_qts: number | null
  basis: string
  reason: string
}

const show = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const basisColor = (b: string) => (b === 'product_override' ? 'sky' : b === 'bulk' || b === 'drum' || b === 'package' ? 'red' : b === 'unlisted' ? 'gray' : 'amber')

export function ProductExceptionsTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [tankVariance] = useAppSetting<number>(TANK_VARIANCE_KEY, DEFAULT_TANK_VARIANCE)
  const [unlistedLimit] = useAppSetting<number | null>(UNLISTED_LIMIT_KEY, null)

  const [rows, setRows] = useState<ExceptionRow[] | null>(null)
  const [editingExpectations, setEditingExpectations] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoryCount, setCategoryCount] = useState<number | null>(null)
  const [productOverrides, setProductOverrides] = useState<{ product_id: string; expected_limit: number | null }[] | null>(null)

  useEffect(() => {
    if (!companyId) return
    const sb = supabase as any
    sb.schema('inventory').from('category_expectations').select('id').eq('company_id', companyId)
      .then(({ data }: { data: { id: string }[] | null }) => setCategoryCount((data ?? []).length))
    // best-effort: inventory.product_expectations is a recently-added table
    sb.schema('inventory').from('product_expectations').select('product_id, expected_limit').eq('company_id', companyId)
      .then(({ data, error }: { data: { product_id: string; expected_limit: number | null }[] | null; error: unknown }) => {
        if (!error) setProductOverrides(data ?? [])
      })
  }, [companyId])

  async function run() {
    if (!companyId) return
    setRunning(true); setError(null)
    const { data, error } = await (supabase as any).rpc('get_product_expectation_exceptions', {
      p_company_id: companyId,
      p_count_month: countMonth,
      p_tank_variance: tankVariance ?? DEFAULT_TANK_VARIANCE,
      p_unlisted_limit: unlistedLimit ?? null,
    })
    setRunning(false)
    if (error) { setError(error.message); toast.error('Analysis failed'); return }
    setRows((data ?? []) as ExceptionRow[])
    toast.success(`${(data ?? []).length.toLocaleString()} exception${(data ?? []).length === 1 ? '' : 's'} found`)
  }

  const byLocation = useMemo(() => {
    if (!rows) return 0
    return new Set(rows.map((r) => r.location_id)).size
  }, [rows])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">
              Expected On Hand — {format(parseISO(countMonth), 'MMMM yyyy')}
            </span>
            <span className="text-[11px] font-mono text-inky/70">
              Tank variance ±{tankVariance ?? DEFAULT_TANK_VARIANCE} qts · Unlisted limit {unlistedLimit == null ? 'unlimited' : unlistedLimit.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditingExpectations((v) => !v)}>
              {editingExpectations ? 'Done Editing' : 'Edit Expectations'}
            </Button>
            <Button loading={running} onClick={run}>Run Analysis</Button>
          </div>
        </CardBody>
      </Card>

      {(categoryCount != null || productOverrides != null) && (
        <div className="flex flex-wrap items-center gap-2">
          {categoryCount != null && (
            <span className="text-[11px] font-mono text-inky/70 rounded border border-navy/20 px-2 py-1">
              <span className="text-navy font-bold">{categoryCount}</span> categor{categoryCount === 1 ? 'y' : 'ies'} checked for balance limits
            </span>
          )}
          {productOverrides != null && (
            <span className="text-[11px] font-mono text-inky/70 rounded border border-sky/40 px-2 py-1">
              <span className="text-navy font-bold">{productOverrides.length}</span> product{productOverrides.length === 1 ? '' : 's'} with {productOverrides.length === 1 ? 'its' : 'their'} own limit
              {productOverrides.length > 0 && productOverrides.length <= 3 && (
                <span className="text-inky/50"> — {productOverrides.map((p) => `${p.product_id}: ${show(p.expected_limit)}`).join(', ')}</span>
              )}
            </span>
          )}
        </div>
      )}

      {editingExpectations && (
        <Card><CardBody className="flex flex-col gap-6">
          <p className="text-[11px] font-mono text-inky/60">
            Same tables Config → Category Simplification / Expected On Hand edit — changes here apply everywhere immediately.
          </p>
          <CategorySimplificationTab />
          <div className="border-t border-navy/10 pt-6"><CategoryExpectationsTab /></div>
          <div className="border-t border-navy/10 pt-6"><ProductOverridesTab /></div>
        </CardBody></Card>
      )}

      {error && (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
          {error}
        </div>
      )}

      {rows === null ? (
        <p className="text-xs font-mono text-inky/70">Run the analysis to flag products whose on-hand exceeds the configured limits.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs font-mono text-inky/70">No products exceed their expected on-hand for this period. ✅</p>
      ) : (
        <>
          <div className="text-xs font-mono text-inky">
            <span className="text-orange-600 font-bold">{rows.length.toLocaleString()}</span> exceptions across{' '}
            <span className="text-navy font-bold">{byLocation}</span> shops
          </div>
          <div className="overflow-auto max-h-[calc(100vh-320px)] rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0">
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Location</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-right">On Hand</th>
                  <th className="px-3 py-2 text-right">Limit</th>
                  <th className="px-3 py-2 text-right">Tank (qts)</th>
                  <th className="px-3 py-2 text-left">Basis</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.location_id}-${r.product_id}-${i}`} className="border-b border-navy/20">
                    <td className="px-3 py-2 text-navy">{loc.labelOf(r.location_id)}</td>
                    <td className="px-3 py-2 text-navy">{r.product_id}</td>
                    <td className="px-3 py-2 text-inky">{r.category ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-navy font-bold">{show(r.on_hand)}</td>
                    <td className="px-3 py-2 text-right text-inky">{show(r.expected_limit)}</td>
                    <td className="px-3 py-2 text-right text-inky">{show(r.tank_reading_qts)}</td>
                    <td className="px-3 py-2"><Badge color={basisColor(r.basis)}>{r.basis}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
