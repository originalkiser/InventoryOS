import { useEffect, useMemo, useState, useCallback } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Stat } from '@/components/config/ImportPreviewHost'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { LocationOrderConfig, Vendor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const NUM_FIELDS = ['capacity', 'order_trigger', 'order_limit']

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}

// VMI (vendor-managed inventory) is a Yes/blank flag stored on metadata.vmi.
function isYes(v: string): boolean {
  const t = v.trim().toLowerCase(); return t === 'yes' || t === 'y' || t === 'true' || t === '1' || t === 'x'
}

// Per-vendor: key by vendor + location + product so each vendor's config is
// separate and re-uploading a vendor's file updates only its rows. Shared
// between the actual import commit and the review modal's live diff so the
// two can never disagree about what counts as a match.
function orderConfigKeyOf(r: Partial<LocationOrderConfig>): string {
  return `${r.vendor_id ?? ''}|${r.location_id ?? ''}|${r.product_id ?? ''}`
}

const col = createColumnHelper<LocationOrderConfig>()

export function OrderConfigTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } = useConfigTab<LocationOrderConfig>('location_order_config', 'inventory')
  const { active: customFields, addField } = useCustomFields('order_config')
  const loc = useLocations()

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [uploadVendorId, setUploadVendorId] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  // "Update changes only" imports pause here for a live-recomputing review —
  // reselecting the vendor updates the match counts immediately, since it's
  // just local state feeding the useMemo below (no server round-trip needed).
  const [reviewMerge, setReviewMerge] = useState<{ rows: Record<string, string>[]; maps: ColumnMapping[] } | null>(null)
  const [reviewVendorId, setReviewVendorId] = useState('')

  const loadVendors = useCallback(async () => {
    if (!companyId) return
    const { data: v } = await (supabase as any).schema('inventory').from('vendors').select('*').eq('company_id', companyId).order('name')
    setVendors((v ?? []) as Vendor[])
  }, [companyId])
  useEffect(() => { loadVendors() }, [loadVendors])

  const vendorName = (id: string | null) => vendors.find((v) => v.id === id)?.name ?? '—'
  const vendorOptions: ComboboxOption[] = vendors.map((v) => ({ value: v.id, label: v.name }))

  // Non-linked custom fields are editable/stored; linked ones derive from the location.
  const ownFields = customFields.filter((f) => !f.linked_section)
  const linkedFields = customFields.filter((f) => f.linked_section)

  const [form, setForm] = useState({ vendorId: '', locationId: '', product_id: '', uom: '', capacity: '', order_trigger: '', order_limit: '', vmi: false })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      // Display the stored name/label string first (survives reload regardless of
      // id resolution); fall back to resolving the id if only that's present.
      { id: 'vendor', header: 'Vendor', accessorFn: (r: LocationOrderConfig) => (r.metadata as any)?.vendor_name || vendorName(r.vendor_id ?? (r.metadata as any)?.vendor_id ?? null), cell: (i: any) => i.getValue() },
      { id: 'location', header: 'Location', accessorFn: (r: LocationOrderConfig) => (r.metadata as any)?.location_label || loc.labelOf(r.location_id ?? (r.metadata as any)?.location_id ?? null), cell: (i: any) => i.getValue() },
      col.accessor('product_id', { header: 'Product ID' }),
      { id: 'uom', header: 'UoM', accessorFn: (r: LocationOrderConfig) => (r.metadata as any)?.uom ?? '', cell: (i: any) => i.getValue() || '—' },
      col.accessor('capacity', { header: 'Capacity', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_trigger', { header: 'Trigger', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_limit', { header: 'Limit (0 = inactive)', cell: (i) => i.getValue() ?? '—' }),
      { id: 'vmi', header: 'VMI', accessorFn: (r: LocationOrderConfig) => ((r.metadata as any)?.vmi ?? ''), cell: (i: any) => i.getValue() || '—' },
    ]
    for (const f of customFields) {
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.linked_section ? `${f.label} ↗` : f.label,
        accessorFn: (r: LocationOrderConfig) =>
          f.linked_section ? loc.fieldValue(r.location_id, f.linked_match_key || f.field_key) : ((r.metadata as any)?.[f.field_key] ?? ''),
        cell: (i: any) => i.getValue() || '—',
      })
    }
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as LocationOrderConfig; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as LocationOrderConfig)} className="text-xs font-mono text-inky hover:underline">Edit</button> })
    return cols
  }, [customFields, loc, vendors])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, { persistKey: 'config:order-config' })

  // All uploaded products are treated as active; set Order Limit to 0 to make a
  // product inactive. UoM is captured (used by UoM conversions).
  const uploadFields = [
    { name: 'location', label: 'Location', required: true },
    { name: 'product_id', label: 'Product ID', required: true },
    { name: 'uom', label: 'Unit of Measure' },
    { name: 'capacity', label: 'Capacity' },
    { name: 'order_trigger', label: 'Order Trigger' },
    { name: 'order_limit', label: 'Order Limit (0 = inactive)' },
    { name: 'vmi', label: 'VMI (Yes/blank)' },
    ...ownFields.map((f) => ({ name: f.field_key, label: f.label })),
  ]

  const ownKeys = useMemo(() => new Set(ownFields.map((f) => f.field_key)), [ownFields])

  function buildImportPayload(rows: Record<string, string>[], maps: ColumnMapping[], vendorId: string): Partial<LocationOrderConfig>[] {
    const vName = vendors.find((v) => v.id === vendorId)?.name ?? null
    return rows.map((row) => {
      const out: Record<string, unknown> = { vendor_id: vendorId || null, active: true }
      const meta: Record<string, unknown> = {}
      let locRaw = ''
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'location') { locRaw = raw; out.location_id = loc.resolveId(raw) }
        else if (m.fieldName === 'uom') meta.uom = raw || null
        else if (m.fieldName === 'vmi') meta.vmi = isYes(raw) ? 'Yes' : null
        else if (NUM_FIELDS.includes(m.fieldName)) out[m.fieldName] = num(raw)
        else if (ownKeys.has(m.fieldName)) meta[m.fieldName] = raw || null
        else out[m.fieldName] = raw || null
      }
      // Mirror vendor/location into metadata (id + display string) so they survive
      // reload even if the relocated table's base columns don't persist them.
      const locId = out.location_id as string | null
      meta.vendor_id = (out.vendor_id as string) ?? null
      meta.location_id = locId ?? null
      meta.vendor_name = vName
      meta.location_label = locId ? loc.labelOf(locId) : (locRaw.trim() || null)
      out.metadata = meta
      return out as Partial<LocationOrderConfig>
    }).filter((r: any) => r.product_id)
  }

  // Human-readable label for the review list — the raw key ("<vendor-id>|<location-id>|<product-id>")
  // is meaningless to a reader, so show the shop label instead of the location's uuid.
  function friendlyRowLabel(r: Partial<LocationOrderConfig>): string {
    const meta = (r.metadata as any) ?? {}
    const locLabel = meta.location_label || (r.location_id ? loc.labelOf(r.location_id) : null) || 'Unmatched location'
    return `${locLabel} — ${r.product_id ?? ''}`
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    if (mode === 'merge') {
      // Hand off to the review modal below instead of importing immediately —
      // it lets the vendor be corrected (and match counts recomputed live)
      // before anything is written, rather than discovering a mismatch after
      // the fact.
      setReviewVendorId(uploadVendorId)
      setReviewMerge({ rows, maps })
      return
    }
    setImporting(true)
    const payload = buildImportPayload(rows, maps, uploadVendorId)
    await importRows(payload, { mode, source: 'upload', keyOf: orderConfigKeyOf, labelOf: friendlyRowLabel })
    setImporting(false)
  }

  // Recomputed on every reviewVendorId change — purely local state, so
  // reselecting the vendor in the review modal updates matched/new counts
  // instantly with no extra round-trip.
  const reviewPayload = useMemo(
    () => (reviewMerge ? buildImportPayload(reviewMerge.rows, reviewMerge.maps, reviewVendorId) : []),
    [reviewMerge, reviewVendorId, vendors, loc, ownKeys], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const reviewDiff = useMemo(() => {
    if (!reviewMerge) return null
    const existingByKey = new Map<string, string>()
    for (const d of data) {
      if (!d.id) continue
      const k = orderConfigKeyOf(d)
      if (!existingByKey.has(k)) existingByKey.set(k, d.id)
    }
    let matched = 0
    const newLabels: string[] = []
    for (const r of reviewPayload) {
      if (existingByKey.has(orderConfigKeyOf(r))) matched++
      else newLabels.push(friendlyRowLabel(r))
    }
    return { total: reviewPayload.length, matched, creates: reviewPayload.length - matched, newLabels }
  }, [reviewMerge, reviewPayload, data]) // eslint-disable-line react-hooks/exhaustive-deps

  async function confirmMergeImport() {
    if (!reviewMerge || !reviewDiff) return
    setImporting(true)
    const ok = await importRows(reviewPayload, { mode: 'merge', source: 'upload', keyOf: orderConfigKeyOf, confirm: false })
    setImporting(false)
    if (ok) setReviewMerge(null)
  }

  function resetForm() { setForm({ vendorId: '', locationId: '', product_id: '', uom: '', capacity: '', order_trigger: '', order_limit: '', vmi: false }); setCustomVals({}) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: LocationOrderConfig) {
    setEditId(r.id)
    setForm({
      vendorId: r.vendor_id ?? (r.metadata as any)?.vendor_id ?? '', locationId: r.location_id ?? (r.metadata as any)?.location_id ?? '', product_id: r.product_id ?? '', uom: ((r.metadata as any)?.uom ?? '') as string,
      capacity: r.capacity?.toString() ?? '', order_trigger: r.order_trigger?.toString() ?? '', order_limit: r.order_limit?.toString() ?? '',
      vmi: isYes(String((r.metadata as any)?.vmi ?? '')),
    })
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCustomVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.locationId || !form.product_id.trim()) return
    const meta: Record<string, unknown> = {}
    for (const f of ownFields) meta[f.field_key] = customVals[f.field_key] || null
    if (form.uom.trim()) meta.uom = form.uom.trim()
    meta.vmi = form.vmi ? 'Yes' : null
    // Mirror vendor/location into metadata (id + display string — see columns).
    meta.vendor_id = form.vendorId || null
    meta.location_id = form.locationId || null
    meta.vendor_name = form.vendorId ? (vendors.find((v) => v.id === form.vendorId)?.name ?? null) : null
    meta.location_label = form.locationId ? loc.labelOf(form.locationId) : null
    const payload = {
      vendor_id: form.vendorId || null,
      location_id: form.locationId, product_id: form.product_id.trim(),
      capacity: num(form.capacity), order_trigger: num(form.order_trigger), order_limit: num(form.order_limit),
      active: true, metadata: meta,
    } as Partial<LocationOrderConfig>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this order config row?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="order_config.csv" exportData={data} loading={loading}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
          <Button size="sm" onClick={openAdd}>+ Add Config</Button>
        </>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File (per vendor)</h3>
          <Combobox label="Vendor for this file" options={[{ value: '', label: '— No vendor —' }, ...vendorOptions]} value={uploadVendorId}
            onChange={(v) => setUploadVendorId(v)} placeholder="Select vendor (optional)" />
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} onAddColumn={(label) => addField({ label })} />
          <p className="text-xs font-mono text-inky/70">Tag the file with a vendor to keep each vendor's order config separate. Re-uploading a vendor's file updates only its rows.</p>
        </div>
        <DataSourceLinker configType="location_order_configs" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Order Config' : 'Add Order Config'} size="lg">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Combobox label="Vendor" options={[{ value: '', label: '— No vendor —' }, ...vendorOptions]} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} placeholder="Optional" />
            <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Unit of Measure" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} />
            <Input label="Capacity" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            <Input label="Order Trigger" value={form.order_trigger} onChange={(e) => setForm({ ...form, order_trigger: e.target.value })} />
            <Input label="Order Limit" value={form.order_limit} onChange={(e) => setForm({ ...form, order_limit: e.target.value })} />
            {ownFields.map((f) => (
              <Input key={f.id} label={f.label} value={customVals[f.field_key] ?? ''} onChange={(e) => setCustomVals({ ...customVals, [f.field_key]: e.target.value })} />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={form.vmi} onChange={(v) => setForm({ ...form, vmi: v })} size="sm" />
            VMI — vendor-managed inventory (excluded from self-generated orders)
          </label>
          {linkedFields.length > 0 && (
            <p className="text-xs font-mono text-inky/70">Linked columns ({linkedFields.map((f) => f.label).join(', ')}) are pulled from the selected location automatically.</p>
          )}
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.locationId || !form.product_id.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Order Config Columns" size="lg">
        <CustomFieldsEditor section="order_config" linkSections={[{ value: 'locations', label: 'Locations' }]} />
      </Modal>

      <Modal open={!!reviewMerge} onClose={() => setReviewMerge(null)} title="Review Import" size="lg">
        {reviewMerge && reviewDiff && (
          <div className="flex flex-col gap-4">
            <Combobox
              label="Vendor for this file"
              options={[{ value: '', label: '— No vendor —' }, ...vendorOptions]}
              value={reviewVendorId}
              onChange={setReviewVendorId}
              placeholder="Select vendor"
            />
            {!reviewVendorId && (
              <div className="rounded border border-[#E67E22]/40 bg-[#E67E22]/10 px-3 py-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22]">No vendor selected</span>
                <p className="text-xs font-body text-navy leading-relaxed mt-1">
                  Rows will be matched by location + product only. If the existing config rows for this file were
                  tagged with a vendor, pick it above — otherwise every row here comes back as new instead of
                  updating in place.
                </p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Rows in file" value={reviewDiff.total} />
              <Stat label="Existing rows updated" value={reviewDiff.matched} />
              <Stat label="New rows added" value={reviewDiff.creates} tone={reviewDiff.creates > 0 ? 'warn' : undefined} />
            </div>

            {reviewDiff.creates > 0 && reviewDiff.creates >= reviewDiff.matched && (
              <div className="rounded border border-[#E67E22]/40 bg-[#E67E22]/10 px-3 py-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22]">Check the vendor</span>
                <p className="text-xs font-body text-navy leading-relaxed mt-1">
                  Most rows in this file didn't match anything existing. If you expected these to update, try a
                  different vendor above — a mismatched vendor creates duplicates instead of updating current rows.
                </p>
              </div>
            )}

            {reviewDiff.creates > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
                  New records being added ({reviewDiff.creates.toLocaleString()})
                </span>
                <div className="max-h-60 overflow-auto rounded border border-navy/20 divide-y divide-navy/10">
                  {reviewDiff.newLabels.slice(0, 200).map((label, i) => (
                    <div key={i} className="px-2 py-1 text-xs font-mono text-navy break-all">{label}</div>
                  ))}
                </div>
                {reviewDiff.newLabels.length > 200 && (
                  <span className="text-[10px] font-mono text-inky/50">
                    …and {(reviewDiff.newLabels.length - 200).toLocaleString()} more not listed
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs font-body text-inky">
                No new records — every row in this file matches something that already exists and will be updated in place.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setReviewMerge(null)}>Cancel</Button>
              <Button size="sm" onClick={confirmMergeImport} disabled={importing}>
                {importing
                  ? 'Importing…'
                  : reviewDiff.creates > 0
                    ? `Update ${reviewDiff.matched.toLocaleString()} · Add ${reviewDiff.creates.toLocaleString()}`
                    : `Update ${reviewDiff.matched.toLocaleString()} rows`}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
