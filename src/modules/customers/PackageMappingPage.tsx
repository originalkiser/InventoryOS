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
import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { SbLoader } from '@/components/ui'

type Classification = 'oil_change' | 'm5' | 'none'
interface PackageRow { name: string; orderCount: number; classification: Classification }

const CLASSIFICATION_OPTIONS: { value: Classification; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'oil_change', label: 'Oil Change' },
  { value: 'm5', label: 'M5' },
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
        .select('package_name, classification').eq('company_id', companyId)
      if (classErr) throw new Error(classErr.message)
      const classByName = new Map((classRows ?? []).map((r: { package_name: string; classification: Classification }) => [r.package_name, r.classification]))
      const merged: PackageRow[] = ((pkgCounts ?? []) as { name: string; order_count: number | string }[])
        .map((r): PackageRow => ({
          name: r.name, orderCount: Number(r.order_count), classification: (classByName.get(r.name) ?? 'none') as Classification,
        }))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col])

  const { table, globalFilter, setGlobalFilter } = useTable(rows ?? [], columns, { persistKey: 'package-mapping' })

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Package Mapping</h1>
        <p className="text-xs text-inky mt-0.5">
          Classifies every distinct Droptop package name as Oil Change, M5 (Air Filter, Cabin Air Filter, Wiper Blade
          Replacement, Additives, Tire Rotation), or None — backs the M5% stat on Droptop Orders (M5% = M5 packages ÷
          Oil Change packages). A newly-introduced or renamed package shows up here as "None" until classified.
        </p>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {rows === null ? (
        <div className="py-8"><SbLoader /></div>
      ) : (
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="package-mapping" />
      )}
    </div>
  )
}
