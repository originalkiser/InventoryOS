// Product Pricing Audit — direct ask 2026-10-02. Checks per-product
// unit_cost/unit_retail CONSISTENCY across active, Corporate-owned shops
// (franchise shops are expected to price independently, so they're never
// part of either the baseline or the audited set here) — unlike the
// Package Pricing Audit (which compares against a fixed core.locations
// price column), there's no per-product "list price" to compare against,
// so the "expected" value is itself a peer-consensus: whichever unit_cost/
// unit_retail is most common for that product across the scoped shops (see
// get_product_pricing_audit, migration 20260930cc). Cost is flagged in red
// (rarely legitimately custom per shop) vs. retail in orange (often
// genuinely custom, pending a Custom Product Pricing mark to exclude it).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { ownerBucket } from '@/hooks/useLocationExclusions'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { Button, SbLoader } from '@/components/ui'
import { money } from '@/modules/orders-v2/shared'

interface AuditRow {
  id: string
  locationId: string
  productId: string
  category: string | null
  unitCost: number | null
  unitRetail: number | null
  expectedCost: number | null
  expectedRetail: number | null
  costMismatch: boolean
  retailMismatch: boolean
}

export function ProductPricingAuditTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — this page resolves its OWN Corporate-only scope below
  // (every shop is loaded unfiltered, then narrowed), rather than relying
  // on the 'inventory' surface's forced-corporate-only default, which would
  // make it impossible to tell the difference between "franchise filtered
  // out by this audit's own design" and "the app-wide exclusion system did
  // it" if that default ever changes.
  const loc = useLocations('other')
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customKeys, setCustomKeys] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [clearSelectionToken, setClearSelectionToken] = useState(0)
  const [marking, setMarking] = useState(false)

  const corporateLocationIds = useMemo(
    () => loc.locations.filter((l) => l.active !== false && ownerBucket(String((l as any).owner ?? '')) === 'Corporate').map((l) => l.id),
    [loc.locations],
  )

  const load = useCallback(async () => {
    if (!companyId || !corporateLocationIds.length) return
    setRows(null)
    setError(null)
    const sb = supabase as any
    const [auditRes, customRes] = await Promise.all([
      sb.rpc('get_product_pricing_audit', { p_location_ids: corporateLocationIds }),
      sb.schema('inventory').from('custom_product_pricing').select('location_id, product_id').eq('company_id', companyId),
    ])
    if (auditRes.error) { setError(auditRes.error.message); setRows([]); return }
    const custom = new Set<string>((customRes.data ?? []).map((r: { location_id: string; product_id: string }) => `${r.location_id}|${r.product_id}`))
    setCustomKeys(custom)
    setRows((auditRes.data ?? [])
      .map((r: any): AuditRow => ({
        id: `${r.location_id}|${r.product_id}`,
        locationId: r.location_id, productId: r.product_id, category: r.category,
        unitCost: r.unit_cost != null ? Number(r.unit_cost) : null,
        unitRetail: r.unit_retail != null ? Number(r.unit_retail) : null,
        expectedCost: r.expected_cost != null ? Number(r.expected_cost) : null,
        expectedRetail: r.expected_retail != null ? Number(r.expected_retail) : null,
        costMismatch: !!r.cost_mismatch, retailMismatch: !!r.retail_mismatch,
      }))
      .filter((r: AuditRow) => !custom.has(r.id)))
  }, [companyId, corporateLocationIds])
  useEffect(() => { load() }, [load])

  function shopLabel(locationId: string): string {
    const l = loc.locations.find((x) => x.id === locationId)
    return l ? (l.shop_city || l.name) : locationId
  }

  async function markSelectedCustom() {
    if (!companyId || !selectedIds.size) return
    setMarking(true)
    const sb = supabase as any
    const toInsert = [...selectedIds].map((id) => {
      const [location_id, product_id] = id.split('|')
      return { company_id: companyId, location_id, product_id, created_by: profile?.id ?? null }
    })
    const { error: err } = await sb.schema('inventory').from('custom_product_pricing')
      .upsert(toInsert, { onConflict: 'company_id,location_id,product_id' })
    setMarking(false)
    if (err) { toast.error(err.message); return }
    toast.success(`Marked ${toInsert.length} as custom pricing — excluded from this audit`)
    setRows((prev) => (prev ?? []).filter((r) => !selectedIds.has(r.id)))
    setSelectedIds(new Set())
    setClearSelectionToken((t) => t + 1)
  }

  const col = useMemo(() => createColumnHelper<AuditRow>(), [])
  const columns = useMemo(() => [
    col.accessor((r) => shopLabel(r.locationId), { id: 'shop', header: 'Shop' }),
    col.accessor('productId', { header: 'Product' }),
    col.accessor('category', { header: 'Category', cell: (i) => i.getValue() || '—' }),
    col.display({
      id: 'cost', header: 'Cost (Shop / Expected)',
      cell: (i) => {
        const r = i.row.original
        if (r.unitCost == null) return <span className="text-inky/30">—</span>
        return (
          <span className={r.costMismatch ? 'text-[#C0392B] font-bold' : 'text-inky'}>
            {money(r.unitCost)} {r.costMismatch && r.expectedCost != null && <span className="text-inky/50 font-normal">(exp. {money(r.expectedCost)})</span>}
          </span>
        )
      },
    }),
    col.display({
      id: 'retail', header: 'Retail (Shop / Expected)',
      cell: (i) => {
        const r = i.row.original
        if (r.unitRetail == null) return <span className="text-inky/30">—</span>
        return (
          <span className={r.retailMismatch ? 'text-[#E67E22] font-bold' : 'text-inky'}>
            {money(r.unitRetail)} {r.retailMismatch && r.expectedRetail != null && <span className="text-inky/50 font-normal">(exp. {money(r.expectedRetail)})</span>}
          </span>
        )
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col, loc.locations])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(rows ?? [], columns, { persistKey: 'product-price-audit' })
  useColumnPrefs('product-price-audit', table, columnVisibility, columnOrder, setColumnOrder)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Product Pricing Audit</h2>
        <p className="text-xs text-inky mt-0.5">
          Per-product cost/retail consistency across active, Corporate-owned shops. The "expected" value is whichever
          price is most common company-wide for that product — a shop differing from it is flagged. Cost (red) is
          rarely legitimately custom per shop; retail (orange) often is — select rows and mark them as Custom Product
          Pricing to exclude them here going forward.{' '}
          {customKeys.size > 0 && <span className="text-inky/60">({customKeys.size} already marked custom, hidden here.)</span>}
        </p>
      </div>

      {error && <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>}

      {rows === null || loc.loading ? (
        <div className="py-8"><SbLoader /></div>
      ) : (
        <DataTable
          table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
          exportFilename="product-pricing-audit"
          onSelectionChange={setSelectedIds} clearSelectionToken={clearSelectionToken}
          actions={selectedIds.size > 0 ? (
            <Button size="sm" loading={marking} onClick={markSelectedCustom}>
              Mark {selectedIds.size} Selected as Custom
            </Button>
          ) : undefined}
        />
      )}
    </div>
  )
}
