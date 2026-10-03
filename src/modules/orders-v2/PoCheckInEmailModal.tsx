// "PO Delivery Check-In" email flow for overdue RelaDyne POs (direct ask 2026-10-03) — styled after the Tank
// Monitors email workflow (TankEmailModal): one shop at a time, a draft you copy into Outlook, then
//   Skip it   — leave the POs queued as if nothing was sent (bumps their skip count);
//   Log it    — log a "PO Delivery Check-In" in Location Comms and mark the POs emailed;
//   Ignore it — ignore the POs forever (restorable from the ignored list on the RD Reports tab).
import { useEffect, useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal, Button } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useLocations } from '@/hooks/useLocations'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import { DEFAULT_STATUS } from '@/modules/exceptions/exceptions'
import {
  renderText, renderBodyHtml, renderBodyPlain, pluralizeParens, tableHtml, tablePlain, greetingFor, localDateStr,
  type TableCol, type TableRow,
} from '@/modules/locations/tankEmail'
import {
  PO_CHECKIN_COMM_TYPE, PO_EMAIL_DEFAULT, PO_EMAIL_TOKENS, productsSummary,
  type OverduePoGroup, type PoEmailTemplate, type PoCheckStatus,
} from './rdPoCheck'
import type { PoStatusTarget } from './useRdPoCheckStatus'
import { dShort } from './shared'

export interface PoEmailTarget { locationId: string; groups: OverduePoGroup[] }

interface Props {
  open: boolean
  onClose: () => void
  targets: PoEmailTarget[]
  setStatus: (targets: PoStatusTarget[], status: PoCheckStatus | null, opts?: { incrementSkip?: boolean }) => Promise<boolean>
}

const toStatusTargets = (groups: OverduePoGroup[]): PoStatusTarget[] =>
  groups.map((g) => ({ key: g.key, locationId: g.locationId, orderDate: g.orderDate }))

export function PoCheckInEmailModal({ open, onClose, targets, setStatus }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState<'skip' | 'log' | 'ignore' | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [template, setTemplate] = useAppSetting<PoEmailTemplate>('rd_po_checkin_email_template', PO_EMAIL_DEFAULT)
  const [editing, setEditing] = useState(false)
  const [tplDraft, setTplDraft] = useState<PoEmailTemplate>(template)
  useEffect(() => { setTplDraft(template) }, [template])

  const field = (id: string | null, key: string): string => {
    const l = loc.byId(id); if (!l) return ''
    const base = (l as any)[key]; if (base != null && base !== '') return String(base)
    const m = (l.metadata as any)?.[key]; return m == null ? '' : String(m)
  }

  const target = targets[idx] as PoEmailTarget | undefined

  const draft = useMemo(() => {
    if (!target) return null
    const id = target.locationId
    const shopCity = field(id, 'shop_city') || loc.codeOf(id)
    const shopNumber = (shopCity.match(/\d+/)?.[0]) || (loc.codeOf(id).match(/\d+/)?.[0]) || loc.codeOf(id) || ''
    const values: Record<string, string> = {
      greeting: greetingFor(), shop_number: shopNumber, shop_name: shopCity,
      area_manager: field(id, 'area_manager'), shop_email: field(id, 'store_email'),
      am_email: field(id, 'am_email'), rd_email: field(id, 'rd_email'),
    }
    const cols: TableCol[] = [
      { key: 'po', label: 'PO #' }, { key: 'ordered', label: 'Order Date' },
      { key: 'expected', label: 'Expected Delivery' }, { key: 'products', label: 'Products' },
    ]
    const rows: TableRow[] = target.groups.map((g) => ({
      po: g.poNo ?? `Sales order ${g.salesOrderNos.join(', ')}`,
      ordered: g.orderDate ? dShort(g.orderDate) : '', expected: g.expected ? dShort(g.expected) : '',
      products: productsSummary(g.lines),
    }))
    const count = rows.length
    return {
      id, shopLabel: shopCity || loc.codeOf(id) || '—', count,
      to: pluralizeParens(renderText(template.to, values), count),
      subject: pluralizeParens(renderText(template.subject, values), count),
      bodyHtml: pluralizeParens(renderBodyHtml(template.body, values, { po_table: tableHtml(cols, rows) }), count),
      bodyPlain: pluralizeParens(renderBodyPlain(template.body, values, { po_table: tablePlain(cols, rows) }), count),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, template, loc])

  async function copyPlain(label: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 1200) } catch { toast.error('Copy failed') }
  }
  async function copyBody() {
    if (!draft) return
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([draft.bodyHtml], { type: 'text/html' }),
          'text/plain': new Blob([draft.bodyPlain], { type: 'text/plain' }),
        })])
      } else await navigator.clipboard.writeText(draft.bodyPlain)
      setCopied('body'); setTimeout(() => setCopied(null), 1200)
    } catch { toast.error('Copy failed') }
  }

  function advance() {
    if (idx + 1 >= targets.length) { onClose(); setIdx(0) } else setIdx((i) => i + 1)
  }

  async function skip() {
    if (!target) return
    setBusy('skip')
    const ok = await setStatus(toStatusTargets(target.groups), 'skipped', { incrementSkip: true })
    setBusy(null)
    if (ok) advance()
  }

  async function ignore() {
    if (!target) return
    setBusy('ignore')
    const ok = await setStatus(toStatusTargets(target.groups), 'ignored')
    setBusy(null)
    if (ok) { toast.success(`Ignored ${target.groups.length} PO${target.groups.length === 1 ? '' : 's'} — restore them from the ignored list`); advance() }
  }

  async function logIt() {
    if (!target || !draft || !companyId) return
    setBusy('log')
    const poList = target.groups.map((g) => g.poNo ?? `SO ${g.salesOrderNos.join('/')}`)
    const { error } = await (supabase as any).schema('inventory').from('location_comms').insert({
      company_id: companyId,
      location_id: target.locationId,
      comm_date: localDateStr(),
      contact_method: 'Email',
      email_subject: draft.subject || null,
      who_contacted: 'Shop Manager',
      comm_type: PO_CHECKIN_COMM_TYPE,
      products: target.groups.flatMap((g) => g.lines.map((l) => ({ product_id: l.product_code, qty: l.qty_ordered, po: g.poNo ?? null }))),
      action_taken: null,
      exception_report_id: null,
      status: DEFAULT_STATUS,
      notes: `${poList.length} PO(s): ${poList.join(', ')}`,
      last_change_source: 'po-checkin-email',
      updated_by: profile?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    if (error) { setBusy(null); toast.error(error.message); return }
    const ok = await setStatus(toStatusTargets(target.groups), 'emailed')
    setBusy(null)
    if (!ok) return
    toast.success('Logged to Location Comms')
    refreshNavBadges()
    advance()
  }

  function saveTemplate() {
    setTemplate(tplDraft)
    setEditing(false)
    toast.success('Template saved')
  }

  return (
    <Modal open={open} onClose={() => { onClose(); setIdx(0) }} title="PO Delivery Check-In Emails" size="lg">
      {targets.length === 0 || !draft || !target ? (
        <p className="text-xs font-mono text-inky/60 py-6">No POs to email.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-inky/70">Shop {idx + 1} of {targets.length}</span>
            <span className="text-sm font-heading font-bold text-navy">{draft.shopLabel}</span>
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
            <div className="rounded border border-navy/20 bg-white p-3 max-h-72 overflow-auto text-sm text-[#002745] [&_table]:my-2"
              dangerouslySetInnerHTML={{ __html: draft.bodyHtml }} />
            <span className="text-[10px] font-mono text-inky/50">Copy pastes into Outlook with the table formatted.</span>
          </div>

          <div className="flex flex-col gap-2">
            <button onClick={() => setEditing((v) => !v)} className="self-start text-[11px] font-mono text-inky underline">
              {editing ? 'Hide template' : 'Edit email template'}
            </button>
            {editing && (
              <div className="rounded border border-navy/15 bg-navy/[0.03] p-2 flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {PO_EMAIL_TOKENS.map((t) => (
                    <span key={t.token} title={t.label} className="inline-flex rounded border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-navy">{`{{${t.token}}}`}</span>
                  ))}
                </div>
                <input value={tplDraft.to} onChange={(e) => setTplDraft({ ...tplDraft, to: e.target.value })} placeholder="To"
                  className="w-full bg-cream border border-navy/40 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
                <input value={tplDraft.subject} onChange={(e) => setTplDraft({ ...tplDraft, subject: e.target.value })} placeholder="Subject"
                  className="w-full bg-cream border border-navy/40 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
                <textarea value={tplDraft.body} onChange={(e) => setTplDraft({ ...tplDraft, body: e.target.value })} rows={9}
                  className="w-full bg-cream border border-navy/40 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:ring-2 focus:ring-sky resize-y" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveTemplate}>Save template</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setTplDraft(PO_EMAIL_DEFAULT) }}>Reset to default</Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-navy/10 mt-1 flex-wrap">
            <button onClick={() => { onClose(); setIdx(0) }} className="text-xs font-mono text-inky/60 hover:text-navy hover:underline">Close</button>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" loading={busy === 'ignore'} onClick={ignore} title="Ignore these POs forever — restore them from the ignored list">Ignore it</Button>
              <Button variant="secondary" size="sm" loading={busy === 'skip'} onClick={skip} title="Leave these POs queued as if no email was sent">Skip it</Button>
              <Button size="sm" loading={busy === 'log'} onClick={logIt}>{idx + 1 >= targets.length ? 'Log it & Finish' : 'Log it & Next'}</Button>
            </div>
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
