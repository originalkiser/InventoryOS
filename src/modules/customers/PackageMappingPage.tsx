// Package Mapping — classifies every distinct Droptop order package name
// as Oil Change, M5, or None, backing the M5% stat on Droptop Orders (M5%
// = count of M5 packages ÷ count of Oil Change packages). Droptop's real
// synced packages carry no financial_category data at all (confirmed
// empty on every row in production), and there's no single package
// literally named "Oil Change" either — package names span at least 3
// different naming eras (canonical menu tiers, cryptic legacy SKU codes,
// "<Tier> Oil Change - <oil type>" variants). Classification is therefore
// by exact package name, seeded once (migration
// 20260930d_droptop_package_classification.sql) against this account's
// real names but editable here going forward — a package renamed or
// introduced later just shows up as "None" until reviewed.
//
// Template 2 (Inline-Editable Data Table) per TABLE_TEMPLATES.md — a
// <select> per row, saved immediately on change.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { SbLoader, Toggle, Modal, Combobox } from '@/components/ui'
import { FRANCHISE_PACKAGE_KEYS, FRANCHISE_PACKAGE_LABELS } from '@/modules/marketing/menuboard/franchiseMenu'

// Which core.locations price columns an oil-change package can map to for
// the audit below — deliberately NOT the same as FranchisePackageKey/
// FRANCHISE_PACKAGE_KEYS (the Menu Board's own fixed 5-package layout).
// diesel_syn_blend/diesel_full_syn/european are real oil-change price
// columns on core.locations that some shops sell but that were never part
// of the printed Menu Board (confirmed via information_schema.columns,
// 2026-09-19 request) — supply_fee/disposal_fee/oil_inflation_surcharge
// are fees, not oil-change tiers, and are deliberately excluded.
// price_column itself stores a plain string (widened CHECK constraint,
// migration 20260930al), not a FranchisePackageKey.
const LOCATION_PRICE_COLUMNS: { value: string; label: string }[] = [
  ...FRANCHISE_PACKAGE_KEYS.map((k) => ({ value: k, label: FRANCHISE_PACKAGE_LABELS[k] })),
  { value: 'diesel_syn_blend', label: 'Diesel Synthetic Blend' },
  { value: 'diesel_full_syn', label: 'Diesel Full Synthetic' },
  { value: 'european', label: 'European' },
]
const NOT_MAPPED_OPTION = { value: '', label: 'Not mapped' }

// The generic 'm5' bucket (migration 20260930d) was split into its 5
// specific sub-categories (migration 20260930j) once the Staffing Report
// needed each one's own percentage (Tire Rotation %, Air Filter %, etc.),
// not just one combined M5%. isM5() below is what still lets every
// existing "M5% = M5 ÷ Oil Change" computation treat all 5 as one bucket
// without caring which specific one a package is.
export type Classification = 'oil_change' | 'air_filter' | 'cabin_air_filter' | 'wiper_blades' | 'additives' | 'tire_rotation' | 'none'
export function isM5(c: Classification): boolean {
  return c === 'air_filter' || c === 'cabin_air_filter' || c === 'wiper_blades' || c === 'additives' || c === 'tire_rotation'
}
interface PackageRow { name: string; orderCount: number; classification: Classification; priceColumn: string | null }

const CLASSIFICATION_OPTIONS: { value: Classification; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'oil_change', label: 'Oil Change' },
  { value: 'air_filter', label: 'M5 — Air Filter' },
  { value: 'cabin_air_filter', label: 'M5 — Cabin Air Filter' },
  { value: 'wiper_blades', label: 'M5 — Wiper Blades' },
  { value: 'additives', label: 'M5 — Additives' },
  { value: 'tire_rotation', label: 'M5 — Tire Rotation' },
]
const selectCls = 'bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky'

export function PackageMappingPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<PackageRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setRows(null)
    setError(null)
    const sb = supabase as any
    async function run() {
      // Grouped server-side (get_droptop_package_name_counts) rather than
      // pulling every droptop_order_packages row (670k+) to the client just
      // to dedupe names — that would also silently truncate at PostgREST's
      // row cap and undercount. Confirmed via EXPLAIN ANALYZE: ~1.2s for
      // the full scan, since the actual result is only ~80-100 rows.
      const { data: pkgCounts, error: pkgErr } = await sb.rpc('get_droptop_package_name_counts')
      if (pkgErr) throw new Error(pkgErr.message)
      const { data: classRows, error: classErr } = await sb.schema('inventory').from('droptop_package_classification')
        .select('package_name, classification, price_column').eq('company_id', companyId)
      if (classErr) throw new Error(classErr.message)
      const classByName = new Map<string, { package_name: string; classification: Classification; price_column: string | null }>(
        (classRows ?? []).map((r: { package_name: string; classification: Classification; price_column: string | null }) => [r.package_name, r]),
      )
      const merged: PackageRow[] = ((pkgCounts ?? []) as { name: string; order_count: number | string }[])
        .map((r): PackageRow => {
          const c = classByName.get(r.name)
          return { name: r.name, orderCount: Number(r.order_count), classification: (c?.classification ?? 'none') as Classification, priceColumn: c?.price_column ?? null }
        })
        .sort((a: PackageRow, b: PackageRow) => b.orderCount - a.orderCount)
      if (!cancelled) setRows(merged)
    }
    run().catch((e) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : 'Failed to load packages')
      setRows([])
    })
    return () => { cancelled = true }
  }, [companyId])

  async function updateClassification(name: string, classification: Classification) {
    if (!companyId) return
    setRows((prev) => prev?.map((r) => (r.name === name ? { ...r, classification } : r)) ?? prev)
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('droptop_package_classification')
      .upsert({ company_id: companyId, package_name: name, classification, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,package_name' })
    if (error) toast.error(`Couldn't save "${name}": ${error.message}`)
  }

  // Which core.locations price column an oil-change package's base price
  // should be checked against (2026-09-19 follow-up, price audit below) —
  // omitting `classification` from this upsert leaves it untouched on an
  // existing row (PostgREST only SETs columns present in the payload on
  // conflict); a brand-new row falls back to the column's own DB default
  // ('none') the same way updateClassification's own upsert already relies
  // on for price_column (NULL by default).
  async function updatePriceColumn(name: string, priceColumn: string) {
    if (!companyId) return
    const value = priceColumn === '' ? null : priceColumn
    setRows((prev) => prev?.map((r) => (r.name === name ? { ...r, priceColumn: value } : r)) ?? prev)
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('droptop_package_classification')
      .upsert({ company_id: companyId, package_name: name, price_column: value, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,package_name' })
    if (error) toast.error(`Couldn't save "${name}": ${error.message}`)
  }

  const [oilChangeOnly, setOilChangeOnly] = useState(false)
  const visibleRows = useMemo(() => (oilChangeOnly ? (rows ?? []).filter((r) => r.classification === 'oil_change') : rows ?? []), [rows, oilChangeOnly])

  const col = useMemo(() => createColumnHelper<PackageRow>(), [])
  const columns = useMemo(() => [
    col.accessor('name', { header: 'Package Name', cell: (i) => i.getValue() }),
    col.accessor('orderCount', { header: 'Order Count', cell: (i) => i.getValue().toLocaleString() }),
    col.accessor('classification', {
      header: 'Classification',
      cell: (i) => {
        const row = i.row.original
        return (
          <select value={row.classification} onChange={(e) => updateClassification(row.name, e.target.value as Classification)} className={selectCls}>
            {CLASSIFICATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )
      },
    }),
    col.accessor('priceColumn', {
      header: 'Location List Column',
      cell: (i) => {
        const row = i.row.original
        if (row.classification !== 'oil_change') return <span className="text-inky/40">—</span>
        return (
          <div className="w-48">
            <Combobox
              options={[NOT_MAPPED_OPTION, ...LOCATION_PRICE_COLUMNS]}
              value={row.priceColumn ?? ''}
              onChange={(value) => updatePriceColumn(row.name, value)}
              placeholder="Not mapped"
            />
          </div>
        )
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col])

  const { table, globalFilter, setGlobalFilter } = useTable(visibleRows, columns, { persistKey: 'package-mapping' })
  const classificationByName = useMemo(() => new Map((rows ?? []).map((r) => [r.name, r])), [rows])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Package Mapping</h1>
        <p className="text-xs text-inky mt-0.5">
          Classifies every distinct Droptop package name as Oil Change, one of the 5 M5 sub-categories (Air Filter,
          Cabin Air Filter, Wiper Blades, Additives, Tire Rotation), or None — backs the M5% stat on Droptop Orders
          and the Staffing Report's per-category M5 breakdown (each % = that category's packages ÷ Oil Change
          packages). A newly-introduced or renamed package shows up here as "None" until classified.
        </p>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer self-start">
        <Toggle checked={oilChangeOnly} onChange={setOilChangeOnly} size="sm" color="cyan" />
        Oil change packages only
      </label>

      {rows === null ? (
        <div className="py-8"><SbLoader /></div>
      ) : (
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="package-mapping" />
      )}

      <PriceAuditSection oilChangeOnly={oilChangeOnly} classificationByName={classificationByName} />
    </div>
  )
}

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

/**
 * Droptop pricing audit (2026-09-19 follow-up) — what's actually being SOLD
 * in Droptop, per shop per package, over the last week, vs. what's most
 * important: for oil-change packages mapped to a core.locations price
 * column above, whether the shop's most common Droptop price matches the
 * location list at all. `classificationByName` comes from the page's own
 * live classification-table state (not this section's own audit RPC data)
 * so a just-made price-column mapping change is reflected here immediately,
 * without waiting for a refetch of the (much heavier) audit query.
 */
function PriceAuditSection({ oilChangeOnly, classificationByName }: {
  oilChangeOnly: boolean
  classificationByName: Map<string, PackageRow>
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [auditRows, setAuditRows] = useState<RawAuditRow[] | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [drilldown, setDrilldown] = useState<{ locationId: string; packageName: string } | null>(null)
  const [drilldownOrders, setDrilldownOrders] = useState<DrilldownOrder[] | null>(null)

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
  // "diesel_full_syn" (2026-09-19 follow-up) needs to show up here too. If
  // more than one raw package name maps to the same column for a shop (a
  // rare cross-naming-era overlap), keeps whichever has more orders behind it.
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

  const { table, globalFilter, setGlobalFilter } = useTable(visible, columns, { persistKey: 'package-price-audit' })

  return (
    <div className="flex flex-col gap-3 border-t border-navy/10 pt-4 mt-2">
      <div>
        <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Pricing Audit — Last {AUDIT_DAYS} Days</h2>
        <p className="text-xs text-inky mt-0.5">
          What's actually being sold in Droptop, per shop per package. For oil-change packages mapped to a location
          list column above, the most common price is checked against that column and highlighted red when they
          don't match. A package with more than one price seen this week gets a callout — click it to see the orders.
        </p>
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
