// One exception — a shop's single card for a type, listing every product / PO it currently covers (items are added and drop off as they change).
import { Check, Mail, RotateCcw, ShieldCheck, SkipForward } from 'lucide-react'
import { exceptionDate, exceptionSummary, itemLine } from './describeException'
import { ExceptionTile, SEV_LABEL, STATUS_LABEL, TYPE_META, typeColor, type ShopException } from './shopExceptionTypes'

const SEV_CLASS: Record<number, string> = {
  1: 'bg-inky/15 text-inky border-inky/30',
  2: 'bg-[#E67E22]/15 text-[#E67E22] border-[#E67E22]/40',
  3: 'bg-[#C0392B]/15 text-[#C0392B] border-[#C0392B]/40',
}
export function SeverityPill({ severity }: { severity: number }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wide ${SEV_CLASS[severity] ?? SEV_CLASS[1]}`}>{SEV_LABEL[severity] ?? '—'}</span>
}
export function StatusPill({ status }: { status: ShopException['status'] }) {
  const tone = status === 'pending' ? 'text-[#E67E22]' : status === 'logged' ? 'text-[#27A860]' : 'text-inky'
  return <span className={`text-[10px] font-mono font-bold uppercase tracking-wide ${tone}`}>{STATUS_LABEL[status]}</span>
}

const btn = 'inline-flex items-center justify-center gap-1.5 rounded border border-navy/30 px-2.5 py-1.5 text-[11px] font-mono uppercase tracking-wide text-navy hover:border-navy hover:bg-navy/5 transition-colors flex-1'

export function ExceptionCard({ e, shopLabel, onSkip, onExcuse, onLog, onRestore }: {
  e: ShopException
  /** Shown under the title when the card is listed outside its own shop's view. */
  shopLabel?: string
  onSkip: () => void; onExcuse: () => void; onLog: () => void; onRestore: () => void
}) {
  const meta = TYPE_META[e.type]
  const dim = e.status === 'skipped' || e.status === 'excused'
  const maxDays = e.type === 'zero_sales' ? Math.max(0, ...e.items.map((i) => Number(i.days ?? 0))) : 0
  return (
    <article style={typeColor(e.type)}
      className={`relative flex flex-col rounded-xl border border-navy/15 shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_14px_rgba(0,0,0,0.08)] overflow-hidden min-w-0 ${dim ? 'bg-navy/[0.06]' : 'bg-cream'}`}>
      <div className={`flex flex-col gap-2.5 p-3.5 ${dim ? 'opacity-60' : e.status === 'logged' ? 'opacity-80' : ''}`}>
        <header className="flex items-start gap-2.5">
          <ExceptionTile type={e.type} size={34} />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-heading font-bold uppercase tracking-wide text-navy leading-tight">{meta.label}</h3>
            <p className="text-[11px] font-mono text-inky mt-0.5 break-words">{shopLabel ?? exceptionSummary(e)}</p>
          </div>
          <SeverityPill severity={e.severity} />
        </header>
        {shopLabel && <p className="text-[11px] font-mono text-navy/80 -mt-1">{exceptionSummary(e)}</p>}
        <ul className="flex flex-col gap-1 max-h-48 overflow-auto rounded border border-navy/10 bg-navy/[0.03] p-2">
          {e.items.map((i) => (
            <li key={i.key} className="flex items-start gap-1.5 text-[11px] font-mono text-navy leading-snug">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-none" style={{ background: 'var(--c)' }} />
              <span className="min-w-0 break-words">{itemLine(e.type, i)}</span>
            </li>
          ))}
        </ul>
        {e.type === 'zero_sales' && maxDays > 0 && (
          <div className="flex items-center gap-1" aria-label={`Stacked ${maxDays} days`}>
            {Array.from({ length: Math.min(Math.max(maxDays, 7), 14) }, (_, n) => (
              <i key={n} className="h-1.5 flex-1 rounded-sm" style={{ background: n < maxDays ? 'var(--c)' : 'color-mix(in srgb, var(--c) 18%, transparent)' }} />
            ))}
            <span className="text-[10px] font-mono text-inky ml-1 whitespace-nowrap">{maxDays}d stacked</span>
          </div>
        )}
        <p className="text-[10px] font-mono text-inky/70 leading-snug">{meta.stacks ? 'Stacks each daily check until on hand is corrected.' : 'One card per shop — new items are added, cleared ones drop off.'}</p>
        <p className="text-[10px] font-mono text-inky/60">Flagged {exceptionDate(e.first_seen)} · refreshed {exceptionDate(e.last_seen)}</p>
      </div>
      <div className="flex items-center gap-2 border-t border-dashed border-navy/20 px-3.5 py-2.5">
        {e.status === 'pending' && (
          <>
            <button type="button" className={btn} onClick={onSkip}><SkipForward className="w-3.5 h-3.5" />Skip</button>
            <button type="button" className={btn} onClick={onExcuse}><ShieldCheck className="w-3.5 h-3.5" />Excuse</button>
            <button type="button" className={`${btn} bg-navy text-cream border-navy hover:bg-navy/90`} onClick={onLog}><Mail className="w-3.5 h-3.5" />Log</button>
          </>
        )}
        {(e.status === 'skipped' || e.status === 'excused') && (
          <>
            <StatusPill status={e.status} />
            <button type="button" className={`${btn} flex-none ml-auto`} onClick={onRestore}><RotateCcw className="w-3.5 h-3.5" />Restore</button>
          </>
        )}
        {e.status === 'logged' && (
          <>
            <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-wide text-[#27A860]"><Check className="w-3.5 h-3.5" />Logged {e.status_changed_at ? exceptionDate(e.status_changed_at) : ''}</span>
            <button type="button" className={`${btn} flex-none ml-auto`} onClick={onRestore}><RotateCcw className="w-3.5 h-3.5" />Reopen</button>
          </>
        )}
      </div>
      {e.status === 'excused' && <div aria-hidden className="pointer-events-none absolute top-3 right-[-34px] rotate-45 bg-navy/60 text-cream text-[9px] font-mono uppercase tracking-widest px-10 py-0.5">Excused</div>}
    </article>
  )
}
