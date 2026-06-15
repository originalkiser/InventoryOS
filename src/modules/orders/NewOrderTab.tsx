import { useEffect, useRef, useState, useCallback } from 'react'
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
import type {
  Location, LocationOrderConfig, ProductIdMapping, GlobalProduct, VendorPart, OrderMinRule,
  UomMapping, ParsedUpload, ColumnMapping,
} from '@/types'
import toast from 'react-hot-toast'

type Stage = 'start' | 'params' | 'review' | 'export'
type Source = 'manual' | 'file' | 'live'
// Config-based (uses InventoryOS config), Manual (grouped entry), or Independent
// (standalone — uploaded file only; config is optional). All share one engine.
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

// Map (location|product → already-ordered qty) for pending subtraction.
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

  // Pending-order subtraction (optional)
  const [pending, setPending] = useState<PendingIndex | null>(null)
  const [pendingCount, setPendingCount] = useState(0)

  // Prefix/suffix pack rules detected from the uploaded product IDs (optional)
  const [packRules, setPackRules] = useState<PrefixSuffixRule[]>([])

  // Export options
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [excludeZeros, setExcludeZeros] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load config + min rules
  const loadConfig = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const [loc, cfg, pm, gp, vp, mr, um] = await Promise.all([
      sb.from('locations').select('*').eq('company_id', companyId),
      sb.from('location_order_configs').select('*').eq('company_id', companyId).eq('active', true),
      sb.from('product_id_mappings').select('*').eq('company_id', companyId),
      sb.from('global_products').select('*').eq('company_id', companyId),
      sb.from('vendor_parts').select('*').eq('company_id', companyId),
      sb.from('order_min_rules').select('*').eq('company_id', companyId).eq('active', true),
      sb.from('uom_mappings').select('*').eq('company_id', companyId),
    ])
    const globalProducts = (gp.data ?? []) as GlobalProduct[]
    setConfig({
      locations: (loc.data ?? []) as Location[],
      locationConfigs: (cfg.data ?? []) as LocationOrderConfig[],
      productMappings: (pm.data ?? []) as ProductIdMapping[],
      globalProducts,
      vendorParts: (vp.data ?? []) as VendorPart[],
    })

    // UoM conversion config: factor table + per-product order units.
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

  // Independent mode mirrors the standalone order-generator: days-supply by
  // default and config is optional.
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
        const raw = row[m.sourceColumn] ?? ''
        if (NUMERIC_FIELDS.includes(m.fieldName)) {
          const v = toNum(raw)
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
    // pending (a Map) and uom config are threaded in here rather than living in
    // the persisted store params. Detected pack rules merge into the UoM config.
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

    // Download
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

    // Persist session + line items
    const sb = supabase as any
    const { data: sess, error: sErr } = await sb.from('order_sessions').insert({
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
    const { error: lErr } = await sb.from('order_line_items').insert(lineRows)
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

  if (!companyId) return <div className="text-xs font-mono text-gray-500 py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <StageBar stage={stage} mode={mode} />

      {stage === 'start' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">
                {mode === 'manual' ? 'Manual Order Entry' : mode === 'independent' ? 'Upload Inventory (standalone)' : 'Inventory Source'}
              </span>
              {/* Config mode lets you switch between an uploaded file and a live source. */}
              {mode === 'config' && (
                <div className="flex rounded border border-[#2a2d3e] overflow-hidden">
                  {(['file', 'live'] as Source[]).map((s) => (
                    <button key={s} onClick={() => { setSource(s); setParsed(null) }}
                      className={['px-3 py-1 text-xs font-mono capitalize', source === s ? 'bg-[#00e5ff]/10 text-[#00e5ff]' : 'text-gray-500 hover:text-gray-300'].join(' ')}>
                      {s === 'live' ? 'Live Source' : s}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              {mode === 'independent' && (
                <p className="text-xs font-mono text-gray-500">Standalone generator — works from just the uploaded file. The InventoryOS config (order configs, vendor parts, UoM) is used when present but isn&apos;t required.</p>
              )}

              {mode === 'manual' ? (
                <ManualEntry
                  locations={config?.locations ?? []}
                  onConfirm={(lines) => { store.setLineItems(lines); store.setSourceMode('manual'); setStage('review') }}
                />
              ) : source === 'live' ? (
                <DataSourceLinker configType="orders" />
              ) : !parsed ? (
                <FileUploadZone onParsed={(r) => setParsed(r)} />
              ) : (
                <ColumnMapper headers={parsed.headers} requiredFields={MAP_FIELDS} rememberKey="orders.inventory" previewRows={parsed.rows.slice(0, 5)}
                  initialMappings={store.mapping.length ? store.mapping : undefined}
                  onConfirm={(m) => { store.setInputRows(rowsFromFile(m)); setStage('params'); toast.success(`Loaded ${parsed.rows.length} rows`) }}
                  onCancel={() => setParsed(null)} />
              )}
            </CardBody>
          </Card>

          <Card><CardBody><OrderDocuments companyId={companyId} sessionId={null} stage="start" uploadedBy={profile?.id ?? null} /></CardBody></Card>
        </div>
      )}

      {stage === 'params' && (
        <ParamsStage
          minRules={minRules}
          pendingCount={pendingCount}
          onPendingFile={applyPendingFile}
          onClearPending={() => { setPending(null); setPendingCount(0) }}
          productIds={store.inputRows.map((r) => String(r.product ?? ''))}
          onPackRulesChange={setPackRules}
          onBack={() => setStage('start')}
          onGenerate={generate}
        />
      )}

      {stage === 'review' && (
        <ReviewStage onBack={() => setStage(mode === 'manual' ? 'start' : 'params')} onContinue={() => setStage('export')} />
      )}

      {stage === 'export' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Export</span></CardHeader>
            <CardBody className="flex flex-col gap-3">
              <Input label="Order Name" value={store.sessionName} onChange={(e) => store.setSessionName(e.target.value)} placeholder="e.g. Week 24 reorder" />
              <div className="flex items-end gap-4 flex-wrap">
                <div className="w-40"><Select label="Format" options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }]} value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx')} /></div>
                <div className="flex items-center gap-2 pb-2"><Toggle checked={excludeZeros} onChange={setExcludeZeros} size="sm" color="cyan" /><span className="text-xs font-mono text-gray-400">Exclude zero-qty lines</span></div>
                <span className="text-xs font-mono text-[#00e5ff] pb-2">
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
        { key: 'params', label: '2 · Params' },
        { key: 'review', label: '3 · Generate' },
        { key: 'export', label: '4 · Export' },
      ]
  const idx = steps.findIndex((s) => s.key === stage)
  return (
    <div className="flex gap-2 flex-wrap">
      {steps.map((s, i) => (
        <span key={s.key} className={[
          'px-3 py-1 text-xs font-mono rounded border',
          i === idx ? 'border-[#00e5ff] text-[#00e5ff] bg-[#00e5ff]/10'
            : i < idx ? 'border-[#39ff14]/30 text-[#39ff14]' : 'border-[#2a2d3e] text-gray-600',
        ].join(' ')}>{s.label}</span>
      ))}
    </div>
  )
}

interface MRow { location: string; product: string; amount: string }
const cellCls = 'w-full bg-[#161820] border border-[#2a2d3e] rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-[#00e5ff]'

// Manual order = Location + Product + Order Amount. The entry row keeps the last
// location so you can add the same/next product fast (Tab across, Enter on
// Amount pushes the row). The accumulating table below is fully editable.
function ManualEntry({ locations, onConfirm }: { locations: Location[]; onConfirm: (lines: GeneratedLineItem[]) => void }) {
  const [rows, setRows] = useState<MRow[]>([])
  const [entry, setEntry] = useState<MRow>({ location: '', product: '', amount: '' })
  const productRef = useRef<HTMLInputElement>(null)

  function resolveLoc(locStr: string): { id: string | null; label: string } {
    const v = locStr.trim().toLowerCase()
    const m = locations.find((l) => l.id.toLowerCase() === v || l.location_code.toLowerCase() === v || l.name.toLowerCase() === v)
    if (m) return { id: m.id, label: `${m.location_code} — ${m.name}` }
    return { id: null, label: locStr.trim() || '—' }
  }

  function addEntry() {
    if (!entry.product.trim() || !entry.amount.trim()) { toast.error('Enter a product and order amount'); return }
    setRows((r) => [...r, { ...entry }])
    setEntry((e) => ({ location: e.location, product: '', amount: '' })) // keep location
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
        category: null, raw_location: r.location.trim(), days_on_hand: null, pending_qty: 0, order_uom: null,
      }
    })
    onConfirm(lines)
  }

  return (
    <div className="flex flex-col gap-4">
      <datalist id="manual-loc-list">
        {locations.map((l) => <option key={l.id} value={l.location_code}>{l.location_code} — {l.name}</option>)}
      </datalist>
      <p className="text-xs font-mono text-gray-600">Enter a location, product, and order amount, then Enter (or +). The location is kept for the next product so you can order the same item across shops quickly. Rows below are editable.</p>

      {/* Quick entry row */}
      <div className="grid grid-cols-[1.4fr_1.4fr_0.8fr_auto] items-end gap-2 rounded border border-[#2a2d3e] bg-[#0f1117] p-3">
        <label className="flex flex-col gap-1"><span className="text-[10px] font-mono uppercase text-gray-500">Location</span>
          <input list="manual-loc-list" value={entry.location} onChange={(e) => setEntry({ ...entry, location: e.target.value })} placeholder="Code / name / free text" className={cellCls} /></label>
        <label className="flex flex-col gap-1"><span className="text-[10px] font-mono uppercase text-gray-500">Product</span>
          <input ref={productRef} value={entry.product} onChange={(e) => setEntry({ ...entry, product: e.target.value })} className={cellCls} /></label>
        <label className="flex flex-col gap-1"><span className="text-[10px] font-mono uppercase text-gray-500">Order Amount</span>
          <input value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }} className={cellCls} /></label>
        <Button size="sm" onClick={addEntry}>+ Add</Button>
      </div>

      {/* Accumulated, editable order table */}
      {rows.length > 0 && (
        <div className="overflow-auto rounded border border-[#2a2d3e]">
          <table className="w-full text-xs font-mono">
            <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide">
              <tr><th className="px-2 py-2 text-left">Location</th><th className="px-2 py-2 text-left">Product</th><th className="px-2 py-2 text-left">Order Amount</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-[#2a2d3e]/50">
                  <td className="px-1 py-1"><input list="manual-loc-list" value={r.location} onChange={(e) => setRow(i, 'location', e.target.value)} className={cellCls} /></td>
                  <td className="px-1 py-1"><input value={r.product} onChange={(e) => setRow(i, 'product', e.target.value)} className={cellCls} /></td>
                  <td className="px-1 py-1"><input value={r.amount} onChange={(e) => setRow(i, 'amount', e.target.value)} className={cellCls} /></td>
                  <td className="px-2"><button onClick={() => removeRow(i)} className="text-gray-600 hover:text-red-400">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-500">{rows.length} line{rows.length !== 1 ? 's' : ''}</span>
        <Button size="sm" onClick={confirm} disabled={!rows.length}>Continue → Review</Button>
      </div>
    </div>
  )
}

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
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Generation Parameters</span></CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Select label="Order Mode" options={[{ value: 'min_max', label: 'Min / Max' }, { value: 'days_supply', label: 'Days Supply' }]}
              value={p.orderMode} onChange={(e) => store.setParams({ orderMode: e.target.value as 'min_max' | 'days_supply' })} />
            <Input label="Target Days" value={String(p.targetDays)} onChange={(e) => store.setParams({ targetDays: Number(e.target.value) || 0 })} />
            <Select label="Zero-Usage Fill" options={[{ value: 'none', label: 'None' }, { value: 'min', label: 'To Trigger' }, { value: 'max', label: 'To Capacity' }]}
              value={p.zeroUsageFill} onChange={(e) => store.setParams({ zeroUsageFill: e.target.value as 'none' | 'min' | 'max' })} />
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
        <CardHeader><span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Minimum-Order Rule Set ({store.selectedMinRuleIds.length} selected)</span></CardHeader>
        <CardBody className="flex flex-col gap-1.5">
          {minRules.length === 0 ? (
            <p className="text-xs font-mono text-gray-600">No active rules. Add some in the Min Rules tab.</p>
          ) : minRules.map((r) => {
            const checked = store.selectedMinRuleIds.includes(r.id)
            return (
              <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={checked} className="accent-[#00e5ff]"
                  onChange={() => store.setSelectedMinRuleIds(checked ? store.selectedMinRuleIds.filter((x) => x !== r.id) : [...store.selectedMinRuleIds, r.id])} />
                <span className="text-xs font-mono text-gray-300">{r.name ?? (r.applies_to as any)?.scope ?? 'rule'}</span>
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
        <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">
          Pending Orders {count > 0 ? <span className="text-[#39ff14]">· {count} lines loaded</span> : <span className="text-gray-600">· optional</span>}
        </span>
        <div className="flex gap-2">
          {count > 0 && <button onClick={() => { onClear(); setParsed(null) }} className="text-xs font-mono text-red-400 hover:text-red-300">Clear</button>}
          <button onClick={() => setOpen((v) => !v)} className="text-xs font-mono text-[#00e5ff] hover:underline">{open ? 'Hide' : 'Add file'}</button>
        </div>
      </CardHeader>
      {open && (
        <CardBody className="flex flex-col gap-3">
          <p className="text-xs font-mono text-gray-600">Upload an already-placed/pending order file. Matching product+location qty is subtracted from each suggestion.</p>
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

type DetectedPattern = ReturnType<typeof detectPrefixSuffixPatterns>[number]
type PackCfg = { size: string; mode: 'pack' | 'round'; enabled: boolean }

function PackRulesCard({ productIds, onChange }: { productIds: string[]; onChange: (rules: PrefixSuffixRule[]) => void }) {
  const [open, setOpen] = useState(false)
  const [detected, setDetected] = useState<DetectedPattern[]>([])
  const [cfg, setCfg] = useState<Record<string, PackCfg>>({})

  function detect() {
    // Only prefix/suffix patterns are usable as pack rules (the engine matches
    // startsWith/endsWith); 'both' combos are informational only.
    const pats = detectPrefixSuffixPatterns(productIds.filter(Boolean)).filter((p) => p.type === 'prefix' || p.type === 'suffix')
    setDetected(pats)
    if (pats.length === 0) toast('No common prefixes/suffixes found', { icon: '🔍' })
  }

  // Emit the active rule set whenever the config changes.
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
        <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">
          Pack Rules {activeCount > 0 ? <span className="text-[#39ff14]">· {activeCount} active</span> : <span className="text-gray-600">· optional</span>}
        </span>
        <button onClick={() => setOpen((v) => !v)} className="text-xs font-mono text-[#00e5ff] hover:underline">{open ? 'Hide' : 'Detect packs'}</button>
      </CardHeader>
      {open && (
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-mono text-gray-600">Detect common product-ID prefixes/suffixes and order them in packs. <span className="text-gray-500">Pack</span> = order whole packs; <span className="text-gray-500">Round</span> = order units rounded up to a pack multiple.</p>
            <Button size="sm" variant="secondary" onClick={detect}>Scan {productIds.length} products</Button>
          </div>
          {detected.length > 0 && (
            <div className="overflow-auto rounded border border-[#2a2d3e]">
              <table className="w-full text-xs font-mono">
                <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide">
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
                      <tr key={d.key} className="border-t border-[#2a2d3e]/50">
                        <td className="px-2 py-1"><input type="checkbox" checked={c.enabled} className="accent-[#00e5ff]" onChange={(e) => update(d.key, { enabled: e.target.checked })} /></td>
                        <td className="px-2 py-1 text-gray-200"><span className="text-[#ffb300] uppercase">{d.type}</span> “{d.text}”</td>
                        <td className="px-2 py-1 text-right text-gray-400">{d.count}</td>
                        <td className="px-2 py-1 text-gray-600">{d.examples.join(', ')}</td>
                        <td className="px-2 py-1 text-right">
                          <input type="number" min={1} value={c.size} onChange={(e) => update(d.key, { size: e.target.value, enabled: true })}
                            className="w-16 bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1 text-xs font-mono text-right text-white focus:outline-none focus:border-[#00e5ff]" />
                        </td>
                        <td className="px-2 py-1">
                          <select value={c.mode} onChange={(e) => update(d.key, { mode: e.target.value as 'pack' | 'round' })}
                            className="bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-[#00e5ff]">
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

function ReviewStage({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const store = useOrderStore()
  const ordered = store.lineItems.filter((l) => l.final_qty > 0).length
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-mono text-gray-500">
        <span className="text-[#39ff14]">{ordered}</span> of {store.lineItems.length} lines have an order qty · edit any final qty below
      </p>
      <div className="overflow-auto rounded border border-[#2a2d3e] max-h-[28rem]">
        <table className="w-full text-xs font-mono">
          <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left">Location</th>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">On Hand</th>
              <th className="px-3 py-2 text-right">Days OH</th>
              <th className="px-3 py-2 text-right">Suggested</th>
              <th className="px-3 py-2 text-right">Pending</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Min Rule</th>
              <th className="px-3 py-2 text-left">UoM</th>
              <th className="px-3 py-2 text-right">Final Qty</th>
            </tr>
          </thead>
          <tbody>
            {store.lineItems.map((l, i) => (
              <tr key={i} className="border-t border-[#2a2d3e]/50 hover:bg-[#00e5ff]/5">
                <td className="px-3 py-1.5 text-gray-300">{l.location_label}</td>
                <td className="px-3 py-1.5 text-gray-300">{l.product_id}</td>
                <td className="px-3 py-1.5 text-right text-gray-400">{l.on_hand ?? '—'}</td>
                <td className="px-3 py-1.5 text-right text-gray-500">{l.days_on_hand != null ? l.days_on_hand.toFixed(1) : '—'}</td>
                <td className="px-3 py-1.5 text-right text-gray-400">{l.suggested_qty}</td>
                <td className="px-3 py-1.5 text-right text-gray-500">{l.pending_qty > 0 ? `−${l.pending_qty}` : '—'}</td>
                <td className="px-3 py-1.5"><Badge color={l.trigger_reason.startsWith('below') || l.trigger_reason.startsWith('projected') ? 'amber' : 'gray'}>{TRIGGER_REASON_LABELS[l.trigger_reason] ?? l.trigger_reason}</Badge></td>
                <td className="px-3 py-1.5 text-gray-500">{l.applied_min_rule ?? '—'}</td>
                <td className="px-3 py-1.5 text-gray-500">{l.order_uom ? <span className="text-[#00e5ff]">{l.order_uom}</span> : (l.unit_of_measure ?? '—')}{l.package_type ? ` · ${l.package_type}` : ''}</td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" min={0} value={l.final_qty}
                    onChange={(e) => store.updateFinalQty(i, Number(e.target.value))}
                    className={['w-20 bg-[#0f1117] border rounded px-2 py-1 text-xs font-mono text-right focus:outline-none focus:border-[#00e5ff]',
                      l.final_qty !== l.suggested_qty ? 'border-[#ffb300] text-[#ffb300]' : 'border-[#2a2d3e] text-white'].join(' ')} />
                </td>
              </tr>
            ))}
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
