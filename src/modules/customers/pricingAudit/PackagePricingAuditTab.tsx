// Package Pricing Audit — relocated here from Package Mapping (direct ask
// 2026-10-02, part of the new Pricing Audit section) verbatim, no logic
// change. Package Mapping keeps its own classification table (config, not
// an audit); this reads that same classification data independently
// (package_name -> classification/price_column) since it now lives on a
// different page and can't share that page's own component state anymore.
//
// Droptop pricing audit (originally 2026-09-19) — what's actually being
// SOLD in Droptop, per shop per package, over the last week, vs. for
// oil-change packages mapped to a core.locations price column (set on
// Package Mapping), whether the shop's most common Droptop price matches
// the location list at all.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { SbLoader, Toggle, Modal } from '@/components/ui'
import { CLASSIFICATION_OPTIONS, LOCATION_PRICE_COLUMNS, type Classification } from '../PackageMappingPage'

const AUDIT_DAYS = 7

interface RawAuditRow {
  locationId: string
  packageName: string
  modePrice: number
  modeCount: number
  totalCount: number
  distinctPriceCount: number
}

interface EnrichedAuditRow extends RawAuditRow {
  classification: Classification
  priceColumn: string | null
  listPrice: number | null
  mismatch: boolean
}

interface DrilldownOrder {
  order_id: string
  order_finalized_at: string
  base_service_price: number
  vehicle_name: string | null
  license_plate: string | null
}

export function PackagePricingAuditTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [oilChangeOnly, setOilChangeOnly] = useState(false)
  const [auditRows, setAuditRows] = useState<RawAuditRow[] | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [drilldown, setDrilldown] = useState<{ locationId: string; packageName: string } | null>(null)
  const [drilldownOrders, setDrilldownOrders] = useState<DrilldownOrder[] | null>(null)
  const [classificationByName, setClassificationByName] = useState<Map<string, { classification: Classification; priceColumn: string | null }>>(new Map())

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.schema('inventory').from('droptop_package_classification')
      .select('package_name, classification, price_column').eq('company_id', companyId)
      .then(({ data }: any) => {
        if (cancelled) return
        setClassificationByName(new Map((data ?? []).map((r: { package_name: string; classification: Classification; price_column: string | null }) =>
          [r.package_name, { classification: r.classification, priceColumn: r.price_column }])))
      })
    return () => { cancelled = true }
  }, [companyId])

  const load = useCallback(async () => {
    if (!companyId) return
    setAuditRows(null)
    setAuditError(null)
    const sb = supabase as any
    const { data, error } = await sb.rpc('get_droptop_package_price_audit', { p_days: AUDIT_DAYS })
    if (error) { setAuditError(error.message); setAuditRows([]); return }
    setAuditRows((data ?? []).map((r: any): RawAuditRow => ({
      locationId: r.location_id, packageName: r.package_name,
      modePrice: Number(r.mode_price), modeCount: Number(r.mode_count),
      totalCount: Number(r.total_count), distinctPriceCount: Number(r.distinct_price_count),
    })))
  }, [companyId])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!drilldown) { setDrilldownOrders(null); return }
    let cancelled = false
    const sb = supabase as any
    sb.rpc('get_droptop_package_price_audit_orders', {
      p_location_id: drilldown.locationId, p_package_name: drilldown.packageName, p_days: AUDIT_DAYS,
    }).then(({ data, error }: any) => {
      if (cancelled) return
      if (error) { toast.error(error.message); setDrilldownOrders([]); return }
      setDrilldownOrders((data ?? []) as DrilldownOrder[])
    })
    return () => { cancelled = true }
  }, [drilldown])

  function shopLabel(locationId: string): string {
    const l = loc.locations.find((x) => x.id === locationId)
    return l ? (l.shop_city || l.name) : locationId
  }

  const enriched = useMemo((): EnrichedAuditRow[] => (auditRows ?? []).map((r) => {
    const c = classificationByName.get(r.packageName)
    const classification = c?.classification ?? 'none'
    const priceColumn = c?.priceColumn ?? null
    const location = loc.locations.find((l) => l.id === r.locationId)
    const listPrice = priceColumn && location ? ((location as any)[priceColumn] as number | null) : null
    const mismatch = priceColumn != null && listPrice != null && Math.abs(listPrice - r.modePrice) > 0.005
    return { ...r, classification, priceColumn, listPrice, mismatch }
  }), [auditRows, classificationByName, loc.locations])

  const visible = useMemo(
    () => (oilChangeOnly ? enriched.filter((r) => r.classification === 'oil_change') : enriched),
    [enriched, oilChangeOnly],
  )

  // Exception summary — one row per shop with at least one oil-change
  // mismatch, one column per LOCATION_PRICE_COLUMNS entry (Droptop price
  // next to list price) rather than one row per (shop, package) — matches
  // the same shape as the Franchise tab's own pricing-discrepancy report.
  // Covers every mappable column, not just the 5 canonical Menu Board
  // packages, since a package mapped to e.g. "european" or
  // "diesel_full_syn" needs to show up here too. If more than one raw
  // package name maps to the same column for a shop (a rare cross-naming-
  // era overlap), keeps whichever has more orders behind it.
  const exceptions = useMemo(() => {
    type ExceptionCell = { totalCount: number; droptopPrice: number; listPrice: number }
    const byShop = new Map<string, Partial<Record<string, ExceptionCell>>>()
    for (const r of enriched) {
      if (r.classification !== 'oil_change' || !r.priceColumn || !r.mismatch || r.listPrice == null) continue
      const bucket = byShop.get(r.locationId) ?? {}
      const existing = bucket[r.priceColumn]
      if (!existing || r.totalCount > existing.totalCount) {
        bucket[r.priceColumn] = { totalCount: r.totalCount, droptopPrice: r.modePrice, listPrice: r.listPrice }
      }
      byShop.set(r.locationId, bucket)
    }
    return Array.from(byShop.entries())
      .map(([locationId, diffs]) => ({ locationId, shopLabel: shopLabel(locationId), diffs }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched])

  const col = useMemo(() => createColumnHelper<EnrichedAuditRow>(), [])
  const columns = useMemo(() => [
    col.accessor((r) => shopLabel(r.locationId), { id: 'shop', header: 'Shop' }),
    col.accessor('packageName', { header: 'Package Name' }),
    col.accessor('classification', {
      header: 'Classification',
      cell: (i) => CLASSIFICATION_OPTIONS.find((o) => o.value === i.getValue())?.label ?? i.getValue(),
    }),
    col.display({
      id: 'modePrice',
      header: `Most Common Price (Last ${AUDIT_DAYS} Days)`,
      cell: (i) => {
        const r = i.row.original
        return (
          <div className="flex items-center gap-1.5">
            <span>${r.modePrice.toFixed(2)}</span>
            <span className="text-inky/50">({r.modeCount}/{r.totalCount} orders)</span>
            {r.distinctPriceCount > 1 && (
              <button onClick={() => setDrilldown({ locationId: r.locationId, packageName: r.packageName })}
                className="text-[10px] font-mono text-[#E67E22] border border-[#E67E22]/50 rounded px-1.5 py-0.5 hover:bg-[#E67E22]/10"
                title="More than one price seen this week — click to see the orders">
                ⚠ {r.distinctPriceCount} prices seen
              </button>
            )}
          </div>
        )
      },
    }),
    col.display({
      id: 'listPrice',
      header: 'Location List Price',
      cell: (i) => {
        const r = i.row.original
        if (r.priceColumn == null) return <span className="text-inky/40">—</span>
        return (
          <span className={r.mismatch ? 'text-[#C0392B] font-bold' : 'text-inky'}>
            {r.listPrice != null ? `$${r.listPrice.toFixed(2)}` : '—'}
          </span>
        )
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col, loc.locations])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(visible, columns, { persistKey: 'package-price-audit' })
  useColumnPrefs('package-price-audit', table, columnVisibility, columnOrder, setColumnOrder)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Package Pricing Audit — Last {AUDIT_DAYS} Days</h2>
          <p className="text-xs text-inky mt-0.5">
            What's actually being sold in Droptop, per shop per package. For oil-change packages mapped to a location
            list column (set on Package Mapping), the most common price is checked against that column and
            highlighted red when they don't match. A package with more than one price seen this week gets a callout —
            click it to see the orders.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
          <Toggle checked={oilChangeOnly} onChange={setOilChangeOnly} size="sm" color="cyan" />
          Oil change packages only
        </label>
      </div>

      {auditError && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{auditError}</p>
      )}

      {auditRows === null || loc.loading ? (
        <div className="py-8"><SbLoader /></div>
      ) : (
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="droptop-price-audit" />
      )}

      <div>
        <h3 className="text-xs font-heading font-bold text-[#C0392B] uppercase tracking-wide">Pricing Exceptions</h3>
        <p className="text-[11px] font-mono text-inky mt-0.5">Shops with at least one oil-change package whose Droptop price doesn't match the location list.</p>
      </div>
      {exceptions.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-3 text-center">No pricing exceptions this week.</p>
      ) : (
        <div className="overflow-auto rounded border border-[#C0392B]/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
              <th className="text-left px-3 py-2 sticky left-0 bg-cream">Shop</th>
              {LOCATION_PRICE_COLUMNS.map(({ value, label }) => (
                <th key={value} className="text-center px-3 py-2 whitespace-nowrap font-normal normal-case">{label}</th>
              ))}
            </tr></thead>
            <tbody>
              {exceptions.map((ex) => (
                <tr key={ex.locationId} className="border-b border-navy/10 hover:bg-navy/5">
                  <td className="px-3 py-2 text-navy sticky left-0 bg-cream whitespace-nowrap">{ex.shopLabel}</td>
                  {LOCATION_PRICE_COLUMNS.map(({ value }) => {
                    const diff = ex.diffs[value]
                    if (!diff) return <td key={value} className="px-3 py-2 text-center text-inky/30">—</td>
                    return (
                      <td key={value} className="px-3 py-2 text-center whitespace-nowrap">
                        <div className="text-inky">List: ${diff.listPrice.toFixed(2)}</div>
                        <div className="text-[#C0392B] font-bold">Droptop: ${diff.droptopPrice.toFixed(2)}</div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!drilldown} onClose={() => setDrilldown(null)} title={drilldown ? `${shopLabel(drilldown.locationId)} — ${drilldown.packageName}` : ''} size="lg">
        {drilldownOrders === null ? (
          <div className="py-8"><SbLoader /></div>
        ) : (
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-xs font-mono">
              <thead><tr className="text-inky uppercase border-b border-navy/20 sticky top-0 bg-cream">
                <th className="text-left py-1.5 px-2 font-normal">Finalized</th>
                <th className="text-right py-1.5 px-2 font-normal">Price</th>
                <th className="text-left py-1.5 px-2 font-normal">Vehicle</th>
                <th className="text-left py-1.5 px-2 font-normal">Plate</th>
              </tr></thead>
              <tbody>
                {drilldownOrders.map((o) => (
                  <tr key={o.order_id} className="border-b border-navy/5">
                    <td className="py-1.5 px-2 text-inky whitespace-nowrap">{new Date(o.order_finalized_at).toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right text-navy font-bold">${Number(o.base_service_price).toFixed(2)}</td>
                    <td className="py-1.5 px-2 text-inky">{o.vehicle_name || '—'}</td>
                    <td className="py-1.5 px-2 text-inky">{o.license_plate || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}
