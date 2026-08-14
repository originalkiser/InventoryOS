import { useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Modal, Button } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { DEFAULT_STATUS } from '@/modules/exceptions/exceptions'
import type { TankMonitor } from '@/types'
import {
  type TankEmailKind, type TankEmailTemplate, type TableCol, type TableRow,
  renderText, renderBodyHtml, renderBodyPlain, pluralizeParens,
  tableHtml, tablePlain, magnetImageHtml,
} from './tankEmail'
import toast from 'react-hot-toast'

export interface EmailTarget { locationId: string; monitors: TankMonitor[] }

interface Props {
  open: boolean
  onClose: () => void
  kind: TankEmailKind
  template: TankEmailTemplate
  targets: EmailTarget[]
  internalOf: (pid: string | null) => string
  onLogged?: () => void
}

const num = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))

export function TankEmailModal({ open, onClose, kind, template, targets, internalOf, onLogged }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [idx, setIdx] = useState(0)
  const [logging, setLogging] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  // Base-column-first, metadata fallback (mirrors the page's metaOf).
  const field = (id: string | null, key: string): string => {
    const l = loc.byId(id); if (!l) return ''
    const base = (l as any)[key]; if (base != null && base !== '') return String(base)
    const m = (l.metadata as any)?.[key]; return m == null ? '' : String(m)
  }

  const target = targets[idx] as EmailTarget | undefined

  const draft = useMemo(() => {
    if (!target) return null
    const id = target.locationId
    const shopCity = field(id, 'shop_city') || loc.codeOf(id)
    const shopNumber = (shopCity.match(/\d+/)?.[0]) || (loc.codeOf(id).match(/\d+/)?.[0]) || loc.codeOf(id) || ''
    const values: Record<string, string> = {
      shop_number: shopNumber,
      shop_name: shopCity,
      area_manager: field(id, 'area_manager'),
      shop_email: field(id, 'store_email'),
      am_email: field(id, 'am_email'),
      rd_email: field(id, 'rd_email'),
    }
    const cap = (m: TankMonitor) => m.total_capacity ?? ((m.on_hand ?? 0) + (m.available_capacity ?? 0))
    const gte11 = (v: number | null | undefined) => (v != null && v >= 11 ? num(v) : '')
    const isWater = (s: string) => /water/i.test(s)

    let cols: TableCol[]
    let rows: TableRow[]
    if (kind === 'lowvmi') {
      // Shop #, serial (filled), product (blank if water), tank shape (blank),
      // height (blank if < 11), capacity (blank if < 11).
      cols = [
        { key: 'shop', label: 'Shop #' },
        { key: 'serial', label: 'Serial #' },
        { key: 'product', label: 'Product' },
        { key: 'shape', label: 'Tank Shape' },
        { key: 'height', label: 'Height' },
        { key: 'capacity', label: 'Capacity' },
      ]
      rows = target.monitors.map((m) => {
        const prod = internalOf(m.product_id) || m.product_id || ''
        return {
          shop: shopNumber,
          serial: m.serial_rtu_id || m.system_tank_id || '',
          product: isWater(prod) || isWater(m.product_id || '') ? '' : prod,
          shape: '',
          height: gte11(m.height),
          capacity: gte11(cap(m)),
        }
      })
      // No monitors assigned → give the shop 8 blank rows to fill in, seeded
      // with their location number in the Shop # column.
      if (rows.length === 0) rows = Array.from({ length: 8 }, () => ({ shop: shopNumber, serial: '', product: '', shape: '', height: '', capacity: '' }))
    } else {
      cols = [
        { key: 'product', label: 'Product' },
        { key: 'serial', label: 'Serial #' },
        { key: 'height', label: 'Height' },
        { key: 'capacity', label: 'Capacity' },
      ]
      rows = target.monitors.map((m) => ({
        product: internalOf(m.product_id) || m.product_id || '',
        serial: m.serial_rtu_id || m.system_tank_id || '',
        height: num(m.height),
        capacity: num(cap(m)),
      }))
    }
    const count = target.monitors.length
    const htmlBlocks: Record<string, string> = {
      monitor_table: tableHtml(cols, rows),
      magnet_image: magnetImageHtml(template.magnetImage),
    }
    const plainBlocks: Record<string, string> = {
      monitor_table: tablePlain(cols, rows),
      magnet_image: template.magnetImage ? '[see attached magnet photo]' : '',
    }
    return {
      id,
      shopLabel: shopCity || loc.codeOf(id) || '—',
      to: pluralizeParens(renderText(template.to, values), count),
      subject: pluralizeParens(renderText(template.subject, values), count),
      bodyHtml: pluralizeParens(renderBodyHtml(template.body, values, htmlBlocks), count),
      bodyPlain: pluralizeParens(renderBodyPlain(template.body, values, plainBlocks), count),
      rowCount: count,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, template, internalOf, loc])

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

  function advance() {
    if (idx + 1 >= targets.length) { onClose(); setIdx(0) }
    else setIdx((i) => i + 1)
  }

  async function logAndNext() {
    if (!draft || !companyId) { advance(); return }
    setLogging(true)
    const sb = supabase as any
    const payload = {
      company_id: companyId,
      location_id: draft.id,
      comm_date: new Date().toISOString().split('T')[0],
      contact_method: 'Email',
      email_subject: draft.subject || null,
      who_contacted: 'Shop Manager',
      comm_type: kind === 'offline' ? 'Offline Tank Monitor' : 'Low VMI Coverage',
      products: [],
      action_taken: null,
      exception_report_id: null,
      status: DEFAULT_STATUS,
      notes: `${draft.rowCount} monitor(s) — ${draft.subject}`,
      last_change_source: 'tank-email',
      updated_by: profile?.id ?? null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await sb.schema('inventory').from('location_comms').insert(payload)
    setLogging(false)
    if (error) { toast.error(error.message); return }
    toast.success('Logged to Location Comms')
    onLogged?.()
    advance()
  }

  const title = kind === 'offline' ? 'Offline Monitor Emails' : 'Low VMI Coverage Emails'

  return (
    <Modal open={open} onClose={() => { onClose(); setIdx(0) }} title={title} size="lg">
      {targets.length === 0 || !draft ? (
        <p className="text-xs font-mono text-inky/60 py-6">No shops to email.</p>
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
            <div
              className="rounded border border-navy/20 bg-white p-3 max-h-72 overflow-auto text-sm text-[#002745] [&_table]:my-2"
              dangerouslySetInnerHTML={{ __html: draft.bodyHtml }}
            />
            <span className="text-[10px] font-mono text-inky/50">Copy pastes into Outlook with the table{template.magnetImage ? ' and photo' : ''} formatted.</span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-navy/10 mt-1">
            <button onClick={() => { onClose(); setIdx(0) }} className="text-xs font-mono text-inky/60 hover:text-navy hover:underline">Close</button>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={advance}>Skip</Button>
              <Button size="sm" loading={logging} onClick={logAndNext}>
                {idx + 1 >= targets.length ? 'Log & Finish' : 'Log & Next'}
              </Button>
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
