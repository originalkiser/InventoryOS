// Exception triage: the automatic inventory exceptions by shop, by exception type, and the Log of what's been emailed.
// One card per shop per type (see shopExceptionTypes.tsx); Skip / Excuse / Log work the same as in the Location Lookup modal.
import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { Button, SbLoader } from '@/components/ui'
import { exceptionSummary } from './describeException'
import { ExceptionCard, SeverityPill, StatusPill } from './ExceptionCard'
import { ExceptionLogModal, ExceptionSequenceModal, useShopNames } from './ExceptionSequenceModal'
import { TriageSettings } from './TriageSettings'
import { ExceptionBadge, ExceptionBadges, ExceptionTile, TYPE_META, TYPE_ORDER, sortExceptions, typeColor, type ShopException, type ShopExceptionType } from './shopExceptionTypes'
import { useShopExceptions } from './useShopExceptions'

type View = 'shop' | 'type' | 'log'

export function TriagePanel() {
  const { exceptions, loading, reload, act } = useShopExceptions()
  const names = useShopNames()
  const [view, setView] = useState<View>('shop')
  const [shopSel, setShopSel] = useState<string | null>(null)
  const [shopSearch, setShopSearch] = useState('')
  const [typeSel, setTypeSel] = useState<'all' | ShopExceptionType>('all')
  const [seq, setSeq] = useState<{ items: ShopException[]; idx: number } | null>(null)
  const [logging, setLogging] = useState<ShopException | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const pending = useMemo(() => exceptions.filter((e) => e.status === 'pending'), [exceptions])
  const logged = useMemo(() => exceptions.filter((e) => e.status === 'logged').sort((a, b) => String(b.status_changed_at).localeCompare(String(a.status_changed_at))), [exceptions])

  // Shops with anything open, the ones that still need triage (and the most serious) first.
  const shops = useMemo(() => {
    const m = new Map<string, ShopException[]>()
    for (const e of exceptions) { if (!m.has(e.location_id)) m.set(e.location_id, []); m.get(e.location_id)!.push(e) }
    const rows = [...m.entries()].map(([id, list]) => {
      const p = list.filter((e) => e.status === 'pending')
      return { id, label: names.label(id), list: [...list].sort(sortExceptions), pending: p, top: Math.max(0, ...p.map((e) => e.severity)) }
    })
    return rows.sort((a, b) => Number(b.pending.length > 0) - Number(a.pending.length > 0) || b.top - a.top || a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [exceptions, names])
  const shownShops = useMemo(() => {
    const q = shopSearch.trim().toLowerCase()
    return q ? shops.filter((s) => s.label.toLowerCase().includes(q)) : shops
  }, [shops, shopSearch])
  const selShop = shops.find((s) => s.id === shopSel) ?? shops[0] ?? null

  async function runNow() {
    setRunning(true)
    try {
      const { data, error } = await (supabase as any).functions.invoke('run-automated-checks', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      toast.success(`Checked — ${data?.created ?? 0} new, ${data?.updated ?? 0} refreshed, ${data?.resolved ?? 0} resolved`)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check failed')
    } finally { setRunning(false) }
  }

  const seg = (v: View, label: string) => (
    <button type="button" aria-pressed={view === v} onClick={() => setView(v)}
      className={`px-3 py-1.5 text-xs font-mono uppercase tracking-wide border border-navy/30 -ml-px first:ml-0 first:rounded-l last:rounded-r ${view === v ? 'bg-navy text-cream border-navy' : 'bg-cream text-navy hover:bg-navy/5'}`}>{label}</button>
  )
  const act3 = (e: ShopException) => ({
    onSkip: () => void act(e, 'skip'), onExcuse: () => void act(e, 'excuse'), onLog: () => setLogging(e), onRestore: () => void act(e, 'restore'),
  })

  if (loading && !exceptions.length) return <div className="py-12 flex justify-center"><SbLoader size={36} /></div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap items-center gap-2">
          {TYPE_ORDER.map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-xs font-mono pl-1 pr-2.5 py-1 rounded-full border border-navy/25 bg-cream" style={typeColor(t)}>
              <ExceptionBadge type={t} size={20} />
              <span className="text-navy font-bold">{pending.filter((e) => e.type === t).length}</span>
              <span className="text-inky">{TYPE_META[t].short}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setSettingsOpen((v) => !v)} className="text-xs font-mono text-inky/70 hover:text-navy underline">{settingsOpen ? 'Hide settings' : 'Thresholds & ignore list'}</button>
          <Button size="sm" variant="secondary" loading={running} onClick={() => void runNow()}><Play className="w-3 h-3 mr-1" />Run checks now</Button>
        </div>
      </div>

      {settingsOpen && <TriageSettings />}

      <div className="inline-flex" role="group" aria-label="Triage view">
        {seg('shop', 'By shop')}{seg('type', 'By exception type')}{seg('log', `Log (${logged.length})`)}
      </div>

      {exceptions.length === 0 && (
        <p className="text-xs font-mono text-inky/60 py-6">No exceptions yet. They're found by the daily Automated Checks run (Config → Data Connections) — or use “Run checks now”.</p>
      )}

      {view === 'shop' && selShop && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <input value={shopSearch} onChange={(e) => setShopSearch(e.target.value)} placeholder="Find a shop…"
              className="w-56 bg-cream border border-navy/30 rounded px-2.5 py-1.5 text-xs font-mono text-navy placeholder-inky/40" />
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto pr-1">
              {shownShops.map((s) => (
                <button key={s.id} type="button" onClick={() => setShopSel(s.id)} aria-pressed={s.id === selShop.id}
                  className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-mono ${s.id === selShop.id ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/25 text-navy hover:border-navy'}`}>
                  <span>{s.label}</span>
                  {s.pending.length > 0 ? <><ExceptionBadges list={s.pending} max={4} size={18} /><span className="text-[#E67E22] font-bold">{s.pending.length}</span></> : <span className="text-inky/60">all triaged</span>}
                </button>
              ))}
            </div>
          </div>
          <h2 className="text-sm font-heading font-bold uppercase tracking-wide text-navy">
            {selShop.label}<small className="ml-2 text-[11px] font-mono font-normal normal-case text-inky">{selShop.list.length} exception{selShop.list.length === 1 ? '' : 's'}, {selShop.pending.length} pending</small>
          </h2>
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
            {selShop.list.map((e) => <ExceptionCard key={e.id} e={e} {...act3(e)} />)}
          </div>
        </div>
      )}

      {view === 'type' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setTypeSel('all')} aria-pressed={typeSel === 'all'}
              className={`rounded-full border px-3 py-1 text-xs font-mono ${typeSel === 'all' ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/25 text-navy hover:border-navy'}`}>All types <span className="ml-1 text-[#E67E22] font-bold">{pending.length}</span></button>
            {TYPE_ORDER.map((t) => (
              <button key={t} type="button" onClick={() => setTypeSel(t)} aria-pressed={typeSel === t}
                className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-3 py-1 text-xs font-mono ${typeSel === t ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/25 text-navy hover:border-navy'}`}>
                <ExceptionBadge type={t} size={20} />{TYPE_META[t].short}<span className="text-[#E67E22] font-bold">{pending.filter((e) => e.type === t).length}</span>
              </button>
            ))}
          </div>
          {(() => {
            const groups = TYPE_ORDER.filter((t) => typeSel === 'all' || typeSel === t).map((t) => ({ t, rows: exceptions.filter((e) => e.type === t).sort(sortExceptions) })).filter((g) => g.rows.length)
            const flat = groups.flatMap((g) => g.rows)
            if (!groups.length) return <p className="text-xs font-mono text-inky/60 py-6">No exceptions of this type.</p>
            return groups.map((g) => (
              <section key={g.t} style={typeColor(g.t)} className="rounded-xl border border-navy/15 bg-cream shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_14px_rgba(0,0,0,0.08)] overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 border-b border-navy/10">
                  <ExceptionTile type={g.t} size={34} />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-heading font-bold uppercase tracking-wide text-navy">{TYPE_META[g.t].label}</h3>
                    <p className="text-[11px] font-mono text-inky">{TYPE_META[g.t].blurb}</p>
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-xs font-mono">
                    <thead><tr className="text-left text-inky uppercase tracking-wide text-[10px]"><th className="px-4 py-2">Shop</th><th className="px-2 py-2">Detail</th><th className="px-2 py-2">Severity</th><th className="px-2 py-2">Status</th></tr></thead>
                    <tbody>
                      {g.rows.map((e) => (
                        <tr key={e.id} tabIndex={0} onClick={() => setSeq({ items: flat, idx: flat.findIndex((x) => x.id === e.id) })} onKeyDown={(ev) => { if (ev.key === 'Enter') setSeq({ items: flat, idx: flat.findIndex((x) => x.id === e.id) }) }}
                          className={`border-t border-navy/10 cursor-pointer hover:bg-navy/[0.05] ${e.status === 'pending' ? '' : 'opacity-60'}`}>
                          <td className="px-4 py-2 text-navy font-bold whitespace-nowrap">{names.label(e.location_id)}</td>
                          <td className="px-2 py-2 text-navy">{exceptionSummary(e)}</td>
                          <td className="px-2 py-2"><SeverityPill severity={e.severity} /></td>
                          <td className="px-2 py-2"><StatusPill status={e.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          })()}
        </div>
      )}

      {view === 'log' && (
        logged.length === 0 ? (
          <p className="text-xs font-mono text-inky/60 py-6">Nothing logged yet. Choose Log on an exception to copy its email and add it here.</p>
        ) : (
          <div className="rounded-xl border border-navy/15 bg-cream overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead><tr className="text-left text-inky uppercase tracking-wide text-[10px]"><th className="px-4 py-2">Logged</th><th className="px-2 py-2">Shop</th><th className="px-2 py-2">Exception</th><th /></tr></thead>
              <tbody>
                {logged.map((e) => (
                  <tr key={e.id} className="border-t border-navy/10">
                    <td className="px-4 py-2 whitespace-nowrap">{e.status_changed_at ? new Date(e.status_changed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</td>
                    <td className="px-2 py-2 text-navy font-bold whitespace-nowrap">{names.label(e.location_id)}</td>
                    <td className="px-2 py-2">
                      <span className="flex items-start gap-2"><ExceptionBadge type={e.type} size={22} /><span><b className="text-navy">{TYPE_META[e.type].label}</b><br /><span className="text-inky">{exceptionSummary(e)}</span></span></span>
                    </td>
                    <td className="px-2 py-2 text-right"><Button size="sm" variant="secondary" onClick={() => void act(e, 'restore')}>Reopen</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {seq && <ExceptionSequenceModal items={seq.items} startIndex={seq.idx} onClose={() => setSeq(null)} />}
      {logging && <ExceptionLogModal e={logging} onCancel={() => setLogging(null)} onConfirm={async (m) => { const t = logging; setLogging(null); await act(t, 'log', m) }} />}
    </div>
  )
}
