import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useOrderStore } from '@/stores/orderStore'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Select, Toggle, Badge, Card, CardHeader, CardBody } from '@/components/ui'
import { OrderDocuments } from './OrderDocuments'
import {
  generateOrder, applyMinOrderRules, buildExport, DEFAULT_EXPORT_COLUMNS,
  buildPendingIndex, autoPendingColMap, detectPrefixSuffixPatterns,
  TRIGGER_REASON_LABELS, type InventoryRow, type OrderConfigData, type UomConfig, type PrefixSuffixRule, type GeneratedLineItem,
} from '@/lib/orderEngine'
import { CONSTANT_SOURCE } from '@/types'
import type {
  Location, LocationOrderConfig, ProductIdMapping, GlobalProduct, VendorPart, OrderMinRule,
  UomMapping, ParsedUpload, ColumnMapping,
} from '@/types'
import toast from 'react-hot-toast'

type Stage = 'start' | 'map' | 'params' | 'review' | 'export'
type Source = 'manual' | 'file' | 'live'
export type OrderMode = 'config' | 'manual' | 'independent'

const MAP_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product', label: 'Product', required: true },
  { name: 'on_hand', label: 'On Hand' },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'leadtime', label: 'Lead Time (days)' },
  { name: 'category', label: 'Category' },
  { name: 'cost', label: 'Cost' },
  { name: 'min_on_hand', label: 'Min On Hand' },
  { name: 'max_on_hand', label: 'Max On Hand' },
  { name: 'uom', label: 'Unit of Measure' },
]
const NUMERIC_FIELDS = ['on_hand', 'daily_usage', 'leadtime', 'cost', 'min_on_hand', 'max_on_hand']

type PendingIndex = Map<string, number>

function toNum(raw: string): number | string {
  const t = raw.trim()
  if (t === '') return ''
  const n = parseFloat(t.replace(/[$,]/g, ''))
  return isNaN(n) ? '' : n
}

export function NewOrderTab({ mode = 'config' }: { mode?: OrderMode }) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const store = useOrderStore()

  const [stage, setStage] = useState<Stage>('start')
  const [source, setSource] = useState<Source>(mode === 'manual' ? 'manual' : 'file')
  const [config, setConfig] = useState<OrderConfigData | null>(null)
  const [uomConfig, setUomConfig] = useState<UomConfig | null>(null)
  const [minRules, setMinRules] = useState<OrderMinRule[]>([])
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)

  const [pending, setPending] = useState<PendingIndex | null>(null)
  const [pendingCount, setPendingCount] = useState(0)

  const [packRules, setPackRules] = useState<PrefixSuffixRule[]>([])

  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [excludeZeros, setExcludeZeros] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadConfig = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const [loc, cfg, pm, gp, vp, mr, um] = await Promise.all([
      sb.schema('core').from('locations').select('*').eq('company_id', companyId),
      sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('active', true),
      sb.schema('inventory').from('product_id_mappings').select('*').eq('company_id', companyId),
      sb.schema('core').from('global_products').select('*').eq('company_id', companyId),
      sb.schema('core').from('vendor_parts').select('*').eq('company_id', companyId),
      sb.schema('inventory').from('order_min_rules').select('*').eq('company_id', companyId).eq('active', true),
      sb.schema('core').from('uom_mappings').select('*').eq('company_id', companyId),
    ])
    const globalProducts = (gp.data ?? []) as GlobalProduct[]
    setConfig({
      locations: (loc.data ?? []) as Location[],
      locationConfigs: (cfg.data ?? []) as LocationOrderConfig[],
      productMappings: (pm.data ?? []) as ProductIdMapping[],
      globalProducts,
      vendorParts: (vp.data ?? []) as VendorPart[],
    })
    const uomMappings = ((um.data ?? []) as UomMapping[]).map((u) => ({ fromUnit: u.from_unit, toUnit: u.to_unit, factor: Number(u.factor) }))
    const productRules = globalProducts
      .filter((p) => p.order_uom)
      .map((p) => ({ productId: p.product_id, onHandUom: p.unit_of_measure ?? undefined, orderUom: p.order_uom ?? undefined }))
    setUomConfig(uomMappings.length || productRules.length ? { uomMappings, productRules } : null)
    const rules = (mr.data ?? []) as OrderMinRule[]
    setMinRules(rules)
    if (store.selectedMinRuleIds.length === 0) store.setSelectedMinRuleIds(rules.map((r) => r.id))
  }, [companyId])

  useEffect(() => { loadConfig() }, [loadConfig])

  useEffect(() => {
    if (mode === 'independent') store.setParams({ orderMode: 'days_supply' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  function rowsFromFile(mappings: ColumnMapping[]): InventoryRow[] {
    if (!parsed) return []
    store.setMapping(mappings)
    return parsed.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      for (const m of mappings) {
        // CONSTANT_SOURCE: use the literal constant value, not a column lookup
        const raw = m.sourceColumn === CONSTANT_SOURCE ? (m.constant ?? '') : (row[m.sourceColumn] ?? '')
        if (NUMERIC_FIELDS.includes(m.fieldName)) {
          const v = toNum(String(raw))
          obj[m.fieldName] = typeof v === 'number' && m.invert ? -v : v
        } else obj[m.fieldName] = raw
      }
      return obj as unknown as InventoryRow
    }).filter((r) => String(r.product ?? '').trim())
  }

  function generate() {
    if (!config) { toast.error('Config not loaded'); return }
    const rows = store.inputRows
    if (!rows.length) { toast.error('No inventory rows to generate from'); return }
    const uom: UomConfig | null = packRules.length
      ? { ...(uomConfig ?? {}), prefixSuffixRules: packRules }
      : uomConfig
    const gen = generateOrder(rows, config, { ...store.params, pending, uom })
    const selected = minRules.filter((r) => store.selectedMinRuleIds.includes(r.id))
    const withRules = applyMinOrderRules(gen, selected)
    store.setLineItems(withRules)
    setStage('review')
    toast.success(`Generated ${withRules.length} order lines`)
  }

  async function exportAndSave() {
    if (!companyId) return
    setSaving(true)
    const { headers, rows } = buildExport(store.lineItems as unknown as Array<Record<string, unknown>>, DEFAULT_EXPORT_COLUMNS, { excludeZeros })
    const baseName = store.sessionName.trim() || `order_${new Date().toISOString().slice(0, 10)}`

    if (format === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Order')
      XLSX.writeFile(wb, `${baseName}.xlsx`)
    } else {
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
      const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
      const a = document.createElement('a'); a.href = url; a.download = `${baseName}.csv`; a.click(); URL.revokeObjectURL(url)
    }

    const sb = supabase as any
    const { data: sess, error: sErr } = await sb.schema('inventory').from('order_sessions').insert({
      company_id: companyId,
      created_by: profile?.id ?? null,
      name: baseName,
      status: 'exported',
      source_mode: source,
      generation_params: { ...store.params, _updated_by_name: profile?.full_name ?? 'Someone' },
      input_snapshot: store.inputRows.slice(0, 2000),
      export_data: { headers, rows },
      exported_at: new Date().toISOString(),
    }).select().single()
    if (sErr) { setSaving(false); toast.error(sErr.message); return }

    const lineRows = store.lineItems.map((li) => ({
      order_session_id: sess.id,
      company_id: companyId,
      location_id: li.location_id,
      product_id: li.product_id,
      vendor_part_number: li.vendor_part_number,
      suggested_qty: li.suggested_qty,
      final_qty: li.final_qty,
      quantity: li.final_qty,
      unit_of_measure: li.unit_of_measure,
      package_type: li.package_type,
      applied_min_rule: li.applied_min_rule,
      trigger_reason: li.trigger_reason,
      manual_override: li.final_qty !== li.suggested_qty,
    }))
    const { error: lErr } = await sb.schema('inventory').from('order_line_items').insert(lineRows)
    setSaving(false)
    if (lErr) { toast.error(lErr.message); return }

    store.setSessionId(sess.id)
    toast.success(`Order "${baseName}" exported & saved`)
  }

  function startOver() {
    store.reset(); setParsed(null); setStage('start'); setPending(null); setPendingCount(0); setPackRules([])
    setSource(mode === 'manual' ? 'manual' : 'file')
  }

  function applyPendingFile(p: ParsedUpload, mapping: { location: string; product: string; qty: string }) {
    const rows = p.rows.map((r) => ({
      location: r[mapping.location] ?? '',
      product: r[mapping.product] ?? '',
      qty: r[mapping.qty] ?? '',
    })).filter((r) => String(r.product).trim())
    const idx = buildPendingIndex(rows)
    setPending(idx)
    setPendingCount(idx.size)
    toast.success(`Pending orders loaded — ${idx.size} product/location lines`)
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <StageBar stage={stage} mode={mode} />

      {/* ── 1 · Source ── */}
      {stage === 'start' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <span className="text-xs font-mono text-inky uppercase tracking-wide">
                {mode === 'manual' ? 'Manual Order Entry' : mode === 'independent' ? 'Upload Inventory (standalone)' : 'Inventory Source'}
              </span>
              {mode === 'config' && (
                <div className="flex rounded border border-navy/30 overflow-hidden">
                  {(['file', 'live'] as Source[]).map((s) => (
                    <button key={s} onClick={() => { setSource(s); setParsed(null) }}
                      className={['px-3 py-1 text-xs font-mono capitalize', source === s ? 'bg-sky/10 text-inky' : 'text-inky hover:text-navy'].join(' ')}>
                      {s === 'live' ? 'Live Source' : s}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              {mode === 'independent' && (
                <p className="text-xs font-mono text-inky">Standalone generator — works from just the uploaded file. The InventoryOS config (order configs, vendor parts, UoM) is used when present but isn&apos;t required.</p>
              )}

              {mode === 'manual' ? (
                <ManualEntry
                  locations={config?.locations ?? []}
                  onConfirm={(lines) => { store.setLineItems(lines); store.setSourceMode('manual'); setStage('review') }}
                />
              ) : source === 'live' ? (
                <DataSourceLinker configType="orders" />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-2">
                    <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Expected columns in your file</p>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                      {MAP_FIELDS.map((f) => (
                        <div key={f.name} className="flex items-center gap-1.5 min-w-0">
                          <span className={['text-[10px] font-mono flex-shrink-0 rounded px-1 py-0.5 leading-tight', f.required === true ? 'bg-navy/20 text-navy' : 'bg-inky/10 text-inky/50'].join(' ')}>
                            {f.required === true ? 'REQ' : 'OPT'}
                          </span>
                          <span className="text-xs font-mono text-navy truncate">{f.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <FileUploadZone onParsed={(r) => { setParsed(r); setStage('map') }} />
                </div>
              )}
            </CardBody>
          </Card>

          <Card><CardBody><OrderDocuments companyId={companyId} sessionId={null} stage="start" uploadedBy={profile?.id ?? null} /></CardBody></Card>
        </div>
      )}

      {/* ── 2 · Map ── */}
      {stage === 'map' && parsed && (
        <div className="flex flex-col gap-3">
          <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest mb-2">
              File Preview — {Math.min(5, parsed.rows.length)} of {parsed.rows.length} rows
            </p>
            <div className="overflow-auto rounded border border-navy/30 max-h-36">
              <table className="text-[11px] font-mono">
                <thead className="bg-navy text-inky sticky top-0">
                  <tr>{parsed.headers.map((h) => <th key={h} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-white/[0.02]' : ''}>
                      {parsed.headers.map((h) => <td key={h} className="px-2 py-1 whitespace-nowrap text-navy">{r[h] ?? ''}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <ColumnMapper
            headers={parsed.headers}
            requiredFields={MAP_FIELDS}
            rememberKey="orders.inventory"
            previewRows={parsed.rows.slice(0, 5)}
            initialMappings={store.mapping.length ? store.mapping : undefined}
            onConfirm={(m) => { store.setInputRows(rowsFromFile(m)); setStage('params'); toast.success(`Loaded ${parsed.rows.length} rows`) }}
            onCancel={() => { setParsed(null); setStage('start') }}
          />
        </div>
      )}

      {/* ── 3 · Params ── */}
      {stage === 'params' && (
        <ParamsStage
          minRules={minRules}
          pendingCount={pendingCount}
          onPendingFile={applyPendingFile}
          onClearPending={() => { setPending(null); setPendingCount(0) }}
          productIds={store.inputRows.map((r) => String(r.product ?? ''))}
          onPackRulesChange={setPackRules}
          onBack={() => setStage(source === 'file' ? 'map' : 'start')}
          onGenerate={generate}
        />
      )}

      {/* ── 4 · Review ── */}
      {stage === 'review' && (
        <ReviewStage onBack={() => setStage(mode === 'manual' ? 'start' : 'params')} onContinue={() => setStage('export')} />
      )}

      {/* ── 5 · Export ── */}
      {stage === 'export' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><span className="text-xs font-mono text-inky uppercase tracking-wide">Export</span></CardHeader>
            <CardBody className="flex flex-col gap-3">
              <Input label="Order Name" value={store.sessionName} onChange={(e) => store.setSessionName(e.target.value)} placeholder="e.g. Week 24 reorder" />
              <div className="flex items-end gap-4 flex-wrap">
                <div className="w-40"><Select label="Format" options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }]} value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx')} /></div>
                <div className="flex items-center gap-2 pb-2"><Toggle checked={excludeZeros} onChange={setExcludeZeros} size="sm" color="cyan" /><span className="text-xs font-mono text-inky">Exclude zero-qty lines</span></div>
                <span className="text-xs font-mono text-inky pb-2">
                  {store.lineItems.filter((l) => !excludeZeros || l.final_qty > 0).length} rows will export
                </span>
              </div>
            </CardBody>
          </Card>

          <Card><CardBody><OrderDocuments companyId={companyId} sessionId={store.sessionId} stage="export" uploadedBy={profile?.id ?? null} /></CardBody></Card>

          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStage('review')}>← Back</Button>
            <div className="flex gap-2">
              {store.sessionId && <Button variant="secondary" onClick={startOver}>Start New Order</Button>}
              <Button loading={saving} onClick={exportAndSave}>⬇ Export &amp; Save</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
function StageBar({ stage, mode }: { stage: Stage; mode: OrderMode }) {
  const steps: { key: Stage; label: string }[] = mode === 'manual'
    ? [{ key: 'start', label: '1 · Entry' }, { key: 'review', label: '2 · Order' }, { key: 'export', label: '3 · Export' }]
    : [
        { key: 'start', label: '1 · Source' },
        { key: 'map', label: '2 · Map' },
        { key: 'params', label: '3 · Params' },
        { key: 'review', label: '4 · Review' },
        { key: 'export', label: '5 · Export' },
      ]
  const idx = steps.findIndex((s) => s.key === stage)
  return (
    <div className="flex gap-2 flex-wrap">
      {steps.map((s, i) => (
        <span key={s.key} className={[
          'px-3 py-1 text-xs font-mono rounded border',
          i === idx ? 'border-sky text-inky bg-sky/10'
            : i < idx ? 'border-green-500/30 text-green-700' : 'border-navy/30 text-inky/70',
        ].join(' ')}>{s.label}</span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
interface MRow { location: string; product: string; amount: string }
const cellCls = 'w-full bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky'

function MultiLocPicker({ locations, selected, onChange }: {
  locations: Location[]
  selected: Location[]
  onChange: (locs: Location[]) => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const filtered = locations.filter((l) =>
    !search || l.location_code.toLowerCase().includes(search.toLowerCase()) || l.name.toLowerCase().includes(search.toLowerCase())
  )
  function toggle(loc: Location) {
    const already = selected.some((s) => s.id === loc.id)
    onChange(already ? selected.filter((s) => s.id !== loc.id) : [...selected, loc])
  }
  function selectAll() { onChange(filtered) }
  function clearAll() { onChange([]) }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase text-inky">
        Locations {selected.length > 0 ? <span className="text-navy">({selected.length} selected)</span> : ''}
      </span>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {selected.map((l) => (
            <span key={l.id} className="flex items-center gap-1 px-1.5 py-0.5 bg-navy/10 border border-navy/30 rounded text-[10px] font-mono text-navy">
              {l.location_code}
              <button onClick={() => toggle(l)} className="hover:text-red-400 leading-none">×</button>
            </span>
          ))}
          <button onClick={clearAll} className="text-[10px] font-mono text-inky/50 hover:text-red-400 px-1">Clear all</button>
        </div>
      )}
      <div className="relative">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? 'Search locations…' : 'Add more…'}
          className={cellCls}
        />
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute z-50 top-full mt-1 left-0 right-0 max-h-52 overflow-y-auto bg-cream border border-navy/30 rounded shadow-xl">
              <div className="flex gap-2 px-2 py-1.5 border-b border-navy/10">
                <button onClick={selectAll} className="text-[10px] font-mono text-inky hover:text-navy">All</button>
                <button onClick={clearAll} className="text-[10px] font-mono text-inky hover:text-navy">None</button>
              </div>
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs font-mono text-inky/70">No matches</div>
              ) : filtered.map((loc) => {
                const active = selected.some((s) => s.id === loc.id)
                return (
                  <button key={loc.id} onClick={() => toggle(loc)}
                    className={['flex items-center gap-2 w-full px-3 py-1.5 text-xs font-mono text-left hover:bg-navy/5', active ? 'bg-navy/5' : ''].join(' ')}>
                    <input type="checkbox" readOnly checked={active} className="accent-inky flex-shrink-0" />
                    <span className="text-navy">{loc.location_code}</span>
                    <span className="text-inky/60 truncate">— {loc.name}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ManualEntry({ locations, onConfirm }: { locations: Location[]; onConfirm: (lines: GeneratedLineItem[]) => void }) {
  const [rows, setRows] = useState<MRow[]>([])
  const [selectedLocs, setSelectedLocs] = useState<Location[]>([])
  const [entry, setEntry] = useState({ product: '', amount: '' })
  const productRef = useRef<HTMLInputElement>(null)

  function resolveLoc(locStr: string): { id: string | null; label: string } {
    const v = locStr.trim().toLowerCase()
    const m = locations.find((l) => l.id.toLowerCase() === v || l.location_code.toLowerCase() === v || l.name.toLowerCase() === v)
    if (m) return { id: m.id, label: `${m.location_code} — ${m.name}` }
    return { id: null, label: locStr.trim() || '—' }
  }

  function addEntry() {
    if (!entry.product.trim() || !entry.amount.trim()) { toast.error('Enter a product and order amount'); return }
    if (selectedLocs.length === 0) { toast.error('Select at least one location'); return }
    const newRows: MRow[] = selectedLocs.map((l) => ({ location: l.location_code, product: entry.product, amount: entry.amount }))
    setRows((r) => [...r, ...newRows])
    setEntry({ product: '', amount: '' })
    productRef.current?.focus()
  }
  function setRow(i: number, key: keyof MRow, val: string) { setRows((r) => r.map((x, j) => (j === i ? { ...x, [key]: val } : x))) }
  function removeRow(i: number) { setRows((r) => r.filter((_, j) => j !== i)) }

  function confirm() {
    const valid = rows.filter((r) => r.product.trim())
    if (!valid.length) { toast.error('Add at least one product'); return }
    const lines: GeneratedLineItem[] = valid.map((r) => {
      const { id, label } = resolveLoc(r.location)
      const amt = parseFloat(r.amount.replace(/[$,]/g, '')) || 0
      return {
        location_id: id, location_label: label, product_id: r.product.trim(), vendor_part_number: null,
        on_hand: null, suggested_qty: amt, final_qty: amt, unit_of_measure: null, package_type: null,
        bulk_minimum: null, individual_minimum: null, applied_min_rule: null, trigger_reason: 'manual',
        category: null, raw_location: r.location.trim(), daily_usage: null, days_on_hand: null, pending_qty: 0, order_uom: null,
      }
    })
    onConfirm(lines)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-mono text-inky/70">Select one or more locations, enter a product and amount, then + Add. Selecting multiple locations creates one row per location. Rows below are editable.</p>

      <div className="flex flex-col gap-3 rounded border border-navy/30 bg-cream p-3">
        <MultiLocPicker locations={locations} selected={selectedLocs} onChange={setSelectedLocs} />
        <div className="grid grid-cols-[1fr_0.6fr_auto] gap-2 items-end">
          <label className="flex flex-col gap-1"><span className="text-[10px] font-mono uppercase text-inky">Product</span>
            <input ref={productRef} value={entry.product} onChange={(e) => setEntry({ ...entry, product: e.target.value })} className={cellCls} /></label>
          <label className="flex flex-col gap-1"><span className="text-[10px] font-mono uppercase text-inky">Order Amount</span>
            <input value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }} className={cellCls} /></label>
          <Button size="sm" onClick={addEntry}>+ Add</Button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="overflow-auto max-h-[calc(100vh-300px)] rounded border border-navy/30">
          <table className="min-w-full text-xs font-mono">
            <thead className="sticky top-0 bg-navy text-inky uppercase tracking-wide">
              <tr><th className="px-2 py-2 text-left">Location</th><th className="px-2 py-2 text-left">Product</th><th className="px-2 py-2 text-left">Order Amount</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-navy/10">
                  <td className="px-1 py-1"><input list="manual-loc-list" value={r.location} onChange={(e) => setRow(i, 'location', e.target.value)} className={cellCls} /></td>
                  <td className="px-1 py-1"><input value={r.product} onChange={(e) => setRow(i, 'product', e.target.value)} className={cellCls} /></td>
                  <td className="px-1 py-1"><input value={r.amount} onChange={(e) => setRow(i, 'amount', e.target.value)} className={cellCls} /></td>
                  <td className="px-2"><button onClick={() => removeRow(i)} className="text-inky/70 hover:text-red-400">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-inky">{rows.length} line{rows.length !== 1 ? 's' : ''}</span>
        <Button size="sm" onClick={confirm} disabled={!rows.length}>Continue → Review</Button>
      </div>

      <datalist id="manual-loc-list">
        {locations.map((l) => <option key={l.id} value={l.location_code}>{l.location_code} — {l.name}</option>)}
      </datalist>
    </div>
  )
}

// ---------------------------------------------------------------------------
function ParamsStage({ minRules, pendingCount, onPendingFile, onClearPending, productIds, onPackRulesChange, onBack, onGenerate }: {
  minRules: OrderMinRule[]
  pendingCount: number
  onPendingFile: (p: ParsedUpload, mapping: { location: string; product: string; qty: string }) => void
  onClearPending: () => void
  productIds: string[]
  onPackRulesChange: (rules: PrefixSuffixRule[]) => void
  onBack: () => void
  onGenerate: () => void
}) {
  const store = useOrderStore()
  const p = store.params
  const usageGlobal = p.usageAdjustment?.global ?? null

  const formulaLines = p.orderMode === 'days_supply'
    ? ['Order = ⌈ max(0, (daily_usage × (lead_time + target_days)) − on_hand) ⌉']
    : ['Order = when on_hand ≤ trigger → fill to capacity', '(min/max model — requires order_trigger and capacity configured per product)']

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><span className="text-xs font-mono text-inky uppercase tracking-wide">Generation Parameters</span></CardHeader>
        <CardBody className="flex flex-col gap-4">
          {/* Order mode toggle */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Order Mode</span>
            <div className="flex rounded border border-navy/30 overflow-hidden w-fit">
              {(['days_supply', 'min_max'] as const).map((m) => (
                <button key={m} onClick={() => store.setParams({ orderMode: m })}
                  className={['px-3 py-1.5 text-xs font-mono transition-colors',
                    p.orderMode === m ? 'bg-navy text-cream' : 'text-inky hover:text-navy'].join(' ')}>
                  {m === 'days_supply' ? 'Days Supply' : 'Min / Max'}
                </button>
              ))}
            </div>
          </div>

          {/* Target days slider */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Target Days of Supply</span>
              <span className="px-2 py-0.5 bg-navy text-cream text-[10px] font-mono rounded-full">{p.targetDays}</span>
            </div>
            <input
              type="range" min={1} max={90} step={1}
              value={p.targetDays}
              onChange={(e) => store.setParams({ targetDays: Number(e.target.value) })}
              className="w-full max-w-xs accent-navy"
            />
            <div className="flex justify-between max-w-xs text-[10px] font-mono text-inky/40">
              <span>1</span><span>30</span><span>60</span><span>90</span>
            </div>
          </div>

          {/* Zero-usage fill button group */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Zero-Usage Fill</span>
            <div className="flex rounded border border-navy/30 overflow-hidden w-fit">
              {([['none', 'No Order'], ['min', 'Fill to Min'], ['max', 'Fill to Max']] as const).map(([val, label]) => (
                <button key={val} onClick={() => store.setParams({ zeroUsageFill: val })}
                  className={['px-3 py-1.5 text-xs font-mono border-r last:border-r-0 border-navy/30 transition-colors',
                    p.zeroUsageFill === val ? 'bg-navy text-cream' : 'text-inky hover:text-navy'].join(' ')}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Formula preview */}
          <div className="rounded border border-navy/20 bg-navy/5 px-3 py-2 flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/50 uppercase tracking-widest">Formula preview</span>
            {formulaLines.map((line, i) => (
              <p key={i} className="text-xs font-mono text-inky/70">{line}</p>
            ))}
          </div>

          {/* Advanced overrides */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Input label="Usage Adjust %" value={usageGlobal?.toString() ?? ''} placeholder="e.g. 10 = +10%"
              onChange={(e) => { const t = e.target.value.trim(); store.setParams({ usageAdjustment: t === '' ? null : { global: Number(t) || 0 } }) }} />
            <Input label="Trigger Override" value={p.triggerOverride?.toString() ?? ''} onChange={(e) => store.setParams({ triggerOverride: e.target.value.trim() === '' ? null : Number(e.target.value) })} placeholder="optional" />
            <Input label="Order Limit Override" value={p.limitOverride?.toString() ?? ''} onChange={(e) => store.setParams({ limitOverride: e.target.value.trim() === '' ? null : Number(e.target.value) })} placeholder="optional" />
          </div>
        </CardBody>
      </Card>

      <PendingOrdersCard count={pendingCount} onFile={onPendingFile} onClear={onClearPending} />

      <PackRulesCard productIds={productIds} onChange={onPackRulesChange} />

      <Card>
        <CardHeader><span className="text-xs font-mono text-inky uppercase tracking-wide">Minimum-Order Rule Set ({store.selectedMinRuleIds.length} selected)</span></CardHeader>
        <CardBody className="flex flex-col gap-1.5">
          {minRules.length === 0 ? (
            <p className="text-xs font-mono text-inky/70">No active rules. Add some in the Min Rules tab.</p>
          ) : minRules.map((r) => {
            const checked = store.selectedMinRuleIds.includes(r.id)
            return (
              <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={checked} className="accent-inky"
                  onChange={() => store.setSelectedMinRuleIds(checked ? store.selectedMinRuleIds.filter((x) => x !== r.id) : [...store.selectedMinRuleIds, r.id])} />
                <span className="text-xs font-mono text-navy">{r.name ?? (r.applies_to as any)?.scope ?? 'rule'}</span>
              </label>
            )
          })}
        </CardBody>
      </Card>

      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>← Back</Button>
        <Button onClick={onGenerate}>Generate Order →</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
function PendingOrdersCard({ count, onFile, onClear }: {
  count: number
  onFile: (p: ParsedUpload, mapping: { location: string; product: string; qty: string }) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [map, setMap] = useState({ location: '', product: '', qty: '' })

  function onParsed(p: ParsedUpload) {
    setParsed(p)
    setMap(autoPendingColMap(p.headers))
  }

  const colOptions = (parsed?.headers ?? []).map((h) => ({ value: h, label: h }))

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-xs font-mono text-inky uppercase tracking-wide">
          Pending Orders {count > 0 ? <span className="text-green-700">· {count} lines loaded</span> : <span className="text-inky/70">· optional</span>}
        </span>
        <div className="flex gap-2">
          {count > 0 && <button onClick={() => { onClear(); setParsed(null) }} className="text-xs font-mono text-red-400 hover:text-red-300">Clear</button>}
          <button onClick={() => setOpen((v) => !v)} className="text-xs font-mono text-inky hover:underline">{open ? 'Hide' : 'Add file'}</button>
        </div>
      </CardHeader>
      {open && (
        <CardBody className="flex flex-col gap-3">
          <p className="text-xs font-mono text-inky/70">Upload an already-placed/pending order file. Matching product+location qty is subtracted from each suggestion.</p>
          {!parsed ? (
            <FileUploadZone onParsed={onParsed} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3">
                <Select label="Location Col" options={[{ value: '', label: '—' }, ...colOptions]} value={map.location} onChange={(e) => setMap({ ...map, location: e.target.value })} />
                <Select label="Product Col" options={[{ value: '', label: '—' }, ...colOptions]} value={map.product} onChange={(e) => setMap({ ...map, product: e.target.value })} />
                <Select label="Qty Col" options={[{ value: '', label: '—' }, ...colOptions]} value={map.qty} onChange={(e) => setMap({ ...map, qty: e.target.value })} />
              </div>
              <div className="flex justify-between">
                <Button size="sm" variant="secondary" onClick={() => setParsed(null)}>Choose different file</Button>
                <Button size="sm" disabled={!map.product || !map.qty} onClick={() => { onFile(parsed, map); setOpen(false) }}>Apply Pending</Button>
              </div>
            </div>
          )}
        </CardBody>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
type DetectedPattern = ReturnType<typeof detectPrefixSuffixPatterns>[number]
type PackCfg = { size: string; mode: 'pack' | 'round'; enabled: boolean }

function PackRulesCard({ productIds, onChange }: { productIds: string[]; onChange: (rules: PrefixSuffixRule[]) => void }) {
  const [open, setOpen] = useState(false)
  const [detected, setDetected] = useState<DetectedPattern[]>([])
  const [cfg, setCfg] = useState<Record<string, PackCfg>>({})

  function detect() {
    const pats = detectPrefixSuffixPatterns(productIds.filter(Boolean)).filter((p) => p.type === 'prefix' || p.type === 'suffix')
    setDetected(pats)
    if (pats.length === 0) toast('No common prefixes/suffixes found', { icon: '🔍' })
  }

  useEffect(() => {
    const rules: PrefixSuffixRule[] = detected
      .filter((d) => cfg[d.key]?.enabled && Number(cfg[d.key]?.size) > 0)
      .map((d) => ({ text: d.text, matchType: d.type as 'prefix' | 'suffix', purchaseSize: Number(cfg[d.key].size), orderMode: cfg[d.key].mode }))
    onChange(rules)
  }, [cfg, detected, onChange])

  const activeCount = detected.filter((d) => cfg[d.key]?.enabled && Number(cfg[d.key]?.size) > 0).length

  function update(key: string, patch: Partial<PackCfg>) {
    setCfg((c) => {
      const prev: PackCfg = c[key] ?? { size: '', mode: 'pack', enabled: false }
      return { ...c, [key]: { ...prev, ...patch } }
    })
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-xs font-mono text-inky uppercase tracking-wide">
          Pack Rules {activeCount > 0 ? <span className="text-green-700">· {activeCount} active</span> : <span className="text-inky/70">· optional</span>}
        </span>
        <button onClick={() => setOpen((v) => !v)} className="text-xs font-mono text-inky hover:underline">{open ? 'Hide' : 'Detect packs'}</button>
      </CardHeader>
      {open && (
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-mono text-inky/70">Detect common product-ID prefixes/suffixes and order them in packs. <span className="text-inky">Pack</span> = order whole packs; <span className="text-inky">Round</span> = round up to a pack multiple.</p>
            <Button size="sm" variant="secondary" onClick={detect}>Scan {productIds.length} products</Button>
          </div>
          {detected.length > 0 && (
            <div className="overflow-auto max-h-[40vh] rounded border border-navy/30">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-navy text-inky uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-2 text-left">Use</th>
                    <th className="px-2 py-2 text-left">Pattern</th>
                    <th className="px-2 py-2 text-right">Count</th>
                    <th className="px-2 py-2 text-left">Examples</th>
                    <th className="px-2 py-2 text-right">Pack Size</th>
                    <th className="px-2 py-2 text-left">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {detected.map((d) => {
                    const c = cfg[d.key] ?? { size: '', mode: 'pack' as const, enabled: false }
                    return (
                      <tr key={d.key} className="border-t border-navy/10">
                        <td className="px-2 py-1"><input type="checkbox" checked={c.enabled} className="accent-inky" onChange={(e) => update(d.key, { enabled: e.target.checked })} /></td>
                        <td className="px-2 py-1 text-navy"><span className="text-orange-600 uppercase">{d.type}</span> &ldquo;{d.text}&rdquo;</td>
                        <td className="px-2 py-1 text-right text-inky">{d.count}</td>
                        <td className="px-2 py-1 text-inky/70">{d.examples.join(', ')}</td>
                        <td className="px-2 py-1 text-right">
                          <input type="number" min={1} value={c.size} onChange={(e) => update(d.key, { size: e.target.value, enabled: true })}
                            className="w-16 bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-right text-navy focus:outline-none focus:border-sky" />
                        </td>
                        <td className="px-2 py-1">
                          <select value={c.mode} onChange={(e) => update(d.key, { mode: e.target.value as 'pack' | 'round' })}
                            className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky">
                            <option value="pack">Pack</option>
                            <option value="round">Round</option>
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
function NavigatorCard({
  title, item, pos, total, groupQty, onGroupQtyChange, onPrev, onNext, onApply, highlight,
}: {
  title: string
  item: (GeneratedLineItem & { _origIdx: number }) | null
  pos: number
  total: number
  groupQty: string
  onGroupQtyChange: (v: string) => void
  onPrev: () => void
  onNext: () => void
  onApply: () => void
  highlight: boolean
}) {
  const btnCls = 'px-2 py-0.5 text-[10px] font-mono border border-navy/30 rounded hover:bg-navy/5 disabled:opacity-30 disabled:cursor-not-allowed'
  return (
    <div className={['rounded border overflow-hidden', highlight ? 'border-sky' : 'border-navy/30'].join(' ')}>
      <div className="bg-navy px-3 py-1.5 flex items-center justify-between">
        <span className="text-[10px] font-mono text-cream uppercase tracking-widest">{title}</span>
        {total > 0 && <span className="text-[10px] font-mono text-cream/50">{pos + 1} / {total}</span>}
      </div>
      <div className="bg-cream px-3 py-2 flex flex-col gap-1.5">
        {item ? (
          <>
            <div className="flex items-start justify-between gap-2 min-h-[2.5rem]">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono text-navy font-bold truncate" title={item.product_id}>{item.product_id}</p>
                <p className="text-[10px] font-mono text-inky/60 truncate">{item.location_label}</p>
              </div>
              <span className="text-sm font-mono font-bold text-navy flex-shrink-0">{item.final_qty}</span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={onPrev} disabled={pos === 0} className={btnCls}>‹ Prev</button>
              <button onClick={onNext} disabled={pos >= total - 1} className={btnCls}>Next ›</button>
              <input
                type="number" min={0}
                value={groupQty}
                onChange={(e) => onGroupQtyChange(e.target.value)}
                placeholder="Set all…"
                className="w-20 bg-cream border border-navy/30 rounded px-1.5 py-0.5 text-[10px] font-mono text-navy focus:outline-none focus:border-sky"
              />
              <button
                onClick={onApply}
                disabled={!groupQty}
                className="px-2 py-0.5 text-[10px] font-mono bg-navy text-cream rounded hover:bg-navy/80 disabled:opacity-30 disabled:cursor-not-allowed"
              >Apply</button>
            </div>
          </>
        ) : (
          <p className="text-[10px] font-mono text-inky/40 py-2 text-center">No items</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
function ReviewStage({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const store = useOrderStore()

  const [mostPos, setMostPos] = useState(0)
  const [leastPos, setLeastPos] = useState(0)
  const [activeNav, setActiveNav] = useState<'most' | 'least' | null>(null)
  const [mostGroupQty, setMostGroupQty] = useState('')
  const [leastGroupQty, setLeastGroupQty] = useState('')
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map())

  type IndexedLine = GeneratedLineItem & { _origIdx: number }

  const sortedDesc = useMemo<IndexedLine[]>(() =>
    store.lineItems.map((l, i) => ({ ...l, _origIdx: i })).sort((a, b) => b.final_qty - a.final_qty),
    [store.lineItems]
  )
  const sortedAsc = useMemo<IndexedLine[]>(() =>
    store.lineItems.map((l, i) => ({ ...l, _origIdx: i })).filter((l) => l.final_qty > 0).sort((a, b) => a.final_qty - b.final_qty),
    [store.lineItems]
  )

  const mostItem = sortedDesc[mostPos] ?? null
  const leastItem = sortedAsc[leastPos] ?? null
  const highlightIdx = activeNav === 'most' ? mostItem?._origIdx : activeNav === 'least' ? leastItem?._origIdx : undefined

  // Scroll to the navigated row
  useEffect(() => {
    if (highlightIdx == null) return
    rowRefs.current.get(highlightIdx)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlightIdx, mostPos, leastPos])

  // Clamp positions when lineItems change
  useEffect(() => {
    setMostPos((p) => Math.min(p, Math.max(0, sortedDesc.length - 1)))
    setLeastPos((p) => Math.min(p, Math.max(0, sortedAsc.length - 1)))
  }, [sortedDesc.length, sortedAsc.length])

  function applyGroupUpdate(item: IndexedLine | null, qty: string) {
    if (!item || !qty) return
    const n = Number(qty)
    if (isNaN(n) || n < 0) return
    let count = 0
    store.lineItems.forEach((l, i) => {
      if (l.product_id === item.product_id) { store.updateFinalQty(i, n); count++ }
    })
    toast.success(`Set ${count} row${count !== 1 ? 's' : ''} of ${item.product_id} to ${n}`)
  }

  const ordered = store.lineItems.filter((l) => l.final_qty > 0).length

  return (
    <div className="flex flex-col gap-4">
      {/* Navigator panels */}
      {store.lineItems.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <NavigatorCard
            title="Most Ordered"
            item={mostItem}
            pos={mostPos}
            total={sortedDesc.length}
            groupQty={mostGroupQty}
            onGroupQtyChange={setMostGroupQty}
            highlight={activeNav === 'most'}
            onPrev={() => { setMostPos((p) => Math.max(0, p - 1)); setActiveNav('most') }}
            onNext={() => { setMostPos((p) => Math.min(sortedDesc.length - 1, p + 1)); setActiveNav('most') }}
            onApply={() => { applyGroupUpdate(mostItem, mostGroupQty); setMostGroupQty('') }}
          />
          <NavigatorCard
            title="Least Ordered"
            item={leastItem}
            pos={leastPos}
            total={sortedAsc.length}
            groupQty={leastGroupQty}
            onGroupQtyChange={setLeastGroupQty}
            highlight={activeNav === 'least'}
            onPrev={() => { setLeastPos((p) => Math.max(0, p - 1)); setActiveNav('least') }}
            onNext={() => { setLeastPos((p) => Math.min(sortedAsc.length - 1, p + 1)); setActiveNav('least') }}
            onApply={() => { applyGroupUpdate(leastItem, leastGroupQty); setLeastGroupQty('') }}
          />
        </div>
      )}

      <p className="text-xs font-mono text-inky">
        <span className="text-green-700">{ordered}</span> of {store.lineItems.length} lines have an order qty · edit any final qty below
      </p>

      <div className="overflow-auto rounded border border-navy/30 max-h-[28rem]">
        <table className="w-full text-xs font-mono">
          <thead className="bg-navy text-inky uppercase tracking-wide sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left">Location</th>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">On Hand</th>
              <th className="px-3 py-2 text-right">Daily Usage</th>
              <th className="px-3 py-2 text-right">Days OH</th>
              <th className="px-3 py-2 text-right">Suggested</th>
              <th className="px-3 py-2 text-right">Pending</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Min Rule</th>
              <th className="px-3 py-2 text-left">UoM</th>
              <th className="px-3 py-2 text-right">Final Qty</th>
              <th className="px-3 py-2 text-right">Days After</th>
            </tr>
          </thead>
          <tbody>
            {store.lineItems.map((l, i) => {
              const isHighlighted = highlightIdx === i
              // Recompute live from current final_qty
              const daysAfter = l.daily_usage && l.daily_usage > 0
                ? ((l.on_hand ?? 0) + l.final_qty) / l.daily_usage
                : null
              return (
                <tr
                  key={i}
                  ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i) }}
                  className={[
                    'border-t border-navy/10 hover:bg-sky/5',
                    isHighlighted ? 'ring-2 ring-inset ring-sky bg-sky/10' : '',
                  ].join(' ')}
                >
                  <td className="px-3 py-1.5 text-navy">{l.location_label}</td>
                  <td className="px-3 py-1.5 text-navy">{l.product_id}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{l.on_hand ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{l.daily_usage != null ? l.daily_usage.toFixed(2) : '—'}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{l.days_on_hand != null ? l.days_on_hand.toFixed(1) : '—'}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{l.suggested_qty}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{l.pending_qty > 0 ? `−${l.pending_qty}` : '—'}</td>
                  <td className="px-3 py-1.5">
                    <Badge color={l.trigger_reason.startsWith('below') || l.trigger_reason.startsWith('projected') ? 'amber' : 'gray'}>
                      {TRIGGER_REASON_LABELS[l.trigger_reason] ?? l.trigger_reason}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-inky">{l.applied_min_rule ?? '—'}</td>
                  <td className="px-3 py-1.5 text-inky">
                    {l.order_uom ? <span>{l.order_uom}</span> : (l.unit_of_measure ?? '—')}
                    {l.package_type ? ` · ${l.package_type}` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <input type="number" min={0} value={l.final_qty}
                      onChange={(e) => store.updateFinalQty(i, Number(e.target.value))}
                      className={['w-20 bg-cream border rounded px-2 py-1 text-xs font-mono text-right focus:outline-none focus:border-sky',
                        l.final_qty !== l.suggested_qty ? 'border-amber-400 text-orange-600' : 'border-navy/30 text-navy'].join(' ')} />
                  </td>
                  <td className="px-3 py-1.5 text-right text-inky">{daysAfter != null ? daysAfter.toFixed(1) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>← Back</Button>
        <Button onClick={onContinue}>Continue to Export →</Button>
      </div>
    </div>
  )
}
