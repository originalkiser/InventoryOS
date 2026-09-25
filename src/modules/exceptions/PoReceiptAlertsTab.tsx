// Late PO Receipt Alerts — direct feedback 2026-09-25: for a purchase order
// from an enabled supplier (RelaDyne to start), flag it once it's gone N
// days past its expected delivery date with NO receipt activity at all.
//
// Deliberately its OWN table (inventory.po_receipt_alerts, migration
// 20260930bn), not a new inventory.exception_reports row type — the
// sidebar's exception badge (useNavBadges.ts) reads that table directly
// with no source/report_type filter, and neither do the Reports/Alerts
// tabs on this page, so a new exception_reports row would both count
// toward the sidebar (explicitly asked NOT to, for now) and show up
// unwanted in those other tabs. A separate table sidesteps both for free.
//
// droptop_purchase_orders/_items are SELECT-only for authenticated users
// (service-role writes only) — there's no server-side job that can create
// these alerts, so they're computed client-side by an explicit "Check Now"
// button, not a background schedule. Once an alert row exists, a later
// Check Now NEVER touches it again — status/notes are fully user-owned
// from creation on, same "never reopen/never overwrite a manual decision"
// principle as the RD Reconciliation feature (rdReconciliation.ts), but
// stricter: that feature still overwrote status/date on every re-run for a
// still-open finding (a real gap noted in that feature's own session
// history) — this never updates an existing row at all, only ever inserts
// new ones for newly-detected late POs.
import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useTable } from '@/hooks/useTable'
import { DataTable } from '@/components/shared/DataTable'
import { Button, SbLoader, Modal, Input, Toggle } from '@/components/ui'
import { EditSelect, EditText } from '@/components/shared/InlineCells'
import { parseWeekday } from '@/lib/orderDay'
import { nextDeliveryDate, daysBetween } from '@/modules/orders-v2/engine'
import { EXCEPTION_STATUSES, DEFAULT_STATUS, type ExceptionConfig } from './exceptions'
import { PoAlertEmailModal } from './PoAlertEmailModal'
import { PO_ALERT_EMAIL_DEFAULT, PO_ALERT_EMAIL_TOKENS, type PoAlertEmailTemplate } from './poAlertEmail'
import { format } from 'date-fns'

interface PoReceiptAlert {
  id: string
  company_id: string
  location_id: string | null
  po_id: string
  custom_po_id: string | null
  supplier_name: string | null
  po_created_at: string | null
  expected_delivery_date: string | null
  days_late: number | null
  status: string
  notes: string | null
  excluded: boolean
  exception_report_id: string | null
  emailed_at: string | null
  created_at: string
  updated_at: string
}

const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d.length > 10 ? d : `${d}T00:00:00`), 'MMM d, yyyy') } catch { return d } }
const todayIso = () => format(new Date(), 'yyyy-MM-dd')

export function PoReceiptAlertsTab({ config }: { config: ExceptionConfig }) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { data, loading, refresh, update, bulkPatch, removeMany } = useConfigTab<PoReceiptAlert>('po_receipt_alerts', 'inventory')
  const [checking, setChecking] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [clearSelectionToken, setClearSelectionToken] = useState(0)
  const [showExcluded, setShowExcluded] = useState(false)
  const visibleRows = useMemo(() => (showExcluded ? data : data.filter((r) => !r.excluded)), [data, showExcluded])

  // Email workflow — direct feedback 2026-09-25: mirrors Tank Monitors' own
  // offline/low-VMI email flow, see PoAlertEmailModal.tsx's own header
  // comment for the 4-action-per-alert design and why it differs from that.
  const [emailTpl, saveEmailTpl] = useAppSetting<PoAlertEmailTemplate>('po_alert_email_tpl', PO_ALERT_EMAIL_DEFAULT)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [bulkCloseDays, setBulkCloseDays] = useState(60)

  async function bulkCloseOld() {
    const targets = visibleRows.filter((r) => !r.status.toLowerCase().includes('closed') && (r.days_late ?? 0) >= bulkCloseDays)
    if (!targets.length) { toast.error(`No open alerts at least ${bulkCloseDays} days late`); return }
    if (!confirm(`Close ${targets.length} alert(s) at least ${bulkCloseDays} days late as "no receipt", without emailing?`)) return
    const ok = await bulkPatch(targets.map((r) => ({ id: r.id, status: 'Closed', notes: r.notes || 'Closed — no receipt confirmed (too old to pursue further)' })))
    if (ok) setClearSelectionToken((t) => t + 1)
  }

  const shopLabel = (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : '') || '—'

  const enabledSuppliers = useMemo(
    () => Object.entries(config.poAlertSuppliers).filter(([, v]) => v).map(([k]) => k),
    [config.poAlertSuppliers],
  )

  async function checkNow() {
    if (!companyId) return
    if (!enabledSuppliers.length) { toast.error('No suppliers enabled — turn one on in Settings first'); return }
    setChecking(true)
    try {
      const sb = supabase as any
      // Explicit column list — droptop_purchase_orders also carries a
      // raw_data jsonb column that's ~98x more expensive to select and
      // never read here (see PoStatusPage.tsx's own EXPLAIN ANALYZE finding).
      const POL_COLUMNS = 'id, location_id, po_id, custom_po_id, supplier_name, created_timestamp, to_receive_timestamp'
      const pos: any[] = []
      const PAGE = 8000
      for (let from = 0; ; from += PAGE) {
        const { data: batch, error } = await sb.schema('inventory').from('droptop_purchase_orders')
          .select(POL_COLUMNS)
          .eq('company_id', companyId)
          .in('supplier_name', enabledSuppliers)
          .in('po_status', ['draft', 'sent', 'accepted']) // still open — a closed/cancelled PO is done, not "late"
          .range(from, from + PAGE - 1)
        if (error) throw error
        pos.push(...(batch ?? []))
        if (!batch || batch.length === 0) break
      }
      if (!pos.length) { toast(`No open POs found for ${enabledSuppliers.join(', ')}`, { icon: 'ℹ️' }); return }

      // Any receipt activity at all on any line item disqualifies a PO from
      // this alert — "no receipt activity", not "not fully received".
      const itemsByPo = new Map<string, boolean>()
      const CHUNK = 200
      const poIds = pos.map((p) => p.id)
      for (let i = 0; i < poIds.length; i += CHUNK) {
        const chunk = poIds.slice(i, i + CHUNK)
        const { data: items, error } = await sb.schema('inventory').from('droptop_purchase_order_items')
          .select('purchase_order_id, received_quantity')
          .in('purchase_order_id', chunk)
        if (error) throw error
        for (const it of (items ?? [])) {
          if (Number(it.received_quantity ?? 0) > 0) itemsByPo.set(it.purchase_order_id, true)
        }
      }

      const existingKeys = new Set(data.map((a) => `${a.location_id ?? ''}|${a.po_id}`))
      const today = todayIso()
      const newAlerts: Record<string, unknown>[] = []
      let skippedNoDate = 0

      for (const po of pos) {
        if (itemsByPo.get(po.id)) continue // has receipt activity — not late
        const key = `${po.location_id ?? ''}|${po.po_id}`
        if (existingKeys.has(key)) continue // already alerted — never re-touch

        // to_receive_timestamp, when a shop actually set it, is a real
        // explicit expected-receive date and wins outright. Otherwise fall
        // back to the same "next RelaDyne delivery day after the order was
        // placed" computation Orders v2 itself uses everywhere (see
        // OrdersV2FinalReview.tsx's own deliveryDowOf) — created_timestamp
        // stands in for "order date" since a raw Droptop PO has no other
        // notion of one.
        let expected: string | null = null
        if (po.to_receive_timestamp) {
          expected = format(new Date(po.to_receive_timestamp), 'yyyy-MM-dd')
        } else if (po.created_timestamp) {
          const createdIso = format(new Date(po.created_timestamp), 'yyyy-MM-dd')
          const dow = parseWeekday(loc.byId(po.location_id)?.reladyne_delivery_day as string | undefined)
          expected = nextDeliveryDate(createdIso, dow)
        }
        if (!expected) { skippedNoDate++; continue } // can't compute — never guess

        const daysLate = daysBetween(expected, today)
        const threshold = config.poAlertDaysThreshold[po.supplier_name] ?? config.poAlertDaysThresholdDefault
        if (daysLate < threshold) continue

        newAlerts.push({
          company_id: companyId, location_id: po.location_id, po_id: po.po_id, custom_po_id: po.custom_po_id,
          supplier_name: po.supplier_name, po_created_at: po.created_timestamp,
          expected_delivery_date: expected, days_late: daysLate,
          status: DEFAULT_STATUS, notes: null,
          updated_by: profile?.id ?? null, last_change_source: 'auto',
        })
      }

      if (!newAlerts.length) {
        toast.success(`No new late-receipt alerts${skippedNoDate ? ` (${skippedNoDate} PO(s) had no computable delivery day)` : ''}`)
        return
      }
      const { error } = await sb.schema('inventory').from('po_receipt_alerts').insert(newAlerts)
      if (error) throw error
      toast.success(`Created ${newAlerts.length} new alert${newAlerts.length !== 1 ? 's' : ''}`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  async function closeSelected() {
    if (!selectedIds.size) return
    const rows = data.filter((r) => selectedIds.has(r.id)).map((r) => ({ id: r.id, status: 'Closed' }))
    const ok = await bulkPatch(rows)
    if (ok) setClearSelectionToken((t) => t + 1)
  }

  const col = useMemo(() => createColumnHelper<PoReceiptAlert>(), [])
  const columns = useMemo(() => [
    col.accessor((r) => shopLabel(r.location_id), { id: 'shop', header: 'Shop' }),
    col.accessor('supplier_name', { header: 'Supplier', cell: (i) => i.getValue() ?? '—' }),
    col.accessor((r) => r.custom_po_id || r.po_id, { id: 'po_number', header: 'PO #' }),
    col.accessor('expected_delivery_date', { header: 'Expected Delivery', cell: (i) => dShort(i.getValue()) }),
    // Recomputed live against today, not the frozen value from whenever the
    // alert was first raised — the stored days_late column is left as-is,
    // it's a "how late was it when flagged" record, not a live counter.
    col.accessor((r) => (r.expected_delivery_date ? daysBetween(r.expected_delivery_date, todayIso()) : r.days_late ?? 0), {
      id: 'days_late', header: 'Days Late', cell: (i) => <div className="text-right font-bold text-[#C0392B]">{i.getValue()}</div>,
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => <EditSelect value={i.getValue()} options={[...EXCEPTION_STATUSES]} onSave={(v) => update(i.row.original.id, { status: v ?? DEFAULT_STATUS })} />,
    }),
    col.accessor('notes', {
      header: 'Notes',
      cell: (i) => <EditText value={i.getValue()} onSave={(v) => update(i.row.original.id, { notes: v })} placeholder="Add a note…" />,
    }),
    col.accessor('excluded', {
      header: 'Excluded', cell: (i) => i.getValue() ? <span className="text-inky/50">Yes</span> : '—',
    }),
    col.accessor('created_at', { header: 'Flagged', cell: (i) => dShort(i.getValue()) }),
  ], [col, loc, update])

  const { table, globalFilter, setGlobalFilter } = useTable(visibleRows, columns)

  const selectedAlerts = useMemo(() => data.filter((r) => selectedIds.has(r.id)), [data, selectedIds])

  if (!companyId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-body text-inky">
          Open purchase orders ({enabledSuppliers.length ? enabledSuppliers.map((s) => `${s} (${config.poAlertDaysThreshold[s] ?? config.poAlertDaysThresholdDefault}d)`).join(', ') : 'no supplier enabled'})
          with no receipt activity past their own supplier's day threshold, checked against the expected delivery
          date. Turn suppliers on/off and set each one's threshold in Settings. These alerts don't count toward the
          sidebar badge.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={() => setTemplateModalOpen(true)}>Edit Email Template</Button>
          <Button size="sm" loading={checking} onClick={() => void checkNow()}>Check Now</Button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap rounded border border-navy/15 bg-navy/[0.03] px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy">
          <Toggle checked={showExcluded} onChange={setShowExcluded} size="sm" color="cyan" />
          Show excluded
        </label>
        <span className="text-inky/30">|</span>
        <span className="text-[11px] font-mono text-inky/70">
          Some old POs aren't worth emailing about — close them out directly:
        </span>
        <input type="number" min={1} value={bulkCloseDays} onChange={(e) => setBulkCloseDays(Math.max(1, Number(e.target.value) || 1))}
          className="w-14 bg-cream border border-navy/30 rounded px-1 py-0.5 text-center text-[11px] font-mono" />
        <span className="text-[11px] font-mono text-inky/70">+ days late</span>
        <Button size="sm" variant="secondary" onClick={() => void bulkCloseOld()}>Close (No Receipt)</Button>
      </div>

      {loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
      ) : (
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename="Late PO Receipt Alerts"
          onSelectionChange={setSelectedIds}
          clearSelectionToken={clearSelectionToken}
          onBulkDelete={removeMany}
          bulkDeleteNoun="alert"
          actions={selectedIds.size > 0 ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEmailModalOpen(true)}>Email {selectedIds.size} Selected</Button>
              <Button size="sm" variant="secondary" onClick={() => void closeSelected()}>Mark {selectedIds.size} Closed</Button>
            </div>
          ) : undefined}
        />
      )}

      <PoAlertEmailModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        alerts={selectedAlerts}
        template={emailTpl}
        onChanged={() => { refresh(); setClearSelectionToken((t) => t + 1) }}
      />

      <Modal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title="Late PO Receipt Email Template" size="lg">
        <PoAlertTemplateEditor tpl={emailTpl} onSave={(t) => { saveEmailTpl(t); toast.success('Template saved') }} />
      </Modal>
    </div>
  )
}

function PoAlertTemplateEditor({ tpl, onSave }: { tpl: PoAlertEmailTemplate; onSave: (t: PoAlertEmailTemplate) => void }) {
  const [subject, setSubject] = useState(tpl.subject)
  const [to, setTo] = useState(tpl.to)
  const [body, setBody] = useState(tpl.body)
  const dirty = subject !== tpl.subject || to !== tpl.to || body !== tpl.body

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-mono text-inky/60">
        Insert data fields with the tokens below — they're replaced per shop when a draft is generated.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {PO_ALERT_EMAIL_TOKENS.map((t) => (
          <span key={t.token} className="inline-flex items-center gap-1 rounded border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-navy" title={t.label}>
            {`{{${t.token}}}`}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div>
        <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Body</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
          className="w-full bg-cream dark:bg-[#0e2638] border border-navy/40 rounded px-3 py-2 text-sm font-mono text-navy dark:text-[#F2F1E6] focus:outline-none focus:ring-2 focus:ring-sky resize-y" />
      </div>
      <div className="flex items-center justify-end gap-2">
        {dirty && <span className="text-[10px] font-mono text-[#E67E22]">unsaved</span>}
        <Button size="sm" disabled={!dirty} onClick={() => onSave({ subject, to, body })}>Save</Button>
      </div>
    </div>
  )
}
