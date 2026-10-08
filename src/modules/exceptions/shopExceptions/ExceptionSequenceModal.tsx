// Walks through a list of exceptions one at a time (Skip / Excuse / Log each, with Back / Next and optional auto-advance) — the modal the
// Location Lookup card and the triage view both open. Logging opens a second window with the email to copy.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button, Modal } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { emailFor } from './describeException'
import { ExceptionCard } from './ExceptionCard'
import { TYPE_META, type ShopException } from './shopExceptionTypes'
import { useShopExceptions } from './useShopExceptions'

/** Shop number + display name for the email and titles. */
export function useShopNames() {
  const loc = useLocations()
  return useMemo(() => ({
    label: (id: string) => loc.labelOf(id) || id,
    info: (id: string) => ({ num: loc.codeOf(id) || '', name: String(loc.fieldValue(id, 'shop_city') || loc.labelOf(id) || '').replace(/^\s*\S+\s*[-·]\s*/, '') }),
  }), [loc])
}

export function ExceptionLogModal({ e, onCancel, onConfirm }: { e: ShopException; onCancel: () => void; onConfirm: (message: string) => void }) {
  const names = useShopNames()
  const mail = useMemo(() => emailFor(e, names.info(e.location_id)), [e, names])
  const ta = useRef<HTMLTextAreaElement>(null)
  async function copy() {
    try { await navigator.clipboard.writeText(`Subject: ${mail.subject}\n\n${mail.body}`); toast.success('Email copied') }
    catch { ta.current?.focus(); ta.current?.select(); toast('Select the text and copy it', { icon: 'ℹ️' }) }
  }
  const fieldCls = 'w-full bg-cream border border-navy/30 rounded px-2.5 py-1.5 text-xs font-mono text-navy'
  return (
    <Modal open onClose={onCancel} title={`Log exception · ${names.label(e.location_id)}`} size="lg">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wide text-inky">To<input readOnly value={mail.to} className={fieldCls} /></label>
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wide text-inky">Subject<input readOnly value={mail.subject} className={fieldCls} /></label>
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wide text-inky">Message<textarea ref={ta} readOnly value={mail.body} rows={12} className={`${fieldCls} resize-y`} /></label>
        <p className="text-[11px] font-mono text-inky">Copy the email, send it from your mail client, then log it so it moves to the Log.</p>
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="secondary" onClick={() => void copy()}><Copy className="w-3.5 h-3.5 mr-1" />Copy email</Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={() => onConfirm(`Subject: ${mail.subject}\n\n${mail.body}`)}><Check className="w-3.5 h-3.5 mr-1" />Log exception</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function ExceptionSequenceModal({ items, startIndex = 0, onClose }: { items: ShopException[]; startIndex?: number; onClose: () => void }) {
  const names = useShopNames()
  const { exceptions, act } = useShopExceptions()
  const [idx, setIdx] = useState(Math.min(startIndex, Math.max(0, items.length - 1)))
  const [auto, setAuto] = useState(true)
  const [logging, setLogging] = useState<ShopException | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const n = items.length
  const last = idx >= n - 1
  useEffect(() => () => clearTimeout(timer.current), [])
  // The card reads the live record (so a status change shows at once), falling back to the list this was opened with.
  const live = useMemo(() => new Map(exceptions.map((e) => [e.id, e])), [exceptions])
  const e = items[idx] ? live.get(items[idx].id) ?? items[idx] : null

  const advance = () => { if (auto && idx < n - 1) { clearTimeout(timer.current); timer.current = setTimeout(() => setIdx((i) => Math.min(i + 1, n - 1)), 450) } }
  useEffect(() => {
    if (logging) return
    const k = (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, n - 1))
      else if (ev.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [n, logging])
  if (!e) return null

  return (
    <>
      <Modal open onClose={onClose} title={`${TYPE_META[e.type].short} · ${names.label(e.location_id)}`} size="md">
        <div className="flex flex-col gap-3">
          <ExceptionCard e={e}
            onSkip={() => void act(e, 'skip').then((ok) => ok && advance())}
            onExcuse={() => void act(e, 'excuse').then((ok) => ok && advance())}
            onLog={() => setLogging(e)}
            onRestore={() => void act(e, 'restore')} />
          {n > 1 ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <Button size="sm" variant="secondary" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Back</Button>
                <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy cursor-pointer"><input type="checkbox" className="accent-sky" checked={auto} onChange={(ev) => setAuto(ev.target.checked)} />Auto-advance</label>
              </div>
              <Button size="sm" onClick={() => (last ? onClose() : setIdx(idx + 1))}>{last ? 'Done' : 'Next'} <span className="ml-1.5 opacity-70">{idx + 1}/{n}</span></Button>
            </div>
          ) : (
            <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={onClose}>Close</Button></div>
          )}
        </div>
      </Modal>
      {logging && (
        <ExceptionLogModal e={logging} onCancel={() => setLogging(null)}
          onConfirm={async (message) => { const target = logging; setLogging(null); if (await act(target, 'log', message)) advance() }} />
      )}
    </>
  )
}
