import { useMemo } from 'react'
import { EyeOff } from 'lucide-react'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Card, CardBody } from '@/components/ui'
import { escapeHtml } from '@/modules/locations/tankEmail'
import type { Location } from '@/types'
import toast from 'react-hot-toast'

interface AmRollupRow {
  am: string
  submitted: number
  notSubmitted: number
  pct: number // 0..1
  shopsNotSubmitted: string[]
}

// Bare leading number off the location code (e.g. "44-Wilmington" -> "44"),
// matching how the shop list is meant to read: compact, comma-separated
// codes rather than full "code — city" labels.
function shopCodeOf(l: Location): string {
  return l.name?.match(/\d+/)?.[0] ?? l.name ?? ''
}

// Row color tiers for the copy-to-Excel table, replicating the source
// spreadsheet's conditional formatting (>3 / =3 / =2 / =1 not submitted,
// green at 100%). Built as tints of the two off-palette hex values CLAUDE.md
// already sanctions (sb-red #C0392B, sb-green #2ECC71) rather than
// introducing new brand colors — progressively lighter red for fewer
// missing shops.
function tierFor(notSubmitted: number, pct: number): { bg: string; fg: string } | null {
  if (pct >= 1) return { bg: '#2ECC71', fg: '#002745' }
  if (notSubmitted > 3) return { bg: '#C0392B', fg: '#F2F1E6' }
  if (notSubmitted === 3) return { bg: '#D06B61', fg: '#F2F1E6' }
  if (notSubmitted === 2) return { bg: '#DF9C95', fg: '#002745' }
  if (notSubmitted === 1) return { bg: '#EFCDC9', fg: '#002745' }
  return null
}

const pctStr = (v: number) => `${Math.round(v * 100)}%`

interface Props {
  locations: Location[] // active locations for the company
  monthlySubmittedIds: Set<string> // location ids with a "Monthly" count this period
  periodLabel: string
}

export function AmSubmissionRollup({ locations, monthlySubmittedIds, periodLabel }: Props) {
  const loc = useLocations()
  const [hiddenAms, setHiddenAms] = useAppSetting<string[]>('monthend.hiddenAreaManagers', [])

  const allRows: AmRollupRow[] = useMemo(() => {
    const byAm = new Map<string, { submitted: number; notSubmitted: number; shops: string[] }>()
    for (const l of locations) {
      const am = loc.fieldValue(l.id, 'area_manager').trim() || 'Unassigned'
      const entry = byAm.get(am) ?? { submitted: 0, notSubmitted: 0, shops: [] }
      if (monthlySubmittedIds.has(l.id)) entry.submitted++
      else { entry.notSubmitted++; entry.shops.push(shopCodeOf(l)) }
      byAm.set(am, entry)
    }
    return [...byAm.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([am, v]) => {
        const total = v.submitted + v.notSubmitted
        return {
          am,
          submitted: v.submitted,
          notSubmitted: v.notSubmitted,
          pct: total > 0 ? v.submitted / total : 0,
          shopsNotSubmitted: [...v.shops].sort((a, b) => (Number(a) || 0) - (Number(b) || 0)),
        }
      })
  }, [locations, monthlySubmittedIds, loc])

  const rows = useMemo(() => allRows.filter((r) => !hiddenAms.includes(r.am)), [allRows, hiddenAms])

  function hideAm(am: string) {
    if (!hiddenAms.includes(am)) setHiddenAms([...hiddenAms, am])
  }
  function unhideAm(am: string) {
    setHiddenAms(hiddenAms.filter((a) => a !== am))
  }

  const totalSubmitted = rows.reduce((s, r) => s + r.submitted, 0)
  const totalNotSubmitted = rows.reduce((s, r) => s + r.notSubmitted, 0)
  const totalPct = totalSubmitted + totalNotSubmitted > 0 ? totalSubmitted / (totalSubmitted + totalNotSubmitted) : 0

  // Outstanding-only — AMs/RDs for shops still missing a Monthly count, since
  // that's who a reminder email would actually go to. Hidden AMs are left out
  // of the AM list entirely (their email shouldn't go out with this batch);
  // RD emails aren't scoped to hidden AMs since an RD oversees more than just
  // that one AM's shops.
  const outstandingAmEmails = useMemo(() => {
    const set = new Set<string>()
    for (const l of locations) {
      if (monthlySubmittedIds.has(l.id)) continue
      const am = loc.fieldValue(l.id, 'area_manager').trim() || 'Unassigned'
      if (hiddenAms.includes(am)) continue
      const e = loc.fieldValue(l.id, 'am_email').trim()
      if (e) set.add(e)
    }
    return [...set].sort()
  }, [locations, monthlySubmittedIds, hiddenAms, loc])

  const outstandingRdEmails = useMemo(() => {
    const set = new Set<string>()
    for (const l of locations) {
      if (monthlySubmittedIds.has(l.id)) continue
      const e = loc.fieldValue(l.id, 'rd_email').trim()
      if (e) set.add(e)
    }
    return [...set].sort()
  }, [locations, monthlySubmittedIds, loc])

  function copyEmails(list: string[], label: string) {
    if (!list.length) { toast(`No ${label} emails to copy`, { icon: 'ℹ️' }); return }
    navigator.clipboard.writeText(list.join(', '))
      .then(() => toast.success(`Copied ${list.length} ${label} email${list.length === 1 ? '' : 's'}`))
      .catch(() => toast.error('Copy failed'))
  }

  async function copyTable() {
    const cellStyle = (bg: string | undefined, fg: string | undefined, extra = '') =>
      `border:1px solid #4F7489;padding:4px 10px;${bg ? `background:${bg};` : ''}${fg ? `color:${fg};` : ''}${extra}`
    // Text is nested in a legacy <font color> tag, not just inline CSS —
    // Outlook's Word-based rendering engine has a long-standing bug where it
    // drops/overrides inline `color` on table cells (especially once pasted
    // through Excel first). That fallback used to land on a navy fill (cream
    // text intended) — illegible once the color's dropped. Header fill is
    // sky blue instead so the black fallback stays legible either way; the
    // intended navy text color is also wrapped in <font color> for when it
    // does survive.
    const headCell = (t: string) =>
      `<td style="border:1px solid #002745;background:#B7E0DE;color:#002745;padding:5px 10px;text-align:left;font-weight:bold;"><font color="#002745">${escapeHtml(t)}</font></td>`

    const summaryHtml =
      `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;"><tbody>` +
      `<tr>${['Submitted', 'Not Submitted', '% Submitted'].map(headCell).join('')}</tr>` +
      `<tr>` +
      `<td style="${cellStyle(undefined, '#002745', 'font-weight:bold;')}">${totalSubmitted}</td>` +
      `<td style="${cellStyle(undefined, '#002745', 'font-weight:bold;')}">${totalNotSubmitted}</td>` +
      `<td style="${cellStyle(undefined, '#002745', 'font-weight:bold;')}">${pctStr(totalPct)}</td>` +
      `</tr></tbody></table>`

    const mainHead = `<tr>${['Area Manager', 'Submitted', 'Not Submitted', '% Submitted', 'Shops Not Submitted'].map(headCell).join('')}</tr>`
    const mainBody = rows.map((r) => {
      const t = tierFor(r.notSubmitted, r.pct)
      const style = cellStyle(t?.bg, t?.fg)
      const nameStyle = cellStyle(t?.bg, t?.fg, 'font-weight:bold;')
      return `<tr>` +
        `<td style="${nameStyle}">${escapeHtml(r.am)}</td>` +
        `<td style="${style}text-align:right;">${r.submitted}</td>` +
        `<td style="${style}text-align:right;">${r.notSubmitted}</td>` +
        `<td style="${style}text-align:right;">${pctStr(r.pct)}</td>` +
        `<td style="${style}">${escapeHtml(r.shopsNotSubmitted.join(', '))}</td>` +
        `</tr>`
    }).join('')
    const mainHtml = `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;"><tbody>${mainHead}${mainBody}</tbody></table>`

    const html = `<div>${summaryHtml}<br/>${mainHtml}</div>`
    const plain = [
      ['Submitted', 'Not Submitted', '% Submitted'].join('\t'),
      [totalSubmitted, totalNotSubmitted, pctStr(totalPct)].join('\t'),
      '',
      ['Area Manager', 'Submitted', 'Not Submitted', '% Submitted', 'Shops Not Submitted'].join('\t'),
      ...rows.map((r) => [r.am, r.submitted, r.notSubmitted, pctStr(r.pct), r.shopsNotSubmitted.join(', ')].join('\t')),
    ].join('\n')

    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(plain)
      }
      toast.success('Copied — paste into Excel or Outlook')
    } catch { toast.error('Copy failed') }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Area Manager Rollup — Monthly Counts</h2>
            <p className="text-xs text-inky mt-0.5">
              {totalSubmitted} of {totalSubmitted + totalNotSubmitted} shops submitted for {periodLabel} ({pctStr(totalPct)}). Monthly count type only.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hiddenAms.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap text-[11px] font-mono text-inky/70 border border-navy/20 rounded px-2 py-1 bg-navy/[0.03] max-w-xs">
                <span className="uppercase tracking-wide text-inky/50 flex-shrink-0">Hidden:</span>
                {hiddenAms.map((am) => (
                  <span key={am} className="inline-flex items-center gap-1 text-navy">
                    {am}
                    <button onClick={() => unhideAm(am)} title="Unhide" className="text-inky/40 hover:text-[#C0392B]">×</button>
                  </span>
                ))}
              </div>
            )}
            <Button size="sm" variant="secondary" onClick={() => copyEmails(outstandingAmEmails, 'AM')}>
              Copy AM Emails ({outstandingAmEmails.length})
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copyEmails(outstandingRdEmails, 'RD')}>
              Copy RD Emails ({outstandingRdEmails.length})
            </Button>
            <Button size="sm" onClick={copyTable}>Copy Table</Button>
          </div>
        </div>

        <div className="overflow-auto max-h-[calc(100vh-360px)] rounded border border-navy/30">
          <table className="w-full text-xs font-mono border-collapse">
            <thead className="sticky top-0">
              <tr className="bg-navy text-cream">
                <th className="px-3 py-2 text-left">Area Manager</th>
                <th className="px-3 py-2 text-right">Submitted</th>
                <th className="px-3 py-2 text-right">Not Submitted</th>
                <th className="px-3 py-2 text-right">% Submitted</th>
                <th className="px-3 py-2 text-left">Shops Not Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-inky/50">No active shops.</td></tr>
              ) : rows.map((r) => {
                const t = tierFor(r.notSubmitted, r.pct)
                return (
                  <tr key={r.am} style={t ? { background: t.bg, color: t.fg } : undefined} className={!t ? 'border-b border-navy/15 text-navy' : undefined}>
                    <td className="px-3 py-1.5 font-semibold">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => hideAm(r.am)} title="Hide this Area Manager" className="flex-shrink-0 opacity-50 hover:opacity-100">
                          <EyeOff className="w-3 h-3" />
                        </button>
                        {r.am}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">{r.submitted}</td>
                    <td className="px-3 py-1.5 text-right">{r.notSubmitted}</td>
                    <td className="px-3 py-1.5 text-right">{pctStr(r.pct)}</td>
                    <td className="px-3 py-1.5">{r.shopsNotSubmitted.join(', ') || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}
