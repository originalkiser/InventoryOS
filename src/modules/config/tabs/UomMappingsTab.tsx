import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal, Combobox, Card, CardBody, Select } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { UomMapping, Vendor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'from_unit', label: 'From Unit (on-hand)', required: true },
  { name: 'to_unit', label: 'To Unit (order)', required: true },
  { name: 'factor', label: 'Factor', required: true },
  { name: 'order_type', label: 'Order Type (Package/Bulk, Orders v2)' },
]

// Orders v2 reads quarts-per-package from rows whose to_unit normalizes to
// one of these — see quartsForUom in useOrdersV2.ts. Kept in sync manually
// since that's an orders-v2 concern and this is a config tab.
const QUART_NAMES = new Set(['quart', 'quarts', 'qt', 'qts'])
const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()

const col = createColumnHelper<UomMapping>()
const EMPTY = { vendorId: '', from_unit: '', to_unit: '', factor: '', orderType: '' }
const ORDER_TYPE_LABEL: Record<string, string> = { package: 'Package', bulk: 'Bulk' }

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }

interface UnmappedRow { vendorId: string | null; uom: string }

export function UomMappingsTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } = useConfigTab<UomMapping>('uom_mappings', 'inventory')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [partUoms, setPartUoms] = useState<{ vendor_id: string | null; unit_of_measure: string | null }[]>([])

  const loadVendors = useCallback(async () => {
    if (!companyId) return
    const { data: v } = await (supabase as any).schema('inventory').from('vendors').select('*').eq('company_id', companyId).order('name')
    setVendors((v ?? []) as Vendor[])
  }, [companyId])
  useEffect(() => { loadVendors() }, [loadVendors])

  // Just for surfacing what still needs a quarts conversion below — not the
  // vendor part records themselves.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    ;(supabase as any).schema('inventory').from('vendor_parts').select('vendor_id, unit_of_measure').eq('company_id', companyId)
      .then(({ data: rows }: any) => { if (!cancelled) setPartUoms((rows ?? []) as any[]) })
    return () => { cancelled = true }
  }, [companyId])

  const vendorMap = useMemo(() => new Map(vendors.map((v) => [v.id, v.name])), [vendors])
  const vendorName = (id: string | null) => (id ? vendorMap.get(id) : '') || 'All vendors'
  const vendorOptions: ComboboxOption[] = [{ value: '', label: 'All vendors' }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]

  // Any (vendor, UOM) pair used on a vendor part that no mapping covers yet
  // — either a vendor-specific row, or a global (no-vendor) row for that UOM.
  const unmapped: UnmappedRow[] = useMemo(() => {
    const covered = new Set<string>()
    for (const m of data) {
      if (!QUART_NAMES.has(pkey(m.to_unit))) continue
      covered.add(`${m.vendor_id ?? ''}|${pkey(m.from_unit)}`)
      if (!m.vendor_id) covered.add(`ALL|${pkey(m.from_unit)}`) // marked separately so any vendor can match it below
    }
    const seen = new Set<string>()
    const out: UnmappedRow[] = []
    for (const p of partUoms) {
      if (!p.unit_of_measure) continue
      const u = pkey(p.unit_of_measure)
      const key = `${p.vendor_id ?? ''}|${u}`
      if (seen.has(key)) continue
      seen.add(key)
      const isCovered = covered.has(key) || covered.has(`ALL|${u}`)
      if (!isCovered) out.push({ vendorId: p.vendor_id, uom: p.unit_of_measure })
    }
    return out.sort((a, b) => a.uom.localeCompare(b.uom))
  }, [data, partUoms])

  const COLUMNS = [
    { id: 'vendor', header: 'Vendor', accessorFn: (r: UomMapping) => vendorName(r.vendor_id) },
    col.accessor('from_unit', { header: 'From (on-hand)' }),
    col.accessor('to_unit', { header: 'To (order)' }),
    col.accessor('factor', { header: 'Factor', cell: (i) => i.getValue() ?? '—' }),
    { id: 'order_type', header: 'Order Type', accessorFn: (r: UomMapping) => r.order_type ?? '', cell: (i: any) => ORDER_TYPE_LABEL[i.getValue()] ?? '—' },
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as UomMapping)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ]
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS, { persistKey: 'config:uom-mappings' })

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: UomMapping) {
    setEditId(r.id)
    setForm({ vendorId: r.vendor_id ?? '', from_unit: r.from_unit ?? '', to_unit: r.to_unit ?? '', factor: r.factor?.toString() ?? '', orderType: r.order_type ?? '' })
    setAddOpen(true)
  }
  function openUnmapped(u: UnmappedRow) {
    setEditId(null)
    setForm({ vendorId: u.vendorId ?? '', from_unit: u.uom, to_unit: 'Quarts', factor: '', orderType: '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        if (m.fieldName === 'factor') out[m.fieldName] = num(v)
        else if (m.fieldName === 'order_type') out[m.fieldName] = ORDER_TYPE_LABEL[pkey(v)] ? pkey(v) : null
        else out[m.fieldName] = v || null
      }
      return out as Partial<UomMapping>
    }).filter((r: any) => r.from_unit && r.to_unit)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.vendor_id ?? ''}|${String(r.from_unit ?? '').toLowerCase()}|${String(r.to_unit ?? '').toLowerCase()}` })
    setImporting(false)
  }

  async function onSubmit() {
    const factor = num(form.factor)
    if (!form.from_unit.trim() || !form.to_unit.trim() || factor == null) return
    const payload = {
      vendor_id: form.vendorId || null, from_unit: form.from_unit.trim(), to_unit: form.to_unit.trim(), factor,
      order_type: (form.orderType || null) as UomMapping['order_type'],
    } as Partial<UomMapping>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this UoM mapping?')) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Unit-of-Measure Conversions</h2>
        <p className="text-xs text-inky mt-0.5">Factor to convert an on-hand unit into an order unit. E.g. EA → CS factor 0.0833 means 12 each = 1 case. Set a product&apos;s order unit on Global Products. A UOM (e.g. Drum) can mean a different size per vendor — leave Vendor blank to apply a factor to any vendor using that UOM name.</p>
      </div>

      {unmapped.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22]">Unmapped ({unmapped.length})</span>
          <p className="text-[11px] font-mono text-inky/60">
            UOMs in use on Vendor Parts with no quarts conversion on file — Orders v2 falls back to each part&apos;s Package Qty (Gal) × 4 for these, when set. Click one to add its conversion.
          </p>
          <div className="flex flex-wrap gap-2">
            {unmapped.map((u) => (
              <button key={`${u.vendorId ?? ''}|${u.uom}`} onClick={() => openUnmapped(u)}
                className="text-[11px] font-mono rounded-full border border-[#E67E22]/50 bg-[#E67E22]/10 text-navy px-3 py-1 hover:border-[#E67E22] transition-colors">
                {u.uom} <span className="text-inky/50">— {vendorName(u.vendorId)}</span>
              </button>
            ))}
          </div>
        </CardBody></Card>
      )}

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="uom_mappings.csv" exportData={data} loading={loading}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<><Button size="sm" onClick={openAdd}>+ Add Mapping</Button></>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="uom_mappings" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit UoM Mapping' : 'Add UoM Mapping'}>
        <div className="flex flex-col gap-3">
          <Combobox label="Vendor" options={vendorOptions} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} placeholder="All vendors" />
          <div className="grid grid-cols-3 gap-3">
            <Input label="From Unit *" value={form.from_unit} onChange={(e) => setForm({ ...form, from_unit: e.target.value })} placeholder="Drum" />
            <Input label="To Unit *" value={form.to_unit} onChange={(e) => setForm({ ...form, to_unit: e.target.value })} placeholder="Quarts" />
            <Input label="Factor *" value={form.factor} onChange={(e) => setForm({ ...form, factor: e.target.value })} placeholder="55" />
          </div>
          <Select label="Order Type (Orders v2)" value={form.orderType} onChange={(e) => setForm({ ...form, orderType: e.target.value })}
            options={[{ value: '', label: "Default (uom must say \"bulk\")" }, { value: 'package', label: 'Package' }, { value: 'bulk', label: 'Bulk' }]} />
          <p className="text-[10px] font-mono text-inky/50 -mt-2">
            Overrides how Orders v2 classifies this UOM for grouping and the PO number&apos;s B/P code — use it when a bulk product&apos;s UOM text doesn&apos;t literally say "bulk".
          </p>
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.from_unit.trim() || !form.to_unit.trim() || num(form.factor) == null}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
