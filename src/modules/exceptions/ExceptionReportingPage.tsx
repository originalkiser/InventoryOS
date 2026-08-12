import { useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useConfigTab, type ImportMode } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Card, CardBody, Tabs, TabsList, TabsTrigger, TabsContent, SbLoader } from '@/components/ui'
import { mappedValue } from '@/lib/columnTransform'
import { applyTransforms } from '@/lib/transforms'
import type { ColumnMapping } from '@/types'
import {
  EXCEPTION_STATUSES, parseContacted, isYesResponse, responseState,
  type ExceptionReport, type ExceptionConfig,
} from './exceptions'
import { useExceptionConfig } from './useExceptionConfig'
import { ExceptionReportModal } from './ExceptionReportModal'
import { format } from 'date-fns'

const toDate = (v: string) => applyTransforms(v, [{ kind: 'date' }]) || null
const stripHtml = (s: string | null) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '')
const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }
const inputCls = 'bg-cream border border-navy/30 rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky'

const UPLOAD_FIELDS = [
  { name: 'shop', label: 'Shop', required: true },
  { name: 'date_of_finding', label: 'Date of Finding' },
  { name: 'date_of_shop_action', label: 'Date of Shop Action' },
  { name: 'area_manager', label: 'Area Manager' },
  { name: 'report_type', label: 'Exception Report (Type)' },
  { name: 'issue', label: 'Issue' },
  { name: 'details', label: 'Details' },
  { name: 'contacted', label: 'Contacted?' },
  { name: 'response', label: 'Response?' },
  { name: 'rd_if_no', label: 'RD if No' },
  { name: 'response_notes', label: 'Response Notes' },
]

export function ExceptionReportingPage() {
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<ExceptionReport>('exception_reports', 'inventory')
  const loc = useLocations()
  const { config, save: saveConfig } = useExceptionConfig()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<ExceptionReport> | null>(null)
  const [importing, setImporting] = useState(false)
  const [statusFilter, setStatusFilter] = useState('All')
  const [more, setMore] = useState<{ row: ExceptionReport; field: 'details' | 'response_notes'; label: string } | null>(null)

  // Shop label without the doubled location number (shop_city already includes it).
  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'
  const set = (r: ExceptionReport, patch: Partial<ExceptionReport>) => update(r.id, patch)

  function openAdd() { setEditing(null); setModalOpen(true) }
  function openEdit(r: ExceptionReport) { setEditing(r); setModalOpen(true) }

  // Status chips present in the data (+ All), with counts.
  const statusChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of data) { const s = r.status || 'No Status'; counts.set(s, (counts.get(s) ?? 0) + 1) }
    const present = [...counts.keys()].sort((a, b) => EXCEPTION_STATUSES.indexOf(a as any) - EXCEPTION_STATUSES.indexOf(b as any))
    return [{ key: 'All', count: data.length }, ...present.map((s) => ({ key: s, count: counts.get(s)! }))]
  }, [data])

  const rows = useMemo(() => {
    if (statusFilter === 'All') return data
    return data.filter((r) => (r.status || 'No Status') === statusFilter)
  }, [data, statusFilter])

  async function handleImport(inRows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = inRows.map((row) => {
      let location_id: string | null = null, area_manager: string | null = null
      let date_of_finding: string | null = null, date_of_shop_action: string | null = null
      let report_type: string | null = null, issue: string | null = null, details: string | null = null
      let contactedRaw = '', response: string | null = null, rd_if_no: string | null = null, response_notes: string | null = null
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        switch (m.fieldName) {
          case 'shop': location_id = loc.resolveId(v); break
          case 'area_manager': area_manager = v.trim() || null; break
          case 'date_of_finding': date_of_finding = toDate(v); break
          case 'date_of_shop_action': date_of_shop_action = toDate(v); break
          case 'report_type': report_type = v.trim() || null; break
          case 'issue': issue = v.trim() || null; break
          case 'details': details = v.trim() || null; break
          case 'contacted': contactedRaw = v; break
          case 'response': response = v.trim() || null; break
          case 'rd_if_no': rd_if_no = v.trim() || null; break
          case 'response_notes': response_notes = v.trim() || null; break
        }
      }
      const yr = date_of_finding ? Number(date_of_finding.slice(0, 4)) : new Date().getFullYear()
      const { contacted, contacted_date } = parseContacted(contactedRaw, yr)
      return { location_id, area_manager, date_of_finding, date_of_shop_action, report_type, issue, details, contacted, contacted_date, response, rd_if_no, response_notes } as Partial<ExceptionReport>
    }).filter((r) => r.location_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.date_of_finding ?? ''}|${r.report_type ?? ''}|${r.issue ?? ''}|${r.details ?? ''}` })
    setImporting(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Exception Reporting</h1>
        <p className="text-xs text-inky mt-0.5">Inventory findings (PO match, activity, on-hand). Every cell is editable inline; use the pencil for full detail.</p>
      </div>

      <Tabs defaultValue="reports">
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="reports">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-1 flex-wrap">
              {statusChips.map((c) => (
                <button key={c.key} onClick={() => setStatusFilter(c.key)}
                  className={['px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors',
                    statusFilter === c.key ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
                  {c.key} <span className="opacity-70">{c.count}</span>
                </button>
              ))}
            </div>
            <Button size="sm" onClick={openAdd}>+ Add</Button>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : (
            <ExceptionTable rows={rows} config={config} shopLabel={shopLabel} onSet={set} onEdit={openEdit} onMore={(row, field, label) => setMore({ row, field, label })} />
          )}
        </TabsContent>

        <TabsContent value="summary">
          <SummaryView data={data} config={config} />
        </TabsContent>

        <TabsContent value="settings">
          <SettingsView config={config} saveConfig={saveConfig} onImport={handleImport} importing={importing} clearAll={clearAll} />
        </TabsContent>
      </Tabs>

      {/* Full-content editor for long text cells */}
      {more && (
        <MoreEditor label={more.label} value={stripHtml((more.row as any)[more.field])}
          onClose={() => setMore(null)}
          onSave={(v) => { update(more.row.id, { [more.field]: v.trim() || null } as Partial<ExceptionReport>); setMore(null) }} />
      )}

      <ExceptionReportModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSubmit={async (fields, id) => { if (id) await update(id, fields); else await insert(fields) }}
        onDelete={(id) => remove(id)} />
    </div>
  )
}

// ── Inline-editable table ────────────────────────────────────────────────────
function ExceptionTable({ rows, config, shopLabel, onSet, onEdit, onMore }: {
  rows: ExceptionReport[]
  config: ExceptionConfig
  shopLabel: (id: string | null) => string
  onSet: (r: ExceptionReport, patch: Partial<ExceptionReport>) => void
  onEdit: (r: ExceptionReport) => void
  onMore: (row: ExceptionReport, field: 'details' | 'response_notes', label: string) => void
}) {
  const stickyStatus = 'sticky left-0 z-10 bg-cream'
  const stickyShop = 'sticky left-[230px] z-10 bg-cream'
  const th = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30'
  const td = 'px-2 py-1 align-top border-b border-navy/15 whitespace-nowrap'

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No exception reports for this filter.</p>

  return (
    <div className="overflow-x-auto rounded border border-navy/30">
      <table className="text-xs font-mono border-collapse">
        <thead>
          <tr className="bg-cream">
            <th className={`${th} ${stickyStatus} w-[230px] min-w-[230px]`}>Status</th>
            <th className={`${th} ${stickyShop}`}>Shop</th>
            <th className={th}>Finding</th>
            <th className={th}>Area Manager</th>
            <th className={th}>Type</th>
            <th className={th}>Issue</th>
            <th className={th}>Details</th>
            <th className={th}>Contacted</th>
            <th className={th}>Response</th>
            <th className={th}>Regional Director</th>
            <th className={th}>Response Notes</th>
            <th className={th}>Shop Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rs = responseState(r, config.responseDays)
            const issueOpts = config.issues[r.report_type ?? ''] ?? []
            return (
              <tr key={r.id} className="hover:bg-navy/[0.02]">
                <td className={`${td} ${stickyStatus} w-[230px] min-w-[230px]`}>
                  <div className="flex items-center gap-1">
                    <button onClick={() => onEdit(r)} title="Full edit" className="text-inky hover:text-navy flex-shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
                    <EditSelect value={r.status} options={EXCEPTION_STATUSES as unknown as string[]} placeholder="—" onSave={(v) => onSet(r, { status: v })} className="min-w-[180px]" />
                  </div>
                </td>
                <td className={`${td} ${stickyShop}`}>
                  <select value={r.location_id ?? ''} onChange={() => { /* shop change via pencil modal */ }} disabled
                    className={`${inputCls} max-w-[16rem] opacity-100 disabled:opacity-100 cursor-default`} title={shopLabel(r.location_id)}>
                    <option>{shopLabel(r.location_id)}</option>
                  </select>
                </td>
                <td className={td}><EditDate value={r.date_of_finding} onSave={(v) => onSet(r, { date_of_finding: v })} /></td>
                <td className={td}><EditText value={r.area_manager} onSave={(v) => onSet(r, { area_manager: v })} /></td>
                <td className={td}><EditSelect value={r.report_type} options={config.types} placeholder="—" onSave={(v) => onSet(r, { report_type: v })} /></td>
                <td className={td}><EditSelect value={r.issue} options={issueOpts} placeholder="—" allowCurrent onSave={(v) => onSet(r, { issue: v })} /></td>
                <td className={`${td} whitespace-normal`}><MoreCell text={stripHtml(r.details)} onMore={() => onMore(r, 'details', 'Details')} /></td>
                <td className={td}>
                  <div className="flex items-center gap-1">
                    <input type="checkbox" checked={r.contacted} onChange={(e) => onSet(r, { contacted: e.target.checked })} className="accent-sky" />
                    {r.contacted && <EditDate value={r.contacted_date} onSave={(v) => onSet(r, { contacted_date: v })} />}
                  </div>
                </td>
                <td className={td}>
                  <div className="flex flex-col gap-0.5">
                    <EditText value={r.response} onSave={(v) => onSet(r, { response: v })} placeholder="yes / no" />
                    {!isYesResponse(r.response) && <span className={rs === 'no' ? 'text-[10px] text-[#C0392B]' : 'text-[10px] text-inky/50'}>{rs === 'no' ? 'no response' : 'awaiting'}</span>}
                  </div>
                </td>
                <td className={td}><EditText value={r.rd_if_no} onSave={(v) => onSet(r, { rd_if_no: v })} placeholder="RD name" /></td>
                <td className={`${td} whitespace-normal`}><MoreCell text={stripHtml(r.response_notes)} onMore={() => onMore(r, 'response_notes', 'Response Notes')} /></td>
                <td className={td}><EditDate value={r.date_of_shop_action} onSave={(v) => onSet(r, { date_of_shop_action: v })} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function EditText({ value, onSave, placeholder, className = '' }: { value: string | null; onSave: (v: string | null) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value ?? '')
  // Reset to the row's value on focus so edits always start from the latest saved state.
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onFocus={() => setV(value ?? '')}
      onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
      placeholder={placeholder} className={`${inputCls} ${className}`} />
  )
}

function EditDate({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  return <input type="date" value={value ?? ''} onChange={(e) => onSave(e.target.value || null)} className={inputCls} />
}

function EditSelect({ value, options, onSave, placeholder, allowCurrent, className = '' }: {
  value: string | null; options: string[]; onSave: (v: string | null) => void; placeholder?: string; allowCurrent?: boolean; className?: string
}) {
  const opts = allowCurrent && value && !options.includes(value) ? [value, ...options] : options
  return (
    <select value={value ?? ''} onChange={(e) => onSave(e.target.value || null)} className={`${inputCls} ${className}`}>
      <option value="">{placeholder ?? '—'}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function MoreCell({ text, onMore }: { text: string; onMore: () => void }) {
  return (
    <div className="max-w-[18rem]">
      <span className="block line-clamp-2 text-navy">{text || '—'}</span>
      {text && text.length > 60 && <button onClick={onMore} className="text-[10px] font-mono text-sky hover:underline">More</button>}
    </div>
  )
}

function MoreEditor({ label, value, onClose, onSave }: { label: string; value: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-cream rounded-lg border border-navy/40 shadow-xl w-full max-w-xl p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xs font-mono uppercase tracking-wide text-inky mb-2">{label}</h3>
        <textarea value={v} onChange={(e) => setV(e.target.value)} rows={8} autoFocus
          className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => onSave(v)}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────
function mode(arr: string[]): string | null {
  if (!arr.length) return null
  const m = new Map<string, number>(); let best = '', bc = 0
  for (const a of arr) { const c = (m.get(a) ?? 0) + 1; m.set(a, c); if (c > bc) { bc = c; best = a } }
  return best
}
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0)

function SummaryView({ data, config }: { data: ExceptionReport[]; config: ExceptionConfig }) {
  const s = useMemo(() => {
    const contactedRows = data.filter((r) => r.contacted)
    const yesOf = (rows: ExceptionReport[]) => rows.filter((r) => isYesResponse(r.response)).length
    const noRD = contactedRows.filter((r) => !r.rd_if_no)
    const withRD = contactedRows.filter((r) => !!r.rd_if_no)
    const perType = config.types.map((t) => ({ type: t, count: data.filter((r) => r.report_type === t).length, topIssue: mode(data.filter((r) => r.report_type === t && r.issue).map((r) => r.issue!)) }))
    const times = data
      .filter((r) => r.date_of_finding && r.date_of_shop_action && isYesResponse(r.response))
      .map((r) => (new Date(r.date_of_shop_action! + 'T00:00:00').getTime() - new Date(r.date_of_finding! + 'T00:00:00').getTime()) / 86400000)
      .filter((d) => d >= 0)
    return {
      total: data.length,
      shopsContacted: new Set(contactedRows.map((r) => r.location_id)).size,
      perType,
      rateOverall: pct(yesOf(contactedRows), contactedRows.length),
      rateNoRD: pct(yesOf(noRD), noRD.length),
      rateRD: pct(yesOf(withRD), withRD.length),
      avgTime: times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '—',
    }
  }, [data, config])

  const responded = data.filter((r) => r.contacted).filter((r) => !isYesResponse(r.response) && responseState(r, config.responseDays) === 'no')

  const Tile =({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <Card><CardBody className="py-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label}</div>
      <div className="text-2xl font-heading font-bold text-navy">{value}</div>
      {sub && <div className="text-[10px] font-mono text-inky/60 mt-0.5">{sub}</div>}
    </CardBody></Card>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Total Exceptions" value={s.total} />
        <Tile label="Shops Contacted" value={s.shopsContacted} />
        <Tile label="Response Rate" value={`${s.rateOverall}%`} sub="of contacted" />
        <Tile label="Avg Response Time" value={s.avgTime === '—' ? '—' : `${s.avgTime}d`} sub="finding → shop action" />
        <Tile label="Rate — no RD added" value={`${s.rateNoRD}%`} />
        <Tile label="Rate — after RD added" value={`${s.rateRD}%`} />
        <Tile label="Overdue (no response)" value={responded.length} sub={`> ${config.responseDays} days`} />
      </div>

      <Card><CardBody>
        <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2">By Type</div>
        <table className="w-full text-xs font-mono">
          <thead><tr className="text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="text-left px-2 py-1">Type</th><th className="text-right px-2 py-1">Count</th><th className="text-left px-2 py-1">Most Common Issue</th>
          </tr></thead>
          <tbody>
            {s.perType.map((t) => (
              <tr key={t.type} className="border-b border-navy/15">
                <td className="px-2 py-1 text-navy">{t.type}</td>
                <td className="px-2 py-1 text-right text-navy">{t.count}</td>
                <td className="px-2 py-1 text-navy">{t.topIssue ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody></Card>
    </div>
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────
function SettingsView({ config, saveConfig, onImport, importing, clearAll }: {
  config: ExceptionConfig
  saveConfig: (c: ExceptionConfig) => void
  onImport: (rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) => Promise<void>
  importing: boolean
  clearAll: () => Promise<void>
}) {
  const [newType, setNewType] = useState('')
  const [newIssue, setNewIssue] = useState<Record<string, string>>({})

  const addType = () => { const t = newType.trim(); if (!t || config.types.includes(t)) return; saveConfig({ ...config, types: [...config.types, t], issues: { ...config.issues, [t]: config.issues[t] ?? [] } }); setNewType('') }
  const removeType = (t: string) => saveConfig({ ...config, types: config.types.filter((x) => x !== t) })
  const addIssue = (t: string) => { const v = (newIssue[t] ?? '').trim(); if (!v) return; const cur = config.issues[t] ?? []; if (cur.includes(v)) return; saveConfig({ ...config, issues: { ...config.issues, [t]: [...cur, v] } }); setNewIssue((p) => ({ ...p, [t]: '' })) }
  const removeIssue = (t: string, v: string) => saveConfig({ ...config, issues: { ...config.issues, [t]: (config.issues[t] ?? []).filter((x) => x !== v) } })

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Response Window</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-body text-inky">Auto-flag "no response" after</span>
          <input type="number" min={1} value={config.responseDays}
            onChange={(e) => saveConfig({ ...config, responseDays: Math.max(1, Number(e.target.value) || 1) })}
            className={`${inputCls} w-16`} />
          <span className="text-xs font-body text-inky">days without a yes response.</span>
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Report Types & Issues</h3>
        <div className="flex items-center gap-2">
          <Input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="New report type" className="max-w-xs" />
          <Button size="sm" onClick={addType}>Add Type</Button>
        </div>
        {config.types.map((t) => (
          <div key={t} className="rounded border border-navy/20 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-navy uppercase tracking-wide">{t}</span>
              <button onClick={() => removeType(t)} className="text-[11px] font-mono text-red-400 hover:underline">Remove type</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(config.issues[t] ?? []).map((v) => (
                <span key={v} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-[11px] font-mono text-navy">
                  {v}<button onClick={() => removeIssue(t, v)} className="text-inky/50 hover:text-red-500">×</button>
                </span>
              ))}
              {(config.issues[t] ?? []).length === 0 && <span className="text-[11px] font-mono text-inky/40 italic">No issues yet</span>}
            </div>
            <div className="flex items-center gap-2">
              <input value={newIssue[t] ?? ''} onChange={(e) => setNewIssue((p) => ({ ...p, [t]: e.target.value }))} placeholder="Add issue…" className={`${inputCls} flex-1 max-w-xs`} />
              <Button size="sm" variant="secondary" onClick={() => addIssue(t)}>Add</Button>
            </div>
          </div>
        ))}
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Upload Exception Report File</h3>
        <p className="text-[11px] font-mono text-inky/60">Columns: Shop, Date of Finding, Exception Report (type), Issue, Details, Contacted?, Response?, RD if No, Response Notes.</p>
        <ConfigUpload requiredFields={UPLOAD_FIELDS} onImport={onImport} importing={importing} />
      </CardBody></Card>

      <Card><CardBody className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Danger Zone</h3>
          <p className="text-[11px] font-mono text-inky/60">Remove all exception report rows for this company.</p>
        </div>
        <ClearTableButton clearAll={clearAll} />
      </CardBody></Card>
    </div>
  )
}
