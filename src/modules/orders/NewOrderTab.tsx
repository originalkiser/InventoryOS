import { useEffect, useState, useCallback } from 'react'
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
  TRIGGER_REASON_LABELS, type InventoryRow, type OrderConfigData,
} from '@/lib/orderEngine'
import type {
  Location, LocationOrderConfig, ProductIdMapping, GlobalProduct, VendorPart, OrderMinRule,
  ParsedUpload, ColumnMapping,
} from '@/types'
import toast from 'react-hot-toast'

type Stage = 'start' | 'params' | 'review' | 'export'
type Source = 'manual' | 'file' | 'live'

const MAP_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product', label: 'Product', required: true },
  { name: 'on_hand', label: 'On Hand' },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'leadtime', label: 'Lead Time (days)' },
  { name: 'category', label: 'Category' },
  { name: 'cost', label: 'Cost' },
]
const NUMERIC_FIELDS = ['on_hand', 'daily_usage', 'leadtime', 'cost']

function toNum(raw: string): number | string {
  const t = raw.trim()
  if (t === '') return ''
  const n = parseFloat(t.replace(/[$,]/g, ''))
  return isNaN(n) ? '' : n
}

export function NewOrderTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const store = useOrderStore()

  const [stage, setStage] = useState<Stage>('start')
  const [source, setSource] = useState<Source>('file')
  const [config, setConfig] = useState<OrderConfigData | null>(null)
  const [minRules, setMinRules] = useState<OrderMinRule[]>([])
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [manualRows, setManualRows] = useState<InventoryRow[]>([{ location: '', product: '', on_hand: '', daily_usage: '', leadtime: '' }])

  // Export options
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [excludeZeros, setExcludeZeros] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load config + min rules
  const loadConfig = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const [loc, cfg, pm, gp, vp, mr] = await Promise.all([
      sb.from('locations').select('*').eq('company_id', companyId),
      sb.from('location_order_configs').select('*').eq('company_id', companyId).eq('active', true),
      sb.from('product_id_mappings').select('*').eq('company_id', companyId),
      sb.from('global_products').select('*').eq('company_id', companyId),
      sb.from('vendor_parts').select('*').eq('company_id', companyId),
      sb.from('order_min_rules').select('*').eq('company_id', companyId).eq('active', true),
    ])
    setConfig({
      locations: (loc.data ?? []) as Location[],
      locationConfigs: (cfg.data ?? []) as LocationOrderConfig[],
      productMappings: (pm.data ?? []) as ProductIdMapping[],
      globalProducts: (gp.data ?? []) as GlobalProduct[],
      vendorParts: (vp.data ?? []) as VendorPart[],
    })
    const rules = (mr.data ?? []) as OrderMinRule[]
    setMinRules(rules)
    if (store.selectedMinRuleIds.length === 0) store.setSelectedMinRuleIds(rules.map((r) => r.id))
  }, [companyId])

  useEffect(() => { loadConfig() }, [loadConfig])

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
    const gen = generateOrder(rows, config, store.params)
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
    store.reset(); setParsed(null); setStage('start')
    setManualRows([{ location: '', product: '', on_hand: '', daily_usage: '', leadtime: '' }])
  }

  if (!companyId) return <div className="text-xs font-mono text-gray-500 py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <StageBar stage={stage} />

      {stage === 'start' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Inventory Source</span>
              <div className="flex rounded border border-[#2a2d3e] overflow-hidden">
                {(['file', 'manual', 'live'] as Source[]).map((s) => (
                  <button key={s} onClick={() => { setSource(s); setParsed(null) }}
                    className={['px-3 py-1 text-xs font-mono capitalize', source === s ? 'bg-[#00e5ff]/10 text-[#00e5ff]' : 'text-gray-500 hover:text-gray-300'].join(' ')}>
                    {s === 'live' ? 'Live Source' : s}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              {source === 'file' && (!parsed ? (
                <FileUploadZone onParsed={(r) => setParsed(r)} />
              ) : (
                <ColumnMapper headers={parsed.headers} requiredFields={MAP_FIELDS}
                  initialMappings={store.mapping.length ? store.mapping : undefined}
                  onConfirm={(m) => { store.setInputRows(rowsFromFile(m)); setStage('params'); toast.success(`Loaded ${parsed.rows.length} rows`) }}
                  onCancel={() => setParsed(null)} />
              ))}

              {source === 'manual' && (
                <ManualGrid rows={manualRows} onChange={setManualRows} onConfirm={() => {
                  const clean = manualRows.filter((r) => String(r.product ?? '').trim())
                  if (!clean.length) { toast.error('Add at least one product row'); return }
                  store.setInputRows(clean); store.setSourceMode('manual'); setStage('params')
                }} />
              )}

              {source === 'live' && <DataSourceLinker configType="orders" />}
            </CardBody>
          </Card>

          <Card><CardBody><OrderDocuments companyId={companyId} sessionId={null} stage="start" uploadedBy={profile?.id ?? null} /></CardBody></Card>
        </div>
      )}

      {stage === 'params' && (
        <ParamsStage
          minRules={minRules}
          onBack={() => setStage('start')}
          onGenerate={generate}
        />
      )}

      {stage === 'review' && (
        <ReviewStage onBack={() => setStage('params')} onContinue={() => setStage('export')} />
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
function StageBar({ stage }: { stage: Stage }) {
  const steps: { key: Stage; label: string }[] = [
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

function ManualGrid({ rows, onChange, onConfirm }: { rows: InventoryRow[]; onChange: (r: InventoryRow[]) => void; onConfirm: () => void }) {
  function set(i: number, key: keyof InventoryRow, val: string) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)))
  }
  const cols: { key: keyof InventoryRow; label: string }[] = [
    { key: 'location', label: 'Location' }, { key: 'product', label: 'Product' },
    { key: 'on_hand', label: 'On Hand' }, { key: 'daily_usage', label: 'Daily Usage' }, { key: 'leadtime', label: 'Lead Time' },
  ]
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-auto rounded border border-[#2a2d3e]">
        <table className="w-full text-xs font-mono">
          <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide">
            <tr>{cols.map((c) => <th key={c.key} className="px-2 py-2 text-left">{c.label}</th>)}<th /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[#2a2d3e]/50">
                {cols.map((c) => (
                  <td key={c.key} className="px-1 py-1">
                    <input value={String(r[c.key] ?? '')} onChange={(e) => set(i, c.key, e.target.value)}
                      className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-[#00e5ff]" />
                  </td>
                ))}
                <td className="px-2"><button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="text-red-400 hover:text-red-300">×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between">
        <Button size="sm" variant="secondary" onClick={() => onChange([...rows, { location: '', product: '', on_hand: '', daily_usage: '', leadtime: '' }])}>+ Add Row</Button>
        <Button size="sm" onClick={onConfirm}>Continue →</Button>
      </div>
    </div>
  )
}

function ParamsStage({ minRules, onBack, onGenerate }: { minRules: OrderMinRule[]; onBack: () => void; onGenerate: () => void }) {
  const store = useOrderStore()
  const p = store.params
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
            <Input label="Trigger Override" value={p.triggerOverride?.toString() ?? ''} onChange={(e) => store.setParams({ triggerOverride: e.target.value.trim() === '' ? null : Number(e.target.value) })} placeholder="optional" />
            <Input label="Order Limit Override" value={p.limitOverride?.toString() ?? ''} onChange={(e) => store.setParams({ limitOverride: e.target.value.trim() === '' ? null : Number(e.target.value) })} placeholder="optional" />
          </div>
        </CardBody>
      </Card>

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
              <th className="px-3 py-2 text-right">Suggested</th>
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
                <td className="px-3 py-1.5 text-right text-gray-400">{l.suggested_qty}</td>
                <td className="px-3 py-1.5"><Badge color={l.trigger_reason.startsWith('below') || l.trigger_reason.startsWith('projected') ? 'amber' : 'gray'}>{TRIGGER_REASON_LABELS[l.trigger_reason] ?? l.trigger_reason}</Badge></td>
                <td className="px-3 py-1.5 text-gray-500">{l.applied_min_rule ?? '—'}</td>
                <td className="px-3 py-1.5 text-gray-500">{l.unit_of_measure ?? '—'}{l.package_type ? ` · ${l.package_type}` : ''}</td>
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
