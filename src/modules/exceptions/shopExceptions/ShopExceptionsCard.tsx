// The Location Lookup card: this shop's pending exceptions as icon rows. Click a row (or Triage) to walk through them in the modal.
import { useMemo, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { SbLoader } from '@/components/ui'
import { exceptionSummary } from './describeException'
import { SeverityPill } from './ExceptionCard'
import { ExceptionSequenceModal } from './ExceptionSequenceModal'
import { ExceptionTile, TYPE_META, sortExceptions } from './shopExceptionTypes'
import { useShopExceptions } from './useShopExceptions'

export function ShopExceptionsCard({ locationId, framed }: { locationId: string; framed?: boolean }) {
  const { exceptions, loading } = useShopExceptions()
  const [startAt, setStartAt] = useState<number | null>(null)
  const pending = useMemo(() => exceptions.filter((e) => e.location_id === locationId && e.status === 'pending').sort(sortExceptions), [exceptions, locationId])
  const handled = useMemo(() => exceptions.filter((e) => e.location_id === locationId && e.status !== 'pending').length, [exceptions, locationId])
  const high = pending.filter((e) => e.severity === 3).length
  return (
    <div className={framed ? 'flex flex-col bg-cream' : 'rounded-lg border border-navy/20 bg-cream flex flex-col'}>
      <div className={`sticky top-0 z-10 bg-cream flex items-center justify-between gap-2 px-4 py-1.5 ${framed ? '' : 'rounded-t-lg'}`}>
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Inventory Exceptions</span>
          {pending.length > 0 && <span className={`text-lg font-heading font-bold ${high ? 'text-[#C0392B]' : 'text-[#E67E22]'}`}>{pending.length}</span>}
        </span>
        {pending.length > 0 && (
          <button type="button" onClick={() => setStartAt(0)} className="inline-flex items-center gap-1 rounded border border-navy/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-navy hover:border-navy hover:bg-navy/5">
            Triage <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-4 pb-3">
        {loading ? (
          <div className="py-3 flex justify-center"><SbLoader size={20} /></div>
        ) : pending.length === 0 ? (
          <span className="flex items-center gap-2 text-xs font-body text-inky/60"><Check className="w-4 h-4 text-[#27A860]" />Nothing pending triage{handled ? ` · ${handled} handled` : ''}</span>
        ) : (
          <>
            {pending.map((e, i) => (
              <button key={e.id} type="button" onClick={() => setStartAt(i)} title={`${TYPE_META[e.type].label}: ${exceptionSummary(e)}`}
                className="flex items-center gap-2.5 text-left rounded-lg border border-navy/15 bg-cream/70 hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
                <ExceptionTile type={e.type} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-body font-bold text-navy truncate">{TYPE_META[e.type].short}</span>
                  <span className="block text-[10px] font-mono text-inky truncate">{exceptionSummary(e)}</span>
                </span>
                <SeverityPill severity={e.severity} />
              </button>
            ))}
            {handled > 0 && <span className="text-[10px] font-mono text-inky/60">{handled} more handled (skipped, excused or logged)</span>}
          </>
        )}
      </div>
      {startAt != null && pending.length > 0 && <ExceptionSequenceModal items={pending} startIndex={startAt} onClose={() => setStartAt(null)} />}
    </div>
  )
}
