// Month End Recap — "Shops missing a manager" for a count period. A list uploaded by whoever tracks vacancies (one shop per row —
// a shop number or "1521-City"); it drives two call-outs for the recap:
//   • shops without a manager that had not submitted their count by end of day Monday (the count day), and
//   • shops that required a recount while missing a manager.
// The same lines are added to the recap's notes the next time the month is filled from app data.
import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, SbLoader } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { managerCallouts, type RecapResult } from './monthEndRecapCompute'
import type { useMonthEndRecap } from './useMonthEndRecap'

type Recap = ReturnType<typeof useMonthEndRecap>
type Row = { location_id: string; shop_label: string | null }

const sortShops = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
const dayText = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })

async function copyLines(lines: string[]) {
  try { await navigator.clipboard.writeText(lines.join('\n')); toast.success('Copied') } catch { toast.error("Couldn't copy") }
}

export function MissingManagersCard({ recap, month }: { recap: Recap; month: string }) {
  const countMonth = `${month}-01`
  const [rows, setRows] = useState<Row[] | null>(null)
  const [computed, setComputed] = useState<{ result: RecapResult; shopLabels: Map<string, string> } | null>(null)
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setRows(null)
    const r = await recap.loadMissingManagers(countMonth)
    setRows(r)
    setComputed(r.length ? await recap.computeMonth(countMonth) : null)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setUnmatched([]); void refresh() }, [countMonth])

  async function onParsed(headers: string[], fileRows: Record<string, string>[]) {
    setBusy(true)
    const res = await recap.uploadMissingManagers(countMonth, headers, fileRows)
    setBusy(false)
    if (res) setUnmatched(res.unmatched)
    await refresh()
  }
  async function clear() {
    if (!window.confirm('Clear the list of shops missing a manager for this count period?')) return
    await recap.clearMissingManagers(countMonth)
    setUnmatched([])
    await refresh()
  }

  const labelOf = (id: string) => computed?.shopLabels.get(id) ?? rows?.find((r) => r.location_id === id)?.shop_label ?? id
  const callouts = useMemo(
    () => (computed && rows?.length ? managerCallouts(computed.result, new Set(rows.map((r) => r.location_id))) : null),
    [computed, rows],
  )
  const monthName = new Date(`${countMonth}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const countDay = computed ? dayText(computed.result.cycleStart) : null

  return (
    <Card><CardBody className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Shops Missing a Manager — {monthName}</h2>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5 max-w-3xl">
          Upload the list of shops that had no shop manager this count period (a CSV or Excel file, one shop per row — a shop number or
          "1521-City"). It calls out the shops without a manager that hadn't submitted their count by end of day Monday, and the shops
          that needed a recount while missing a manager. Uploading again replaces this period's list.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <FileUploadZone onParsed={(r) => void onParsed(r.headers, r.rows)} label="Drop the list of shops missing a manager, or click to browse" />
        {busy && <div className="flex items-center gap-2 text-xs font-mono text-inky"><SbLoader size={16} /> Matching shops…</div>}
        {unmatched.length > 0 && (
          <p className="text-[11px] font-mono text-[#E67E22]">
            {unmatched.length} row{unmatched.length === 1 ? '' : 's'} in the file didn't match a shop and {unmatched.length === 1 ? 'was' : 'were'} skipped: {unmatched.slice(0, 20).join(', ')}{unmatched.length > 20 ? '…' : ''}
          </p>
        )}
      </div>

      {rows == null ? (
        <div className="py-2"><SbLoader size={20} /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs font-mono text-inky/60">No list uploaded for this count period yet.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-mono uppercase tracking-wide text-inky">{rows.length} shop{rows.length === 1 ? '' : 's'} missing a manager</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copyLines(rows.map((r) => labelOf(r.location_id)).sort(sortShops))}><Copy className="w-3 h-3 mr-1" />Copy list</Button>
              <Button size="sm" variant="ghost" onClick={() => void clear()}>Clear list</Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {rows.map((r) => labelOf(r.location_id)).sort(sortShops).map((l) => (
              <span key={l} className="rounded border border-navy/25 bg-cream px-1.5 py-0.5 text-[11px] font-mono text-navy">{l}</span>
            ))}
          </div>

          {!callouts ? (
            <p className="text-[11px] font-mono text-inky/60">The call-outs need this month's counts — nothing found for {monthName} yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Callout
                title={`No manager and no count by end of day Monday${countDay ? ` (${countDay})` : ''}`}
                empty="Every shop without a manager submitted by end of day Monday."
                items={callouts.late.map((x) => ({ label: labelOf(x.id), detail: x.submitted ? `submitted ${dayText(x.submitted)}` : 'not submitted' }))}
              />
              <Callout
                title="Required a recount and had no manager"
                empty="No shop that required a recount was missing a manager."
                items={callouts.recount.map((x) => ({ label: labelOf(x.id), detail: x.kind === 'partial' ? 'partial recount' : 'recount' }))}
              />
            </div>
          )}
        </>
      )}
    </CardBody></Card>
  )
}

function Callout({ title, empty, items }: { title: string; empty: string; items: { label: string; detail: string }[] }) {
  const sorted = [...items].sort((a, b) => sortShops(a.label, b.label))
  return (
    <div className={`rounded border p-3 flex flex-col gap-1.5 ${sorted.length ? 'border-[#E67E22] bg-[#E67E22]/10' : 'border-navy/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-heading font-bold text-navy">{title} <span className="font-mono text-navy/75">({sorted.length})</span></span>
        {sorted.length > 0 && (
          <button type="button" title="Copy this list" onClick={() => void copyLines(sorted.map((s) => `${s.label} — ${s.detail}`))} className="text-navy/70 hover:text-navy"><Copy className="w-3.5 h-3.5" /></button>
        )}
      </div>
      {sorted.length === 0 ? <p className="text-[11px] font-mono text-inky/70">{empty}</p> : (
        <ul className="flex flex-col gap-0.5 text-[11px] font-mono text-navy max-h-48 overflow-auto">
          {sorted.map((s) => <li key={s.label}>{s.label} <span className="text-navy/70">— {s.detail}</span></li>)}
        </ul>
      )}
    </div>
  )
}
