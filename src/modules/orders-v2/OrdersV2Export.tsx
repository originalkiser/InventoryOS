import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Button, Card, CardBody, Input, SbLoader, Select, Toggle } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useDraft, type DraftLineRow } from './useOrdersV2'
import { useVendors } from './useLookups'
import { finalizeDraft } from './useOrderHistory'
import { poNumber, renderTemplate } from './engine'
import { money } from './shared'
import type { OrderType } from './types'

// Fields a source/composite column can reference.
export const EXPORT_FIELDS = [
  'po_number', 'shop_number', 'shop_name', 'product_id', 'uom', 'qty', 'unit_cost',
  'line_total', 'order_date', 'order_type', 'order_type_code', 'vendor',
] as const
export type ExportField = (typeof EXPORT_FIELDS)[number]

export type ColumnKind = 'source' | 'constant' | 'blank' | 'composite'
export interface ExportColumn {
  id: string
  kind: ColumnKind
  header: string
  field?: ExportField
  value?: string
  template?: string
}

export interface ExportTemplate {
  columns: ExportColumn[]
  file_name_template: string
  sheet_name_template: string
  format: 'xlsx' | 'csv'
  include_subject: boolean
  subject_template: string
  use_body_template: boolean
  body_template: string
}

const DEFAULT_TEMPLATE: ExportTemplate = {
  columns: [
    { id: 'c1', kind: 'composite', header: 'PO Number', template: '{shop_number}-{date:MMDDYYYY}{order_type_code}' },
    { id: 'c2', kind: 'source', header: 'Shop', field: 'shop_number' },
    { id: 'c3', kind: 'source', header: 'Product', field: 'product_id' },
    { id: 'c4', kind: 'source', header: 'Qty', field: 'qty' },
    { id: 'c5', kind: 'source', header: 'UOM', field: 'uom' },
  ],
  file_name_template: '{vendor}-{date:MMDDYYYY}',
  sheet_name_template: 'Order',
  format: 'xlsx',
  include_subject: false,
  subject_template: '{vendor} Order - {date:MMDDYYYY}',
  use_body_template: false,
  body_template: '',
}

const sb = () => supabase as any
const uid = () => Math.random().toString(36).slice(2, 9)

/**
 * Step 4 — build the vendor's file. The column list, naming and email
 * settings are saved per vendor and reused next time; a one-off tweak here
 * doesn't change that default until "Save as vendor default" is pressed.
 */
export function OrdersV2Export() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()
  const { draft, lines, loading } = useDraft(draftId || null)

  const [tpl, setTpl] = useState<ExportTemplate>(DEFAULT_TEMPLATE)
  const [savedTpl, setSavedTpl] = useState<ExportTemplate | null>(null)
  const [finalizing, setFinalizing] = useState(false)

  const shopNumber = useCallback((id: string | null) => {
    const label = loc.fieldValue(id, 'name') || loc.codeOf(id) || ''
    return (label.match(/\d+/)?.[0]) ?? label
  }, [loc])
  const shopName = useCallback((id: string | null) => loc.fieldValue(id, 'shop_city') || loc.codeOf(id) || '', [loc])

  // Load this vendor's saved template.
  useEffect(() => {
    if (!profile?.company_id || !draft?.vendor_id) return
    let cancelled = false
    sb().schema('inventory').from('ov2_export_templates')
      .select('*').eq('company_id', profile.company_id).eq('vendor_id', draft.vendor_id).maybeSingle()
      .then(({ data }: any) => {
        if (cancelled || !data) return
        const loaded: ExportTemplate = {
          columns: Array.isArray(data.columns) && data.columns.length ? data.columns : DEFAULT_TEMPLATE.columns,
          file_name_template: data.file_name_template ?? DEFAULT_TEMPLATE.file_name_template,
          sheet_name_template: data.sheet_name_template ?? DEFAULT_TEMPLATE.sheet_name_template,
          format: data.format ?? 'xlsx',
          include_subject: !!data.include_subject,
          subject_template: data.subject_template ?? DEFAULT_TEMPLATE.subject_template,
          use_body_template: !!data.use_body_template,
          body_template: data.body_template ?? '',
        }
        setTpl(loaded); setSavedTpl(loaded)
      })
    return () => { cancelled = true }
  }, [profile?.company_id, draft?.vendor_id])

  const included = useMemo(() => lines.filter((l) => l.included && Number(l.qty) > 0), [lines])
  const vendorName = vendors.byId(draft?.vendor_id ?? null)?.name ?? ''
  const dirty = savedTpl ? JSON.stringify(savedTpl) !== JSON.stringify(tpl) : true

  /** Values available to a source/composite column for one line. */
  const valuesFor = useCallback((l: DraftLineRow): Record<string, string | number> => {
    const orderType = l.order_type as OrderType
    return {
      po_number: poNumber(shopNumber(l.location_id), draft?.order_date ?? '', orderType),
      shop_number: shopNumber(l.location_id),
      shop_name: shopName(l.location_id),
      product_id: l.product_id,
      uom: l.uom ?? '',
      qty: Number(l.qty),
      unit_cost: Number(l.unit_cost ?? 0),
      line_total: Number(l.qty) * Number(l.unit_cost ?? 0),
      order_date: draft?.order_date ?? '',
      order_type: orderType,
      order_type_code: orderType === 'bulk' ? 'B' : 'P',
      vendor: vendorName,
    }
  }, [draft?.order_date, shopNumber, shopName, vendorName])

  const rows = useMemo(() => included.map((l) => {
    const v = valuesFor(l)
    return tpl.columns.map((c) => {
      switch (c.kind) {
        case 'source': return c.field ? v[c.field] ?? '' : ''
        case 'constant': return c.value ?? ''
        case 'composite': return renderTemplate(c.template ?? '', v, draft?.order_date)
        default: return ''
      }
    })
  }), [included, tpl.columns, valuesFor, draft?.order_date])

  const headerValues = useMemo(() => ({
    vendor: vendorName, order_date: draft?.order_date ?? '',
    shop_count: new Set(included.map((l) => l.location_id)).size,
    line_count: included.length,
    total: included.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0).toFixed(2),
  }), [vendorName, draft?.order_date, included])

  const fileName = renderTemplate(tpl.file_name_template, headerValues, draft?.order_date) || 'order'
  const sheetName = (renderTemplate(tpl.sheet_name_template, headerValues, draft?.order_date) || 'Order').slice(0, 31)
  const subject = renderTemplate(tpl.subject_template, headerValues, draft?.order_date)
  const body = renderTemplate(tpl.body_template, headerValues, draft?.order_date)

  function download() {
    if (!included.length) { toast.error('Nothing to export — every line is excluded or zero'); return }
    const headers = tpl.columns.map((c) => c.header)
    if (tpl.format === 'csv') {
      const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
      const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
      triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileName}.csv`)
    } else {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileName}.xlsx`)
    }
    toast.success('Export downloaded')
  }

  async function saveAsDefault() {
    if (!profile?.company_id || !draft?.vendor_id) { toast.error('Pick a vendor on the draft first'); return }
    const { error } = await sb().schema('inventory').from('ov2_export_templates').upsert({
      company_id: profile.company_id, vendor_id: draft.vendor_id, ...tpl,
      updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,vendor_id' })
    if (error) { toast.error(error.message); return }
    setSavedTpl(tpl)
    toast.success('Saved as this vendor\'s default')
  }

  async function finalize() {
    if (!profile?.company_id || !draft) return
    if (!included.length) { toast.error('Nothing to finalize'); return }
    if (!confirm('Finalize this order? It moves to Completed and is written to order history.')) return
    setFinalizing(true)
    const id = await finalizeDraft(profile.company_id, profile.id ?? null, draft, lines, shopNumber)
    setFinalizing(false)
    if (id) { toast.success('Order finalized'); navigate(`/orders-v2/history/${id}`) }
  }

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found.</p>

  const setCol = (id: string, patch: Partial<ExportColumn>) =>
    setTpl((t) => ({ ...t, columns: t.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  const move = (i: number, dir: -1 | 1) => setTpl((t) => {
    const next = [...t.columns]; const j = i + dir
    if (j < 0 || j >= next.length) return t
    ;[next[i], next[j]] = [next[j], next[i]]
    return { ...t, columns: next }
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate(`/orders-v2/draft/${draft.id}/final`)} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Final Review</button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Export</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendorName || 'No vendor'} · {included.length} line{included.length !== 1 ? 's' : ''} · {money(Number(headerValues.total))}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={saveAsDefault} disabled={!dirty}>
            {dirty ? 'Save as vendor default' : 'Matches saved default'}
          </Button>
          <Button size="sm" variant="secondary" onClick={download}>Download {tpl.format.toUpperCase()}</Button>
          <Button size="sm" loading={finalizing} onClick={finalize}>Finalize Order</Button>
        </div>
      </div>

      <p className="text-[11px] font-mono text-inky/60">
        Changes here apply to this export only. Press <strong>Save as vendor default</strong> to reuse them for this
        vendor next time.
      </p>

      {/* Column builder */}
      <Card><CardBody className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Columns ({tpl.columns.length})</span>
          <Button size="sm" variant="secondary"
            onClick={() => setTpl((t) => ({ ...t, columns: [...t.columns, { id: uid(), kind: 'source', header: 'New Column', field: 'product_id' }] }))}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Add column
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {tpl.columns.map((c, i) => (
            <div key={c.id} className="flex items-center gap-2 flex-wrap rounded border border-navy/20 px-2 py-1.5">
              <div className="flex flex-col text-inky/40">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="disabled:opacity-25 hover:text-navy leading-none">▲</button>
                <button onClick={() => move(i, 1)} disabled={i === tpl.columns.length - 1} className="disabled:opacity-25 hover:text-navy leading-none">▼</button>
              </div>
              <GripVertical className="w-3 h-3 text-inky/30" />
              <Input value={c.header} onChange={(e) => setCol(c.id, { header: e.target.value })} className="w-40" placeholder="Header" />
              <div className="w-32">
                <Select value={c.kind} onChange={(e) => setCol(c.id, { kind: e.target.value as ColumnKind })}
                  options={[{ value: 'source', label: 'Source' }, { value: 'constant', label: 'Constant' }, { value: 'blank', label: 'Blank' }, { value: 'composite', label: 'Composite' }]} />
              </div>
              {c.kind === 'source' && (
                <div className="w-44">
                  <Select value={c.field ?? ''} onChange={(e) => setCol(c.id, { field: e.target.value as ExportField })}
                    options={EXPORT_FIELDS.map((f) => ({ value: f, label: f }))} />
                </div>
              )}
              {c.kind === 'constant' && (
                <Input value={c.value ?? ''} onChange={(e) => setCol(c.id, { value: e.target.value })} className="w-48" placeholder="Fixed value" />
              )}
              {c.kind === 'composite' && (
                <Input value={c.template ?? ''} onChange={(e) => setCol(c.id, { template: e.target.value })} className="flex-1 min-w-[16rem]"
                  placeholder="{shop_number}-{date:MMDDYYYY}{order_type_code}" />
              )}
              <button onClick={() => setTpl((t) => ({ ...t, columns: t.columns.filter((x) => x.id !== c.id) }))}
                className="text-inky/40 hover:text-[#C0392B] ml-auto"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
        <p className="text-[10px] font-mono text-inky/50">
          Composite fields: {EXPORT_FIELDS.join(', ')} — plus <code>{'{date:MMDDYYYY}'}</code>.
        </p>
      </CardBody></Card>

      {/* Naming + email */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card><CardBody className="flex flex-col gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">File</span>
          <div className="w-40">
            <Select label="Format" value={tpl.format} onChange={(e) => setTpl((t) => ({ ...t, format: e.target.value as 'xlsx' | 'csv' }))}
              options={[{ value: 'xlsx', label: 'XLSX' }, { value: 'csv', label: 'CSV' }]} />
          </div>
          <Input label="File name" value={tpl.file_name_template} onChange={(e) => setTpl((t) => ({ ...t, file_name_template: e.target.value }))} />
          <span className="text-[10px] font-mono text-inky/50">→ {fileName}.{tpl.format}</span>
          {tpl.format === 'xlsx' && (
            <>
              <Input label="Sheet name" value={tpl.sheet_name_template} onChange={(e) => setTpl((t) => ({ ...t, sheet_name_template: e.target.value }))} />
              <span className="text-[10px] font-mono text-inky/50">→ {sheetName}</span>
            </>
          )}
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Email</span>
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={tpl.include_subject} onChange={(v) => setTpl((t) => ({ ...t, include_subject: v }))} size="sm" color="cyan" />
            Include subject line
          </label>
          {tpl.include_subject && (
            <>
              <Input label="Subject" value={tpl.subject_template} onChange={(e) => setTpl((t) => ({ ...t, subject_template: e.target.value }))} />
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-inky/50 flex-1 truncate">→ {subject}</span>
                <button onClick={() => { navigator.clipboard.writeText(subject); toast.success('Subject copied') }}
                  className="text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy">Copy</button>
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={tpl.use_body_template} onChange={(v) => setTpl((t) => ({ ...t, use_body_template: v }))} size="sm" color="cyan" />
            Use body template
          </label>
          {tpl.use_body_template && (
            <>
              <textarea value={tpl.body_template} onChange={(e) => setTpl((t) => ({ ...t, body_template: e.target.value }))} rows={4}
                className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky"
                placeholder="Attached is the {vendor} order for {date:MMDDYYYY} — {shop_count} shops, {line_count} lines, ${total}." />
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-inky/50 flex-1 whitespace-pre-wrap">→ {body}</span>
                <button onClick={() => { navigator.clipboard.writeText(body); toast.success('Body copied') }}
                  className="text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy shrink-0">Copy</button>
              </div>
            </>
          )}
          <span className="text-[10px] font-mono text-inky/50">
            Header fields: vendor, order_date, shop_count, line_count, total.
          </span>
        </CardBody></Card>
      </div>

      {/* Preview */}
      <Card><CardBody className="flex flex-col gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Preview (first 10 of {rows.length})</span>
        <div className="overflow-auto rounded border border-navy/20 max-h-72">
          <table className="text-[11px] font-mono">
            <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
              {tpl.columns.map((c) => <th key={c.id} className="text-left px-2 py-1 whitespace-nowrap">{c.header}</th>)}
            </tr></thead>
            <tbody>
              {rows.slice(0, 10).map((r, i) => (
                <tr key={i} className="border-b border-navy/10">
                  {r.map((cell, j) => <td key={j} className="px-2 py-1 text-navy whitespace-nowrap">{String(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody></Card>
    </div>
  )
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
