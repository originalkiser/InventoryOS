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
const NEXT_STATUS: Record<string, string | null> = {
  exported: 'pending', pending: 'fulfilled', fulfilled: null,
}

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
      sb.from('order_sessions').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
      sb.from('order_line_items').select('order_session_id, location_id').eq('company_id', companyId),
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_sessions', filter: `company_id=eq.${companyId}` },
        (payload) => {
          const row: any = payload.new ?? payload.old
          const editor = row?.generation_params?._updated_by_name
          if (editor && editor !== myName) toast(`Order "${row.name ?? 'untitled'}" updated by ${editor}`, { icon: '🧾' })
          load()
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_line_items', filter: `company_id=eq.${companyId}` }, () => load())
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
    col.accessor('status', { header: 'Status', cell: (i) => <Badge color={STATUS_COLOR[i.getValue()] ?? 'gray'}>{i.getValue()}</Badge> }),
    col.accessor('source', { header: 'Source', cell: (i) => <Badge color={i.getValue() === 'import' ? 'amber' : 'gray'}>{i.getValue() === 'import' ? 'imported' : 'app'}</Badge> }),
    col.accessor('exported_at', { header: 'Exported', cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—') }),
    col.display({
      id: 'open', header: '',
      cell: (i) => <button onClick={() => setDetail(i.row.original)} className="text-xs font-mono text-[#00e5ff] hover:underline">Open</button>,
    }),
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(filtered, columns)

  const exportRows = useMemo(() => filtered.map((r) => ({
    name: r.name ?? '', created: r.created_at, locations: r.location_count, lines: r.line_count,
    status: r.status, exported_at: r.exported_at ?? '',
  })), [filtered])

  async function advanceStatus(s: OrderSession) {
    const next = NEXT_STATUS[s.status]
    if (!next) return
    const gp = { ...((s.generation_params as Record<string, unknown>) ?? {}), _updated_by_name: myName }
    const { error } = await (supabase as any).from('order_sessions')
      .update({ status: next, generation_params: gp, updated_at: new Date().toISOString() }).eq('id', s.id)
    if (error) toast.error(error.message)
    else { toast.success(`Advanced to ${next}`); setDetail({ ...s, status: next as OrderSession['status'] }); load() }
  }

  if (!companyId) return <div className="text-xs font-mono text-gray-500 py-8">No workspace loaded.</div>

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
          onClose={() => setDetail(null)}
          onAdvance={() => advanceStatus(detail)}
          canAdvance={!!NEXT_STATUS[detail.status]}
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
    { name: 'quantity', label: 'Quantity', required: true },
  ]

  async function doImport(maps: ColumnMapping[]) {
    const lines = parsed!.rows.map((row) => {
      let location_id: string | null = null, product = '', quantity = 0
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product') product = v
        else if (m.fieldName === 'quantity') quantity = parseFloat(v.replace(/[$,]/g, '')) || 0
      }
      return { location_id, product_id: product, quantity }
    }).filter((l) => l.product_id)
    if (!lines.length) { toast.error('No rows to import'); return }
    const msg = mode === 'replace'
      ? `Replace ALL imported order history with ${lines.length} line(s)? This deletes previously-imported orders (app-created orders are kept).`
      : `Add ${lines.length} line(s) as a new imported order?`
    if (!confirm(msg)) return

    const sb = supabase as any
    if (mode === 'replace') {
      const { error: delErr } = await sb.from('order_sessions').delete().eq('company_id', companyId).eq('source', 'import')
      if (delErr) { toast.error(delErr.message); return }
    }
    const { data: sess, error } = await sb.from('order_sessions')
      .insert({ company_id: companyId, created_by: createdBy, name: name.trim() || `Imported orders ${new Date().toISOString().slice(0, 10)}`, status: 'fulfilled', source: 'import', source_mode: 'file' })
      .select().single()
    if (error || !sess) { toast.error(error?.message ?? 'Import failed'); return }
    const liRows = lines.map((l) => ({ order_session_id: sess.id, company_id: companyId, location_id: l.location_id, product_id: l.product_id, quantity: l.quantity }))
    const { error: liErr } = await sb.from('order_line_items').insert(liRows)
    if (liErr) { toast.error(liErr.message); return }
    toast.success(`Imported ${liRows.length} line(s)`); onDone()
  }

  return (
    <Modal open onClose={onClose} title="Import Order History" size="lg">
      {!parsed ? (
        <FileUploadZone onParsed={setParsed} />
      ) : (
        <div className="flex flex-col gap-4">
          <Input label="Import name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. May vendor orders" />
          <div className="flex items-center gap-4">
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Mode</span>
            {(['additive', 'replace'] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 text-xs font-mono text-gray-300">
                <input type="radio" checked={mode === m} onChange={() => setMode(m)} className="accent-[#00e5ff]" />
                {m === 'additive' ? 'Additive (append)' : 'Replace imported'}
              </label>
            ))}
          </div>
          <ColumnMapper headers={parsed.headers} requiredFields={FIELDS} onConfirm={doImport} onCancel={() => setParsed(null)} />
        </div>
      )}
    </Modal>
  )
}

function OrderDetailModal({
  session, companyId, onClose, onAdvance, canAdvance, onDuplicate,
}: {
  session: OrderSession
  companyId: string
  onClose: () => void
  onAdvance: () => void
  canAdvance: boolean
  onDuplicate: (lineItems: GeneratedLineItem[]) => void
}) {
  const [lines, setLines] = useState<OrderLineItem[]>([])
  const [docs, setDocs] = useState<OrderDocument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const sb = supabase as any
      const [liRes, docRes] = await Promise.all([
        sb.from('order_line_items').select('*').eq('order_session_id', session.id).order('created_at'),
        sb.from('order_documents').select('*').eq('order_session_id', session.id).order('created_at'),
      ])
      setLines((liRes.data ?? []) as OrderLineItem[])
      setDocs((docRes.data ?? []) as OrderDocument[])
      setLoading(false)
    })()
  }, [session.id, companyId])

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
      days_on_hand: null,
      pending_qty: 0,
      order_uom: null,
    }))
    onDuplicate(asGen)
  }

  return (
    <Modal open onClose={onClose} title={session.name ?? 'Order'} size="xl">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap text-xs font-mono text-gray-400">
          <Badge color={STATUS_COLOR[session.status] ?? 'gray'}>{session.status}</Badge>
          <span>Created {format(new Date(session.created_at), 'MMM d, yyyy h:mm a')}</span>
          {session.exported_at && <span>· Exported {format(new Date(session.exported_at), 'MMM d, yyyy')}</span>}
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={reDownload}>Re-download CSV</Button>
          <Button size="sm" variant="secondary" onClick={duplicate}>Duplicate to New Order</Button>
          {canAdvance && <Button size="sm" onClick={onAdvance}>Advance Status →</Button>}
        </div>

        <div className="max-h-72 overflow-auto rounded border border-[#2a2d3e]">
          <table className="w-full text-xs font-mono">
            <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide">
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
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">Loading…</td></tr>
              ) : lines.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-600">No line items</td></tr>
              ) : lines.map((l) => (
                <tr key={l.id} className="border-t border-[#2a2d3e]/50">
                  <td className="px-3 py-1.5 text-gray-300">{l.product_id}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.vendor_part_number ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-white">{l.final_qty ?? l.quantity ?? 0}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.unit_of_measure ?? '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.trigger_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-mono text-gray-500 uppercase tracking-wide">Attached Documents ({docs.length})</span>
          {docs.length === 0 ? (
            <span className="text-xs font-mono text-gray-600">None</span>
          ) : docs.map((d) => (
            <span key={d.id} className="text-xs font-mono text-gray-400">
              <span className={d.stage === 'start' ? 'text-[#00e5ff]' : 'text-[#39ff14]'}>[{d.stage}]</span> {d.file_name}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}
