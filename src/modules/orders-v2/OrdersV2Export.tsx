import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Button, Card, CardBody, Input, SbLoader, Select, Toggle } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { usePageRevisit } from '@/hooks/usePageActive'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import { fireConfettiCannon } from '@/lib/confetti'
import toast from 'react-hot-toast'
import { useDraft, draftAdHocLocationIds, type DraftLineRow } from './useOrdersV2'
import { useVendors } from './useLookups'
import { OrderStepper } from './OrderStepper'
import { markDraftComplete } from './useOrderHistory'
import { poNumber, renderTemplate } from './engine'
import { money } from './shared'
import type { OrderType } from './types'

// Fields a source/composite column can reference.
export const EXPORT_FIELDS = [
  'po_number', 'shop_number', 'shop_name', 'product_id', 'product_base', 'vendor_part_number', 'vendor_description',
  'uom', 'uom_code', 'package_type', 'qty', 'unit_cost', 'line_total', 'order_date', 'order_type', 'order_type_code', 'vendor', 'weekday',
  'line_number', 'account_number',
] as const

// Available in file name/sheet name/subject/body templates — a DIFFERENT,
// smaller set than EXPORT_FIELDS above, since these describe the whole
// export (one value), not a per-line column. Must match headerValues'
// own keys below exactly — this is the literal source of truth the
// PlaceholderPicker/reference text lists render from, so it can never
// silently drift out of sync with what actually resolves.
const HEADER_FIELDS = ['vendor', 'order_date', 'weekday', 'shop_count', 'shop', 'product_count', 'product', 'line_count', 'total'] as const
// The 3 special date-arithmetic/formatting tokens renderTemplate itself
// understands, on top of a plain field name — shown ahead of the field
// list in the picker since they're the ones a user can't just guess from
// EXPORT_FIELDS/HEADER_FIELDS alone.
const DATE_TOKENS: { token: string; hint: string }[] = [
  { token: '{date:MMDDYYYY}', hint: "order date" },
  { token: '{today:MMDDYYYY}', hint: "today's date" },
  { token: '{date+1:MMDDYYYY}', hint: 'order date +1 day (any field:offset works, use - for earlier)' },
]

/**
 * Small "{ }" button next to a template field — opens a list of every
 * placeholder valid in THAT field (a composite column's own template only
 * ever sees EXPORT_FIELDS; file name/sheet name/subject/body only ever see
 * HEADER_FIELDS, a smaller per-export set) so nobody has to type one out
 * from memory or guess which set applies where. Clicking an entry inserts
 * it via the caller's own onInsert (see TemplateInput below for the actual
 * cursor-position-aware insert).
 */
function PlaceholderPicker({ fields, onInsert }: { fields: readonly string[]; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)}
        title="Insert a field"
        className="text-[10px] font-mono text-sky border border-sky/40 rounded px-1.5 py-0.5 hover:bg-sky/10 flex-shrink-0">
        {'{ }'} Insert field
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-72 max-h-72 overflow-auto rounded border border-navy/30 bg-cream shadow-xl p-1">
            {DATE_TOKENS.map((d) => (
              <button key={d.token} type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onInsert(d.token); setOpen(false) }}
                className="block w-full text-left px-2 py-1 text-[11px] font-mono text-navy hover:bg-sky/20 rounded">
                <code>{d.token}</code> <span className="text-inky/50">— {d.hint}</span>
              </button>
            ))}
            <div className="border-t border-navy/10 my-1" />
            {fields.map((f) => (
              <button key={f} type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onInsert(`{${f}}`); setOpen(false) }}
                className="block w-full text-left px-2 py-1 text-[11px] font-mono text-navy hover:bg-sky/20 rounded">
                <code>{`{${f}}`}</code>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A template text field (single-line or multiline) with a PlaceholderPicker
 * next to it — clicking a field inserts it at the cursor's last-known
 * position (tracked via onSelect/onClick/onKeyUp, since a picker button's
 * own mousedown would otherwise steal focus and lose the caret position
 * before its click handler ever runs — onMouseDown={preventDefault} above
 * on every picker button keeps focus in the field to begin with, and this
 * still tracks the position independently as a fallback). Falls back to
 * appending at the end if no position was ever recorded (field never
 * focused yet).
 */
function TemplateInput({ label, value, onChange, fields, multiline, placeholder, className }: {
  label?: string
  value: string
  onChange: (v: string) => void
  fields: readonly string[]
  multiline?: boolean
  placeholder?: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const posRef = useRef<number>(value.length)
  const trackPos = () => { if (ref.current) posRef.current = ref.current.selectionStart ?? value.length }
  function insert(token: string) {
    const pos = Math.min(posRef.current, value.length)
    const next = value.slice(0, pos) + token + value.slice(pos)
    onChange(next)
    const newPos = pos + token.length
    posRef.current = newPos
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(newPos, newPos) })
  }
  const fieldEl = multiline ? (
    <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)}
      onSelect={trackPos} onClick={trackPos} onKeyUp={trackPos} rows={4} placeholder={placeholder}
      className={`w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky ${className ?? ''}`} />
  ) : (
    <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)}
      onSelect={trackPos} onClick={trackPos} onKeyUp={trackPos} placeholder={placeholder} className={className} />
  )
  if (!label && !multiline) {
    // Dense inline contexts (the per-column composite template row) skip
    // the label row entirely and put the picker button right after the field.
    return (
      <div className="flex items-center gap-1 flex-1 min-w-[16rem]">
        {fieldEl}
        <PlaceholderPicker fields={fields} onInsert={insert} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        {label && <label className="text-xs font-heading text-inky uppercase tracking-wide">{label}</label>}
        <PlaceholderPicker fields={fields} onInsert={insert} />
      </div>
      {fieldEl}
    </div>
  )
}

// Portal-friendly UOM codes some vendor upload formats expect instead of
// this app's own internal uom values — Valvoline's own portal specifically
// wants "BX" for a bay box and "DR" for a drum. Case/bulk aren't currently
// asked for explicitly; given a reasonable abbreviation here rather than
// left blank, adjust if Valvoline's portal expects something else. Also
// backs the separate `package_type` export field below (2026-09-24 ask,
// worded against the real DB column name `vendor_parts`/`global_products`
// use for this concept, package_type — Orders v2 itself calls the same
// value `uom` internally) — deliberately its own EXPORT_FIELDS entry
// rather than changing what the existing `uom`/`uom_code` fields output,
// since a saved vendor template may already reference either of those and
// this is purely additive. Display elsewhere (Review, Final Review, config
// tabs) is untouched — those keep using UOM_LABELS ("Bay Box"/"Drum").
const UOM_CODES: Record<string, string> = { bay_box: 'BX', drum: 'DR', case: 'CS', bulk: 'BLK' }

// Strips a trailing packaging-variant suffix (e.g. "BB" bay box, "D" drum,
// "C" case — see product_id_mappings' own -D/-C/-BB convention) down to a
// product's bare base code, e.g. "VRP020BB" -> "VRP020". Some export
// formats want the product referenced by this base code in a free-text
// comment cell, not the full case/package-specific id.
const stripPackagingSuffix = (id: string) => id.replace(/[A-Za-z]+$/, '')

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Full weekday name for a draft — the order day the shops were pulled for
 * (settings_snapshot.__order_dow, set on generation and shown on the
 * landing page), not just the calendar weekday of order_date. Those
 * usually match, but can diverge when "Order day" was explicitly switched
 * to a different weekday's shops than the order date itself falls on.
 */
function orderWeekdayName(draft: { order_date: string; settings_snapshot: Record<string, unknown> } | null): string {
  if (!draft) return ''
  const dow = (draft.settings_snapshot as any)?.__order_dow
  const idx = typeof dow === 'number' ? dow : new Date(draft.order_date + 'T00:00:00').getDay()
  return idx >= 0 && idx < 7 ? WEEKDAYS[idx] : ''
}
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
  /** Split the export into multiple sequentially-numbered files once the
   * line count exceeds this many rows — Valvoline's own upload portal
   * rejects a file over 100 lines. null/0 = never split (default). */
  max_rows_per_file: number | null
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
  max_rows_per_file: null,
}

const sb = () => supabase as any
const uid = () => Math.random().toString(36).slice(2, 9)

function mapRowToTemplate(data: any): ExportTemplate {
  return {
    columns: Array.isArray(data.columns) && data.columns.length ? data.columns : DEFAULT_TEMPLATE.columns,
    file_name_template: data.file_name_template ?? DEFAULT_TEMPLATE.file_name_template,
    sheet_name_template: data.sheet_name_template ?? DEFAULT_TEMPLATE.sheet_name_template,
    format: data.format ?? 'xlsx',
    include_subject: !!data.include_subject,
    subject_template: data.subject_template ?? DEFAULT_TEMPLATE.subject_template,
    use_body_template: !!data.use_body_template,
    body_template: data.body_template ?? '',
    max_rows_per_file: data.max_rows_per_file ?? null,
  }
}

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
  // Company-wide, developer-controlled (see ProfilePanel.tsx's Dev
  // Settings section) — every user's own read of this same value, no
  // permission check needed here since only the write side is gated.
  const [confettiOnExport] = useAppSetting<boolean>('confetti_on_export', false)
  const [confettiSimple] = useAppSetting<boolean>('confetti_simple', false)
  const { draft, lines, loading, reload } = useDraft(draftId || null)
  // This page sits behind KeepAlivePages once visited more than once — going
  // back to Review/Final Review to change a line, then forward to an
  // already-cached Export, used to keep showing whatever the order looked
  // like on the FIRST visit here forever (nothing unmounted to re-trigger
  // useDraft's own load effect, and this page has no other refresh path).
  // usePageRevisit re-fetches the instant this becomes the visible page
  // again, so the export always reflects the order's current, real state.
  usePageRevisit(reload)

  const [tpl, setTpl] = useState<ExportTemplate>(DEFAULT_TEMPLATE)
  const [savedTpl, setSavedTpl] = useState<ExportTemplate | null>(null)
  // Ad Hoc orders get their own independently-customizable export format
  // (2026-09-28 ask), saved as a separate inventory.ov2_export_templates row
  // keyed by (company_id, vendor_id, is_adhoc) instead of overloading the
  // vendor's regular scheduled-order default. hasAdhocOverride tracks
  // whether one has actually been saved yet — until it has, the load effect
  // below falls back to showing the vendor's regular default so an ad hoc
  // export starts out identical rather than DEFAULT_TEMPLATE's generic shape.
  const isAdHoc = !!draftAdHocLocationIds(draft ?? {})
  const [hasAdhocOverride, setHasAdhocOverride] = useState(false)
  // Collapsed by default — the column mappings can run long, and the
  // preview below is what you actually came here to check.
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [vendorParts, setVendorParts] = useState<{ our_part_number: string | null; part_number: string | null; description: string | null }[]>([])
  const [productMappings, setProductMappings] = useState<{ old_product_id: string | null; new_product_id: string | null }[]>([])

  const shopNumber = useCallback((id: string | null) => {
    const label = loc.fieldValue(id, 'name') || loc.codeOf(id) || ''
    return (label.match(/\d+/)?.[0]) ?? label
  }, [loc])
  const shopName = useCallback((id: string | null) => loc.fieldValue(id, 'shop_city') || loc.codeOf(id) || '', [loc])

  // Load this vendor's saved template — the ad-hoc-specific one when this
  // draft is an ad hoc order, otherwise the regular one. Falls back to the
  // vendor's regular default when editing an ad hoc export that has no
  // ad-hoc-specific template saved yet, per the "initial load matches the
  // vendor default" ask — savedTpl stays null in that case (not the
  // fallback value) so `dirty` is true until the user explicitly saves an
  // ad-hoc-specific row, rather than falsely reading as "already saved."
  useEffect(() => {
    if (!profile?.company_id || !draft?.vendor_id) return
    let cancelled = false
    const companyId = profile.company_id
    const vendorId = draft.vendor_id
    ;(async () => {
      const { data } = await sb().schema('inventory').from('ov2_export_templates')
        .select('*').eq('company_id', companyId).eq('vendor_id', vendorId).eq('is_adhoc', isAdHoc).maybeSingle()
      if (cancelled) return
      if (data) {
        const loaded = mapRowToTemplate(data)
        setTpl(loaded); setSavedTpl(loaded); setHasAdhocOverride(true)
        return
      }
      setHasAdhocOverride(false)
      if (!isAdHoc) { setTpl(DEFAULT_TEMPLATE); setSavedTpl(null); return }
      const { data: vendorDefault } = await sb().schema('inventory').from('ov2_export_templates')
        .select('*').eq('company_id', companyId).eq('vendor_id', vendorId).eq('is_adhoc', false).maybeSingle()
      if (cancelled) return
      setTpl(vendorDefault ? mapRowToTemplate(vendorDefault) : DEFAULT_TEMPLATE)
      setSavedTpl(null)
    })()
    return () => { cancelled = true }
  }, [profile?.company_id, draft?.vendor_id, isAdHoc])

  // Vendor's own part number/description — matched vendor + our_part_number,
  // resolved through product_id_mappings the same way Orders v2 generation
  // resolves usage and package size (a line's product_id may be a canonical
  // id vendor_parts hasn't caught up to yet).
  useEffect(() => {
    if (!profile?.company_id || !draft?.vendor_id) return
    let cancelled = false
    Promise.all([
      sb().schema('inventory').from('vendor_parts').select('our_part_number, part_number, description')
        .eq('company_id', profile.company_id).eq('vendor_id', draft.vendor_id),
      sb().schema('inventory').from('product_id_mappings').select('old_product_id, new_product_id').eq('company_id', profile.company_id),
    ]).then(([vp, pm]: any[]) => {
      if (cancelled) return
      setVendorParts((vp.data ?? []) as any[])
      setProductMappings((pm.data ?? []) as any[])
    })
    return () => { cancelled = true }
  }, [profile?.company_id, draft?.vendor_id])

  const vendorPartFor = useMemo(() => {
    const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()
    const oldToNew = new Map(productMappings.filter((m) => m.old_product_id && m.new_product_id).map((m) => [pkey(m.old_product_id), String(m.new_product_id)]))
    const byPart = new Map(vendorParts.filter((p) => p.our_part_number).map((p) => [pkey(p.our_part_number), p]))
    return (productId: string) => byPart.get(pkey(oldToNew.get(pkey(productId)) ?? productId))
  }, [vendorParts, productMappings])

  // Shop-grouped, numeric order — matches Review/Final Review/History, so
  // the exported file reads the same way the shop reviewed it as.
  const included = useMemo(() => [...lines].filter((l) => l.included && Number(l.qty) > 0)
    .sort((a, b) => shopNumber(a.location_id).localeCompare(shopNumber(b.location_id), undefined, { numeric: true })
      || a.product_id.localeCompare(b.product_id)),
  [lines, shopNumber])
  // Some vendor portals (Valvoline) want a per-shop line index — 1, 2, 3…
  // resetting for each new shop — rather than a running count across the
  // whole file. `included` is already this same shop-grouped order, so a
  // single pass over it is enough.
  const lineNumberByLineId = useMemo(() => {
    const counts = new Map<string, number>()
    const result = new Map<string, number>()
    for (const l of included) {
      const n = (counts.get(l.location_id) ?? 0) + 1
      counts.set(l.location_id, n)
      result.set(l.id, n)
    }
    return result
  }, [included])
  const vendorName = vendors.byId(draft?.vendor_id ?? null)?.name ?? ''
  const dirty = savedTpl ? JSON.stringify(savedTpl) !== JSON.stringify(tpl) : true

  /** Values available to a source/composite column for one line. */
  const valuesFor = useCallback((l: DraftLineRow): Record<string, string | number> => {
    const orderType = l.order_type as OrderType
    const vp = vendorPartFor(l.product_id)
    return {
      po_number: poNumber(shopNumber(l.location_id), draft?.order_date ?? '', orderType),
      shop_number: shopNumber(l.location_id),
      shop_name: shopName(l.location_id),
      product_id: l.product_id,
      product_base: stripPackagingSuffix(l.product_id),
      vendor_part_number: vp?.part_number ?? '',
      vendor_description: vp?.description ?? '',
      uom: l.uom ?? '',
      uom_code: UOM_CODES[(l.uom ?? '').toLowerCase()] ?? (l.uom ?? '').toUpperCase(),
      package_type: UOM_CODES[(l.uom ?? '').toLowerCase()] ?? (l.uom ?? '').toUpperCase(),
      qty: Number(l.qty),
      unit_cost: Number(l.unit_cost ?? 0),
      line_total: Number(l.qty) * Number(l.unit_cost ?? 0),
      order_date: draft?.order_date ?? '',
      order_type: orderType,
      order_type_code: orderType === 'bulk' ? 'B' : 'P',
      vendor: vendorName,
      weekday: orderWeekdayName(draft),
      line_number: lineNumberByLineId.get(l.id) ?? 1,
      // Only one such account-number column exists on core.locations today
      // (valvoline_account_num) — named generically here in case another
      // vendor's own account-number field is added later.
      account_number: loc.fieldValue(l.location_id, 'valvoline_account_num') || '',
    }
  }, [draft, shopNumber, shopName, vendorName, vendorPartFor, lineNumberByLineId, loc])

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

  // shop/product (2026-09-28 ask, for filenames): the single shop name or
  // product id when the export covers exactly one, otherwise a count —
  // there's no single name that reads sensibly in a filename once an export
  // spans more than one shop or product line.
  const headerValues = useMemo(() => {
    const shopIds = new Set(included.map((l) => l.location_id))
    const productIds = new Set(included.map((l) => l.product_id))
    return {
      vendor: vendorName, order_date: draft?.order_date ?? '', weekday: orderWeekdayName(draft),
      shop_count: shopIds.size,
      product_count: productIds.size,
      line_count: included.length,
      total: included.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0).toFixed(2),
      shop: shopIds.size === 1 ? shopName([...shopIds][0]) : `${shopIds.size} shops`,
      product: productIds.size === 1 ? [...productIds][0] : `${productIds.size} products`,
    }
  }, [vendorName, draft, included, shopName])

  const fileName = renderTemplate(tpl.file_name_template, headerValues, draft?.order_date) || 'order'
  const sheetName = (renderTemplate(tpl.sheet_name_template, headerValues, draft?.order_date) || 'Order').slice(0, 31)
  const fileCount = tpl.max_rows_per_file && tpl.max_rows_per_file > 0 ? Math.ceil(rows.length / tpl.max_rows_per_file) : 1
  const subject = renderTemplate(tpl.subject_template, headerValues, draft?.order_date)
  const body = renderTemplate(tpl.body_template, headerValues, draft?.order_date)

  function download() {
    if (!included.length) { toast.error('Nothing to export — every line is excluded or zero'); return }
    // Some vendor upload portals (Valvoline) reject a file over a fixed
    // line count — split into sequentially-numbered files instead of one.
    // A single file (the common case) keeps its plain, unsuffixed name so
    // this is a no-op for every template that doesn't set it.
    const maxRows = tpl.max_rows_per_file && tpl.max_rows_per_file > 0 ? tpl.max_rows_per_file : null
    const chunks = maxRows
      ? Array.from({ length: Math.ceil(rows.length / maxRows) }, (_, i) => rows.slice(i * maxRows, (i + 1) * maxRows))
      : [rows]
    // A row on its own has no way to say which of the N files it landed in
    // once a template's own row limit actually splits the export — append a
    // trailing "File #" column carrying the chunk's 1-based file number in
    // that case. A no-op (no extra column at all) when the export stays one
    // file, which is the common case and shouldn't gain a pointless column.
    const splitting = chunks.length > 1
    const headers = splitting ? [...tpl.columns.map((c) => c.header), 'File #'] : tpl.columns.map((c) => c.header)

    chunks.forEach((chunkRows, i) => {
      const suffix = splitting ? `-${i + 1}` : ''
      const outRows = splitting ? chunkRows.map((r) => [...r, i + 1]) : chunkRows
      if (tpl.format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...outRows].map((r) => r.map(esc).join(',')).join('\n')
        // Staggered so the browser doesn't treat several downloads fired
        // synchronously from one click as a batch to block/prompt about.
        setTimeout(() => triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileName}${suffix}.csv`), i * 150)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...outRows])
        XLSX.utils.book_append_sheet(wb, ws, sheetName)
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        setTimeout(() => triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileName}${suffix}.xlsx`), i * 150)
      }
    })
    toast.success(chunks.length > 1 ? `${chunks.length} files downloaded` : 'Export downloaded')
    void completeOnExport()
  }

  // Direct ask 2026-09-29: kill the separate "Finalize Order" step —
  // downloading the file IS what completes the order now, no extra click,
  // no confirmation dialog, and no navigating away from this page into a
  // locked read-only view. The draft stays exactly as editable as it always
  // was; markDraftComplete just upserts the ov2_order_history record
  // (needed for RD reconciliation/Valvoline auto-feed/reporting — see that
  // function's own header comment) and flips the draft's status to
  // 'exported', which statusRoute already treats as "reopen on Export,"
  // same as any other status. Re-downloading after further edits just
  // refreshes that record — never creates a second "completed" copy.
  async function completeOnExport() {
    if (!profile?.company_id || !draft || !included.length) return
    setCompleting(true)
    await markDraftComplete(profile.company_id, profile.id ?? null, draft, lines, shopNumber, vendorName)
    setCompleting(false)
  }

  async function saveTemplate() {
    if (!profile?.company_id || !draft?.vendor_id) { toast.error('Pick a vendor on the draft first'); return }
    const { error } = await sb().schema('inventory').from('ov2_export_templates').upsert({
      company_id: profile.company_id, vendor_id: draft.vendor_id, is_adhoc: isAdHoc, ...tpl,
      updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,vendor_id,is_adhoc' })
    if (error) { toast.error(error.message); return }
    setSavedTpl(tpl)
    setHasAdhocOverride(true)
    toast.success(isAdHoc ? 'Saved as this vendor\'s ad hoc default' : 'Saved as this vendor\'s default')
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
      {/* Direct ask 2026-09-30: nav row above the step bar (matching
          Review's own order), both pinned at the top of the page
          regardless of scroll position — see OrdersV2Review.tsx's own
          identical wrapper for the full reasoning. "← Orders v2" reaches
          the landing page directly from here too, not just "← Final Review". */}
      <div className="sticky top-0 z-20 -mt-4 pt-4 -mx-4 px-4 pb-2 bg-cream dark:bg-[#0A1826] flex flex-col gap-3">
      {/* Direct ask 2026-09-30 (revised): back button shares a row with
          the primary actions, and the stepper sits directly below with
          nothing between — matching Review's own sticky block. Title/
          subtext moved back OUT of the sticky block entirely, further
          down the page, matching where Review's own title sits. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button size="sm" variant="ghost" onClick={() => navigate('/orders-v2')}
          className="rounded-lg border border-sky/50 text-sky hover:bg-sky/10 hover:text-sky">← Orders v2</Button>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="ghost" onClick={() => navigate(`/orders-v2/draft/${draft.id}/final`)}
            className="rounded-lg border border-sky/50 text-sky hover:bg-sky/10 hover:text-sky">← Final Review</Button>
          <Button size="sm" variant="secondary" onClick={saveTemplate} disabled={!dirty}>
            {dirty ? (isAdHoc ? 'Save as ad hoc default' : 'Save as vendor default') : 'Matches saved default'}
          </Button>
          <Button size="sm" loading={completing} onClick={(e) => {
            // Direct ask 2026-09-30: "like a confetti cannon went off from
            // the tip of the cursor" — the click event's own coordinates,
            // not the button's center, so it genuinely originates from
            // wherever the user actually clicked.
            if (confettiOnExport) fireConfettiCannon(e.clientX, e.clientY, { simple: confettiSimple })
            download()
          }}>
            {draft.status === 'exported' ? `Re-download ${tpl.format.toUpperCase()}` : `Download ${tpl.format.toUpperCase()}`}
          </Button>
        </div>
      </div>
      <OrderStepper draftId={draft.id} current="export" />
      </div>

      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase flex items-center gap-2">
          Export
          {isAdHoc && <span className="text-[10px] font-mono normal-case tracking-normal rounded px-1.5 py-0.5 bg-sky/40 text-navy">Ad Hoc</span>}
          {draft.status === 'exported' && (
            <span className="text-[10px] font-mono normal-case tracking-normal rounded px-1.5 py-0.5 bg-[#2ECC71]/15 text-[#2ECC71] border border-[#2ECC71]/40">
              ✓ Complete
            </span>
          )}
        </h1>
        <p className="text-xs text-inky mt-0.5">
          {vendorName || 'No vendor'} · {included.length} line{included.length !== 1 ? 's' : ''} · {money(Number(headerValues.total))}
        </p>
      </div>

      {isAdHoc && !hasAdhocOverride && (
        <p className="text-[11px] font-mono text-inky/60 bg-sky/10 border border-sky/40 rounded px-2 py-1.5">
          No ad-hoc-specific export format saved yet for {vendorName || 'this vendor'} — currently showing its
          regular default. Customize below and press <strong>Save as ad hoc default</strong> to reuse this format for {vendorName || 'this vendor'}'s ad hoc orders going forward.
        </p>
      )}
      <p className="text-[11px] font-mono text-inky/60">
        Changes here apply to this export only. Press <strong>{isAdHoc ? 'Save as ad hoc default' : 'Save as vendor default'}</strong> to
        reuse them for {isAdHoc ? "this vendor's ad hoc orders" : 'this vendor'} next time.
      </p>

      {/* Column builder — collapsed by default so the preview below is
          visible without scrolling past every column's mapping first.
          data-confetti-floor: this card's own top border is the closest
          real "landing surface" below the step bar on this page (direct
          ask 2026-09-30 — the Preview table further down was too far to
          ever actually get hit first). */}
      <div data-confetti-floor>
      <Card><CardBody className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <button onClick={() => setColumnsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-inky/60 hover:text-navy transition-colors">
            <span className={`inline-block text-[9px] transition-transform ${columnsOpen ? 'rotate-90' : ''}`}>▸</span>
            Columns ({tpl.columns.length})
          </button>
          <Button size="sm" variant="secondary"
            onClick={() => { setColumnsOpen(true); setTpl((t) => ({ ...t, columns: [...t.columns, { id: uid(), kind: 'source', header: 'New Column', field: 'product_id' }] })) }}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Add column
          </Button>
        </div>
        {columnsOpen && (<>
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
                <TemplateInput value={c.template ?? ''} onChange={(v) => setCol(c.id, { template: v })} fields={EXPORT_FIELDS}
                  placeholder="{shop_number}-{date:MMDDYYYY}{order_type_code}" />
              )}
              <button onClick={() => setTpl((t) => ({ ...t, columns: t.columns.filter((x) => x.id !== c.id) }))}
                className="text-inky/40 hover:text-[#C0392B] ml-auto"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
        <div className="text-[10px] font-mono text-inky/50 flex flex-col gap-0.5">
          <p>Composite fields: {EXPORT_FIELDS.join(', ')}</p>
          <p>
            <code>{'{date:MMDDYYYY}'}</code> order date · <code>{'{today:MMDDYYYY}'}</code> today's date ·{' '}
            <code>{'{date+4:MMDDYYYY}'}</code> order date +4 days (use <code>-</code> for earlier) ·{' '}
            <code>{'{shop_number:00000}'}</code> zero-padded to 5 digits (works on any field, e.g. <code>{'S{shop_number:00000}'}</code> → S00013) ·{' '}
            <code>{'{weekday}'}</code> full weekday name of the order day (e.g. Monday)
          </p>
        </div>
        </>
        )}
      </CardBody></Card>
      </div>

      {/* Naming + email */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card><CardBody className="flex flex-col gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">File</span>
          <div className="w-40">
            <Select label="Format" value={tpl.format} onChange={(e) => setTpl((t) => ({ ...t, format: e.target.value as 'xlsx' | 'csv' }))}
              options={[{ value: 'xlsx', label: 'XLSX' }, { value: 'csv', label: 'CSV' }]} />
          </div>
          <TemplateInput label="File name" value={tpl.file_name_template} onChange={(v) => setTpl((t) => ({ ...t, file_name_template: v }))} fields={HEADER_FIELDS} />
          <span className="text-[10px] font-mono text-inky/50">→ {fileName}.{tpl.format}</span>
          <p className="text-[10px] font-mono text-inky/50">
            <code>{'{shop}'}</code> shop name, or "N shops" once more than one is included ·{' '}
            <code>{'{product}'}</code> product id, or "N products" once more than one is included
          </p>
          {tpl.format === 'xlsx' && (
            <>
              <TemplateInput label="Sheet name" value={tpl.sheet_name_template} onChange={(v) => setTpl((t) => ({ ...t, sheet_name_template: v }))} fields={HEADER_FIELDS} />
              <span className="text-[10px] font-mono text-inky/50">→ {sheetName}</span>
            </>
          )}
          <Input
            label="Max rows per file (blank = no limit)"
            type="number"
            min={0}
            value={tpl.max_rows_per_file ?? ''}
            onChange={(e) => setTpl((t) => ({ ...t, max_rows_per_file: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }))}
            className="w-56"
            placeholder="e.g. 100 for Valvoline's portal"
          />
          <span className="text-[10px] font-mono text-inky/50">
            {fileCount > 1
              ? `→ ${fileCount} files (${fileName}-1.${tpl.format} … ${fileName}-${fileCount}.${tpl.format}), each with a trailing "File #" column`
              : 'Exports as a single file at the current line count'}
          </span>
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Email</span>
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={tpl.include_subject} onChange={(v) => setTpl((t) => ({ ...t, include_subject: v }))} size="sm" color="cyan" />
            Include subject line
          </label>
          {tpl.include_subject && (
            <>
              <TemplateInput label="Subject" value={tpl.subject_template} onChange={(v) => setTpl((t) => ({ ...t, subject_template: v }))} fields={HEADER_FIELDS} />
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
              <TemplateInput value={tpl.body_template} onChange={(v) => setTpl((t) => ({ ...t, body_template: v }))} fields={HEADER_FIELDS} multiline
                placeholder="Attached is the {vendor} order for {date:MMDDYYYY} — {shop_count} shops, {line_count} lines, ${total}." />
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-inky/50 flex-1 whitespace-pre-wrap">→ {body}</span>
                <button onClick={() => { navigator.clipboard.writeText(body); toast.success('Body copied') }}
                  className="text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy shrink-0">Copy</button>
              </div>
            </>
          )}
          <span className="text-[10px] font-mono text-inky/50">
            Header fields: vendor, order_date, weekday, shop_count, shop, product_count, product, line_count, total.
          </span>
        </CardBody></Card>
      </div>

      {/* Preview */}
      <Card><CardBody className="flex flex-col gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Preview (first 10 of {rows.length})</span>
        <div className="overflow-auto rounded border border-navy/20 max-h-72">
          <table className="text-[11px] font-mono">
            {/* data-confetti-floor: a real surface for the confetti burst
                (see src/lib/confetti.ts) to land on/rest against — direct
                ask 2026-09-30, "rest on top of the columns border". */}
            <thead><tr data-confetti-floor className="bg-cream text-inky uppercase border-b border-navy/20">
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
