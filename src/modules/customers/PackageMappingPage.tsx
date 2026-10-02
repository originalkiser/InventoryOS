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
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { SbLoader, Toggle, Combobox } from '@/components/ui'
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
export const LOCATION_PRICE_COLUMNS: { value: string; label: string }[] = [
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
export interface PackageRow { name: string; orderCount: number; classification: Classification; priceColumn: string | null }

export const CLASSIFICATION_OPTIONS: { value: Classification; label: string }[] = [
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

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(visibleRows, columns, { persistKey: 'package-mapping' })
  useColumnPrefs('package-mapping', table, columnVisibility, columnOrder, setColumnOrder)

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
    </div>
  )
}

// The package pricing audit previously lived here — moved to
// src/modules/customers/pricingAudit/PackagePricingAuditTab.tsx (direct ask
// 2026-10-02, see migration 20260930cc's own header comment) as part of the
// new Pricing Audit section. This page keeps only the classification table
// above.
