// Late PO Receipt Alerts email workflow — mirrors Tank Monitors' own
// offline/low-VMI email flow (src/modules/locations/TankEmailModal.tsx)
// almost exactly: step through shops one at a time, a copyable To/Subject/
// Body the user pastes into Outlook by hand (nothing is actually sent from
// here), Skip to move on with no write. The one real difference: Tank
// Monitors only ever has one action (Log & Next); a late-PO alert needs 4
// per-PO outcomes, since "skip this email" and "resolve this alert" aren't
// the same decision here — a shop can have more than one late PO in the
// same step, each needing its own call:
//   - Log Exception: creates a real inventory.exception_reports row (same
//     'PO Match'/'Missing Receipt' shape the RD Reconciliation feature
//     already uses) and links it back via exception_report_id, so it's
//     tracked through the normal Exception Reporting workflow from here on.
//   - Exclude: excluded=true — hides it from the default alert view without
//     closing or deleting it (e.g. "already being handled some other way").
//   - Close (No Receipt): status='Closed' with a stamped note — for a PO
//     old enough that chasing it further isn't worth it.
//   - Skip: no write at all, just moves past it for this pass.
// A shop's step only advances once every alert in that shop's group has
// been acted on (or the user clicks "Skip Shop", which skips all of them).
import { useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Modal, Button } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import { DEFAULT_STATUS } from './exceptions'
import {
  type PoAlertEmailTemplate, type TableCol, type TableRow,
  renderText, renderBodyHtml, renderBodyPlain, tableHtml, tablePlain, pluralizeParens, greetingFor,
} from './poAlertEmail'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

export interface PoAlertForEmail {
  id: string
  location_id: string | null
  po_id: string
  custom_po_id: string | null
  supplier_name: string | null
  expected_delivery_date: string | null
  days_late: number | null
}

interface Props {
  open: boolean
  onClose: () => void
  alerts: PoAlertForEmail[]
  template: PoAlertEmailTemplate
  onChanged?: () => void
}

const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(`${d}T00:00:00`), 'MMM d, yyyy') } catch { return d } }

export function PoAlertEmailModal({ open, onClose, alerts, template, onChanged }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [idx, setIdx] = useState(0)
  const [handledIds, setHandledIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Group by shop, in a stable order — a shop's step includes every alert
  // for it that hasn't been handled yet in this session.
  const groups = useMemo(() => {
    const byLoc = new Map<string, PoAlertForEmail[]>()
    for (const a of alerts) {
      const key = a.location_id ?? ''
      if (!byLoc.has(key)) byLoc.set(key, [])
      byLoc.get(key)!.push(a)
    }
    return [...byLoc.entries()].map(([locationId, list]) => ({ locationId, alerts: list }))
      .sort((a, b) => (loc.fieldValue(a.locationId, 'shop_city') || '').localeCompare(loc.fieldValue(b.locationId, 'shop_city') || '', undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts])

  const group = groups[idx]
  const pending = useMemo(() => (group ? group.alerts.filter((a) => !handledIds.has(a.id)) : []), [group, handledIds])

  const field = (id: string | null, key: string): string => {
    const l = loc.byId(id); if (!l) return ''
    const base = (l as any)[key]; if (base != null && base !== '') return String(base)
    const m = (l.metadata as any)?.[key]; return m == null ? '' : String(m)
  }

  const draft = useMemo(() => {
    if (!group) return null
    const id = group.locationId
    const shopCity = field(id, 'shop_city') || loc.codeOf(id)
    const shopNumber = (shopCity.match(/\d+/)?.[0]) || (loc.codeOf(id).match(/\d+/)?.[0]) || loc.codeOf(id) || ''
    const supplierName = pending[0]?.supplier_name || group.alerts[0]?.supplier_name || 'the vendor'
    const values: Record<string, string> = {
      greeting: greetingFor(),
      shop_number: shopNumber,
      shop_name: shopCity,
      area_manager: field(id, 'area_manager'),
      shop_email: field(id, 'store_email'),
      am_email: field(id, 'am_email'),
      supplier_name: supplierName,
    }
    const cols: TableCol[] = [
      { key: 'po', label: 'PO #' },
      { key: 'expected', label: 'Expected Delivery' },
      { key: 'days_late', label: 'Days Late' },
    ]
    const rows: TableRow[] = pending.map((a) => ({
      po: a.custom_po_id || a.po_id,
      expected: dShort(a.expected_delivery_date),
      days_late: String(a.days_late ?? ''),
    }))
    const htmlBlocks = { po_table: tableHtml(cols, rows) }
    const plainBlocks = { po_table: tablePlain(cols, rows) }
    const count = pending.length
    return {
      shopLabel: shopCity || loc.codeOf(id) || '—',
      to: pluralizeParens(renderText(template.to, values), count),
      subject: pluralizeParens(renderText(template.subject, values), count),
      bodyHtml: pluralizeParens(renderBodyHtml(template.body, values, htmlBlocks), count),
      bodyPlain: pluralizeParens(renderBodyPlain(template.body, values, plainBlocks), count),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, pending, template, loc])

  function advanceIfGroupDone(nextHandled: Set<string>) {
    if (!group) return
    const stillPending = group.alerts.some((a) => !nextHandled.has(a.id))
    if (stillPending) return
    goNextShop()
  }
  function goNextShop() {
    setHandledIds(new Set())
    if (idx + 1 >= groups.length) { onClose(); setIdx(0) }
    else setIdx((i) => i + 1)
  }
  function skipAlert(id: string) {
    setHandledIds((prev) => { const next = new Set(prev).add(id); advanceIfGroupDone(next); return next })
  }
  function skipShop() { goNextShop() }

  async function excludeAlert(a: PoAlertForEmail) {
    setBusyId(a.id)
    const { error } = await (supabase as any).schema('inventory').from('po_receipt_alerts')
      .update({ excluded: true, updated_by: profile?.id ?? null, last_change_source: 'po-alert-email', updated_at: new Date().toISOString() })
      .eq('id', a.id)
    setBusyId(null)
    if (error) { toast.error(error.message); return }
    setHandledIds((prev) => { const next = new Set(prev).add(a.id); advanceIfGroupDone(next); return next })
    onChanged?.()
  }

  async function closeNoReceipt(a: PoAlertForEmail) {
    setBusyId(a.id)
    const { error } = await (supabase as any).schema('inventory').from('po_receipt_alerts')
      .update({
        status: 'Closed', notes: 'Closed — no receipt confirmed (too old to pursue further)',
        updated_by: profile?.id ?? null, last_change_source: 'po-alert-email', updated_at: new Date().toISOString(),
      })
      .eq('id', a.id)
    setBusyId(null)
    if (error) { toast.error(error.message); return }
    setHandledIds((prev) => { const next = new Set(prev).add(a.id); advanceIfGroupDone(next); return next })
    onChanged?.()
  }

  async function logException(a: PoAlertForEmail) {
    if (!companyId) return
    setBusyId(a.id)
    const sb = supabase as any
    const shop = a.location_id ? loc.locations.find((l) => l.id === a.location_id) : undefined
    const poLabel = a.custom_po_id || a.po_id
    const { data: excRow, error: excErr } = await sb.schema('inventory').from('exception_reports').insert({
      company_id: companyId, location_id: a.location_id, area_manager: (shop as any)?.area_manager ?? null,
      date_of_finding: new Date().toISOString().slice(0, 10), report_type: 'PO Match', issue: 'Missing Receipt',
      details: `PO ${poLabel} (${a.supplier_name ?? 'supplier'}) expected ${dShort(a.expected_delivery_date)}, ${a.days_late ?? '?'} day(s) late — no receipt activity. Emailed shop to confirm.`,
      status: DEFAULT_STATUS, metadata: { source: 'po_receipt_alert_email', po_id: a.po_id, location_id: a.location_id },
    }).select('id').single()
    if (excErr) { setBusyId(null); toast.error(excErr.message); return }
    const { error } = await sb.schema('inventory').from('po_receipt_alerts')
      .update({
        exception_report_id: excRow.id, emailed_at: new Date().toISOString(),
        updated_by: profile?.id ?? null, last_change_source: 'po-alert-email', updated_at: new Date().toISOString(),
      })
      .eq('id', a.id)
    setBusyId(null)
    if (error) { toast.error(error.message); return }
    toast.success('Logged to Exception Reporting')
    refreshNavBadges()
    setHandledIds((prev) => { const next = new Set(prev).add(a.id); advanceIfGroupDone(next); return next })
    onChanged?.()
  }

  async function copyPlain(label: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 1200) }
    catch { toast.error('Copy failed') }
  }
  async function copyBody() {
    if (!draft) return
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([draft.bodyHtml], { type: 'text/html' }),
          'text/plain': new Blob([draft.bodyPlain], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(draft.bodyPlain)
      }
      setCopied('body'); setTimeout(() => setCopied(null), 1200)
    } catch { toast.error('Copy failed') }
  }

  return (
    <Modal open={open} onClose={() => { onClose(); setIdx(0); setHandledIds(new Set()) }} title="Late PO Receipt Emails" size="lg">
      {groups.length === 0 || !group || !draft ? (
        <p className="text-xs font-mono text-inky/60 py-6">No shops to email.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-inky/70">Shop {idx + 1} of {groups.length}</span>
            <span className="text-sm font-heading font-bold text-navy">{draft.shopLabel}</span>
          </div>

          <div className="rounded border border-navy/15 bg-navy/[0.03] p-2 flex flex-col gap-1.5">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Late PO(s) at this shop</span>
            {group.alerts.map((a) => {
              const done = handledIds.has(a.id)
              return (
                <div key={a.id} className={`flex items-center justify-between gap-2 text-[11px] font-mono px-1.5 py-1 rounded ${done ? 'bg-[#2ECC71]/10 text-inky/40' : 'text-navy'}`}>
                  <span>{a.custom_po_id || a.po_id} — expected {dShort(a.expected_delivery_date)}, {a.days_late ?? '?'}d late</span>
                  {done ? (
                    <span className="text-[#2ECC71]">Handled</span>
                  ) : (
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      <button disabled={busyId === a.id} onClick={() => void logException(a)} className="text-inky hover:text-navy hover:underline">Log Exception</button>
                      <span className="text-inky/30">·</span>
                      <button disabled={busyId === a.id} onClick={() => skipAlert(a.id)} className="text-inky hover:text-navy hover:underline">Skip</button>
                      <span className="text-inky/30">·</span>
                      <button disabled={busyId === a.id} onClick={() => void excludeAlert(a)} className="text-inky hover:text-navy hover:underline">Exclude</button>
                      <span className="text-inky/30">·</span>
                      <button disabled={busyId === a.id} onClick={() => void closeNoReceipt(a)} className="text-inky hover:text-navy hover:underline">Close (No Receipt)</button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <Field label="To" value={draft.to} copied={copied === 'to'} onCopy={() => copyPlain('to', draft.to)} />
          <Field label="Subject" value={draft.subject} copied={copied === 'subject'} onCopy={() => copyPlain('subject', draft.subject)} />

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Body</span>
              <button onClick={copyBody} className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-0.5 hover:border-navy">
                {copied === 'body' ? <><Check className="w-3 h-3 text-[#2ECC71]" /> Copied</> : <><Copy className="w-3 h-3" /> Copy body (formatted)</>}
              </button>
            </div>
            {/* dark:invert dark:hue-rotate-180 — this app's dark mode toggle
                applies the .dark class app-wide, but the raw email HTML here
                has no idea about it (it's meant to render in Outlook, always
                light). Rather than hand-writing dark-mode CSS for content
                whose structure isn't controlled by this component, invert +
                hue-rotate the whole preview box only on screen — a common
                "dark-mode an opaque HTML blob" trick. copyBody() below reads
                draft.bodyHtml directly, never the filtered DOM, so what gets
                copied is always the un-inverted light-mode version regardless
                of which mode is showing on screen. */}
            <div className="rounded border border-navy/20 bg-white p-3 max-h-72 overflow-auto text-sm text-[#002745] [&_table]:my-2 dark:invert dark:hue-rotate-180"
              dangerouslySetInnerHTML={{ __html: draft.bodyHtml }} />
            <span className="text-[10px] font-mono text-inky/50">Copy pastes into Outlook with the table formatted.</span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-navy/10 mt-1">
            <div className="flex items-center gap-3">
              <button onClick={() => { onClose(); setIdx(0); setHandledIds(new Set()) }} className="text-xs font-mono text-inky/60 hover:text-navy hover:underline">Close</button>
              <button
                disabled
                title="*Coming Soon* - send email directly from SB Net to recipients"
                className="text-xs font-mono text-inky/30 border border-inky/20 rounded px-2 py-0.5 cursor-not-allowed"
              >
                Send Email
              </button>
            </div>
            <Button variant="secondary" size="sm" onClick={skipShop}>Skip Shop</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Field({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label}</span>
        <button onClick={onCopy} className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-0.5 hover:border-navy">
          {copied ? <><Check className="w-3 h-3 text-[#2ECC71]" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
        </button>
      </div>
      <div className="rounded border border-navy/20 bg-cream dark:bg-[#0e2638] px-2 py-1.5 text-xs font-mono text-navy dark:text-[#F2F1E6] break-words">{value || <span className="text-inky/40 italic">—</span>}</div>
    </div>
  )
}
