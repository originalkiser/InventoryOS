import { useEffect, useState, useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useOrderStore } from '@/stores/orderStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Select, Modal, Input } from '@/components/ui'
import { exportTableToCsv } from '@/hooks/useTable'
import { buildExport, DEFAULT_EXPORT_COLUMNS, type GeneratedLineItem } from '@/lib/orderEngine'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { useLocations } from '@/hooks/useLocations'
import { mappedValue } from '@/lib/columnTransform'
import type { OrderSession, OrderLineItem, OrderDocument, ParsedUpload, ColumnMapping } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface SessionRow extends OrderSession {
  line_count: number
  location_count: number
}

const STATUS_COLOR: Record<string, 'cyan' | 'green' | 'amber' | 'magenta' | 'gray'> = {
  draft: 'gray', generated: 'magenta', exported: 'cyan', pending: 'amber', fulfilled: 'green',
}
const STATUS_OPTIONS = ['draft', 'generated', 'exported', 'pending', 'fulfilled']

const col = createColumnHelper<SessionRow>()

export function OrderHistoryTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myName = profile?.full_name ?? 'Someone'
  const orderStore = useOrderStore()

  const [sessions, setSessions] = useState<OrderSession[]>([])
  const [lineCounts, setLineCounts] = useState<Record<string, { lines: number; locs: number }>>({})
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [detail, setDetail] = useState<OrderSession | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [sessRes, liRes] = await Promise.all([
      sb.schema('inventory').from('order_sessions').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      sb.schema('inventory').from('order_line_items').select('order_session_id, location_id').eq('company_id', companyId),
    ])
    setSessions((sessRes.data ?? []) as OrderSession[])
    const counts: Record<string, { lines: number; locs: Set<string> }> = {}
    for (const li of (liRes.data ?? []) as { order_session_id: string; location_id: string | null }[]) {
      const c = counts[li.order_session_id] ?? { lines: 0, locs: new Set() }
      c.lines += 1
      if (li.location_id) c.locs.add(li.location_id)
      counts[li.order_session_id] = c
    }
    const flat: Record<string, { lines: number; locs: number }> = {}
    for (const [k, v] of Object.entries(counts)) flat[k] = { lines: v.lines, locs: v.locs.size }
    setLineCounts(flat)
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('orders-history-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'order_sessions', filter: `company_id=eq.${companyId}` },
        (payload) => {
          const row: any = payload.new ?? payload.old
          const editor = row?.generation_params?._updated_by_name
          if (editor && editor !== myName) toast(`Order "${row.name ?? 'untitled'}" updated by ${editor}`, { icon: '🧾' })
          load()
        })
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'order_line_items', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load, myName])

  const rows: SessionRow[] = useMemo(() => sessions.map((s) => ({
    ...s,
    line_count: lineCounts[s.id]?.lines ?? 0,
    location_count: lineCounts[s.id]?.locs ?? 0,
  })), [sessions, lineCounts])

  const filtered = rows.filter((r) => !statusFilter || r.status === statusFilter)

  const columns = useMemo(() => [
    col.accessor('name', { header: 'Name', cell: (i) => i.getValue() ?? '(untitled)' }),
    col.accessor('created_at', { header: 'Created', cell: (i) => format(new Date(i.getValue()), 'MMM d, yyyy h:mm a') }),
    col.accessor('location_count', { header: 'Locations' }),
    col.accessor('line_count', { header: 'Lines' }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => <InlineStatusCell session={i.row.original} myName={myName} onUpdate={load} />,
    }),
    col.accessor('source', { header: 'Source', cell: (i) => <Badge color={i.getValue() === 'import' ? 'amber' : 'gray'}>{i.getValue() === 'import' ? 'imported' : 'app'}</Badge> }),
    col.accessor('exported_at', { header: 'Exported', cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—') }),
    col.display({
      id: 'open', header: '',
      cell: (i) => <button onClick={() => setDetail(i.row.original)} className="text-xs font-mono text-inky hover:underline">Open</button>,
    }),
  ], [myName, load])

  const { table, globalFilter, setGlobalFilter } = useTable(filtered, columns)

  const exportRows = useMemo(() => filtered.map((r) => ({
    name: r.name ?? '', created: r.created_at, locations: r.location_count, lines: r.line_count,
    status: r.status, exported_at: r.exported_at ?? '',
  })), [filtered])

  async function updateStatus(s: OrderSession, newStatus: string) {
    const gp = { ...((s.generation_params as Record<string, unknown>) ?? {}), _updated_by_name: myName }
    const { error } = await (supabase as any).schema('inventory').from('order_sessions')
      .update({ status: newStatus, generation_params: gp, updated_at: new Date().toISOString() }).eq('id', s.id)
    if (error) toast.error(error.message)
    else { toast.success(`Status → ${newStatus}`); load() }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-2">
        <div className="w-44">
          <Select label="Filter — Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            options={[{ value: '', label: 'All statuses' }, ...['draft', 'generated', 'exported', 'pending', 'fulfilled'].map((s) => ({ value: s, label: s }))]} />
        </div>
        <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>⬆ Import Order History</Button>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="order_history.csv" exportData={exportRows} loading={loading} />

      {importOpen && <OrderImportModal companyId={companyId} createdBy={profile?.id ?? null} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load() }} />}

      {detail && (
        <OrderDetailModal
          session={detail}
          companyId={companyId}
          myName={myName}
          onClose={() => setDetail(null)}
          onStatusChange={(newStatus) => updateStatus(detail, newStatus)}
          onDuplicate={(lis) => {
            orderStore.reset()
            orderStore.setLineItems(lis)
            orderStore.setSessionName(`${detail.name ?? 'Order'} (copy)`)
            toast.success('Duplicated — open the New Order tab to review & export')
            setDetail(null)
          }}
        />
      )}
    </div>
  )
}

function OrderImportModal({ companyId, createdBy, onClose, onDone }: { companyId: string; createdBy: string | null; onClose: () => void; onDone: () => void }) {
  const loc = useLocations()
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mode, setMode] = useState<'additive' | 'replace'>('additive')
  const [name, setName] = useState('')

  const FIELDS = [
    { name: 'location', label: 'Location', required: true },
    { name: 'product', label: 'Product', required: true },
    { name: 'quantity', label: 'Quantity Ordered', required: true },
    { name: 'order_date', label: 'Order Date', required: false },
    { name: 'expected_delivery', label: 'Expected Delivery', required: false },
  ]

  async function doImport(maps: ColumnMapping[]) {
    const lines = parsed!.rows.map((row) => {
      let location_id: string | null = null, product = '', quantity = 0
      let order_date: string | null = null, expected_delivery: string | null = null
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product') product = v
        else if (m.fieldName === 'quantity') quantity = parseFloat(v.replace(/[$,]/g, '')) || 0
        else if (m.fieldName === 'order_date') order_date = v || null
        else if (m.fieldName === 'expected_delivery') expected_delivery = v || null
      }
      return { location_id, product_id: product, quantity, order_date, expected_delivery }
    }).filter((l) => l.product_id)
    if (!lines.length) { toast.error('No rows to import'); return }
    const msg = mode === 'replace'
      ? `Replace ALL imported order history with ${lines.length} line(s)? This deletes previously-imported orders (app-created orders are kept).`
      : `Add ${lines.length} line(s) as a new imported order?`
    if (!confirm(msg)) return

    const sb = supabase as any
    if (mode === 'replace') {
      const { error: delErr } = await sb.schema('inventory').from('order_sessions').delete().eq('company_id', companyId).eq('source', 'import')
      if (delErr) { toast.error(delErr.message); return }
    }
    const { data: sess, error } = await sb.schema('inventory').from('order_sessions')
      .insert({ company_id: companyId, created_by: createdBy, name: name.trim() || `Imported orders ${new Date().toISOString().slice(0, 10)}`, status: 'fulfilled', source: 'import', source_mode: 'file' })
      .select().single()
    if (error || !sess) { toast.error(error?.message ?? 'Import failed'); return }
    const liRows = lines.map((l) => ({ order_session_id: sess.id, company_id: companyId, location_id: l.location_id, product_id: l.product_id, quantity: l.quantity, order_date: l.order_date, expected_delivery: l.expected_delivery }))
    const { error: liErr } = await sb.schema('inventory').from('order_line_items').insert(liRows)
    if (liErr) { toast.error(liErr.message); return }
    toast.success(`Imported ${liRows.length} line(s)`); onDone()
  }

  return (
    <Modal open onClose={onClose} title="Import Order History" size="lg">
      {!parsed ? (
        <div className="flex flex-col gap-4">
          <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-2">
            <p className="text-xs font-mono text-inky uppercase tracking-wide">Expected columns in your file</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {[
                { col: 'Location', note: 'Location name or code', required: true },
                { col: 'Product', note: 'Product ID or name', required: true },
                { col: 'Quantity Ordered', note: 'Numeric quantity', required: true },
                { col: 'Order Date', note: 'Date the order was placed', required: false },
                { col: 'Expected Delivery', note: 'Anticipated delivery date', required: false },
              ].map(({ col, note, required }) => (
                <div key={col} className="flex items-start gap-1.5">
                  <span className={['text-[10px] font-mono mt-0.5 flex-shrink-0 rounded px-1', required ? 'bg-navy/20 text-navy' : 'bg-inky/10 text-inky/60'].join(' ')}>
                    {required ? 'REQ' : 'OPT'}
                  </span>
                  <div>
                    <span className="text-xs font-mono font-semibold text-navy">{col}</span>
                    <span className="text-xs font-body text-inky/60 ml-1">— {note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <FileUploadZone onParsed={setParsed} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Input label="Import name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. May vendor orders" />
          <div className="flex items-center gap-4">
            <span className="text-xs font-mono text-inky uppercase tracking-wide">Mode</span>
            {(['additive', 'replace'] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 text-xs font-mono text-navy">
                <input type="radio" checked={mode === m} onChange={() => setMode(m)} className="accent-inky" />
                {m === 'additive' ? 'Additive (append)' : 'Replace imported'}
              </label>
            ))}
          </div>
          <ColumnMapper headers={parsed.headers} requiredFields={FIELDS} rememberKey="orders.history" previewRows={parsed.rows.slice(0, 5)} onConfirm={doImport} onCancel={() => setParsed(null)} />
        </div>
      )}
    </Modal>
  )
}

function InlineStatusCell({ session, myName, onUpdate }: { session: SessionRow; myName: string; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleChange(newStatus: string) {
    if (newStatus === session.status) { setEditing(false); return }
    setSaving(true)
    const gp = { ...((session.generation_params as Record<string, unknown>) ?? {}), _updated_by_name: myName }
    const { error } = await (supabase as any).schema('inventory').from('order_sessions')
      .update({ status: newStatus, generation_params: gp, updated_at: new Date().toISOString() }).eq('id', session.id)
    setSaving(false)
    setEditing(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Status → ${newStatus}`)
    onUpdate()
  }

  if (saving) return <Badge color={STATUS_COLOR[session.status] ?? 'gray'}><span className="opacity-60 animate-pulse">{session.status}</span></Badge>
  if (editing) {
    return (
      <select autoFocus defaultValue={session.status}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setEditing(false)}
        className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-xs font-mono text-navy focus:outline-none focus:border-sky"
      >
        {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    )
  }
  return (
    <button onClick={() => setEditing(true)} title="Click to change status">
      <Badge color={STATUS_COLOR[session.status] ?? 'gray'}>{session.status}</Badge>
    </button>
  )
}

function OrderDetailModal({
  session, companyId, myName, onClose, onStatusChange, onDuplicate,
}: {
  session: OrderSession
  companyId: string
  myName: string
  onClose: () => void
  onStatusChange: (newStatus: string) => void
  onDuplicate: (lineItems: GeneratedLineItem[]) => void
}) {
  const [localStatus, setLocalStatus] = useState<string>(session.status)
  const [savingStatus, setSavingStatus] = useState(false)
  const [lines, setLines] = useState<OrderLineItem[]>([])
  const [docs, setDocs] = useState<OrderDocument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const sb = supabase as any
      const [liRes, docRes] = await Promise.all([
        sb.schema('inventory').from('order_line_items').select('*').eq('order_session_id', session.id).order('created_at'),
        sb.schema('inventory').from('order_documents').select('*').eq('order_session_id', session.id).order('created_at'),
      ])
      setLines((liRes.data ?? []) as OrderLineItem[])
      setDocs((docRes.data ?? []) as OrderDocument[])
      setLoading(false)
    })()
  }, [session.id, companyId])

  async function handleStatusChange(newStatus: string) {
    setSavingStatus(true)
    onStatusChange(newStatus)
    setLocalStatus(newStatus)
    setSavingStatus(false)
  }

  function reDownload() {
    const asGen = lines.map((l) => ({
      location_label: l.location_id ?? '',
      product_id: l.product_id,
      vendor_part_number: l.vendor_part_number,
      final_qty: l.final_qty ?? l.quantity ?? 0,
      unit_of_measure: l.unit_of_measure,
      package_type: l.package_type,
      trigger_reason: l.trigger_reason,
      applied_min_rule: l.applied_min_rule,
    }))
    const { headers, rows } = buildExport(asGen as Array<Record<string, unknown>>, DEFAULT_EXPORT_COLUMNS, { excludeZeros: false })
    exportTableToCsv(rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))), `${session.name ?? 'order'}.csv`)
  }

  function duplicate() {
    const asGen: GeneratedLineItem[] = lines.map((l) => ({
      location_id: l.location_id,
      location_label: l.location_id ?? '',
      product_id: l.product_id,
      vendor_part_number: l.vendor_part_number,
      on_hand: null,
      suggested_qty: l.suggested_qty ?? l.quantity ?? 0,
      final_qty: l.final_qty ?? l.quantity ?? 0,
      unit_of_measure: l.unit_of_measure,
      package_type: l.package_type,
      bulk_minimum: null,
      individual_minimum: null,
      applied_min_rule: l.applied_min_rule,
      trigger_reason: l.trigger_reason ?? 'days_supply',
      category: null,
      raw_location: l.location_id ?? '',
      daily_usage: null,
      days_on_hand: null,
      pending_qty: 0,
      order_uom: null,
    }))
    onDuplicate(asGen)
  }

  return (
    <Modal open onClose={onClose} title={session.name ?? 'Order'} size="xl">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap text-xs font-mono text-inky">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wide text-inky/60">Status</span>
            <select
              value={localStatus}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={savingStatus}
              className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky disabled:opacity-60"
            >
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Badge color={STATUS_COLOR[localStatus] ?? 'gray'}>{localStatus}</Badge>
          </div>
          <span>Created {format(new Date(session.created_at), 'MMM d, yyyy h:mm a')}</span>
          {session.exported_at && <span>· Exported {format(new Date(session.exported_at), 'MMM d, yyyy')}</span>}
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={reDownload}>Re-download CSV</Button>
          <Button size="sm" variant="secondary" onClick={duplicate}>Duplicate to New Order</Button>
        </div>

        <div className="max-h-72 overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead className="bg-navy text-inky uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Vendor Part</th>
                <th className="px-3 py-2 text-right">Final Qty</th>
                <th className="px-3 py-2 text-left">UoM</th>
                <th className="px-3 py-2 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-inky">Loading…</td></tr>
              ) : lines.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-inky/70">No line items</td></tr>
              ) : lines.map((l) => (
                <tr key={l.id} className="border-t border-navy/30/50">
                  <td className="px-3 py-1.5 text-navy">{l.product_id}</td>
                  <td className="px-3 py-1.5 text-inky">{l.vendor_part_number ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-navy">{l.final_qty ?? l.quantity ?? 0}</td>
                  <td className="px-3 py-1.5 text-inky">{l.unit_of_measure ?? '—'}</td>
                  <td className="px-3 py-1.5 text-inky">{l.trigger_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Attached Documents ({docs.length})</span>
          {docs.length === 0 ? (
            <span className="text-xs font-mono text-inky/70">None</span>
          ) : docs.map((d) => (
            <span key={d.id} className="text-xs font-mono text-inky">
              <span className={d.stage === 'start' ? 'text-inky' : 'text-green-700'}>[{d.stage}]</span> {d.file_name}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}
