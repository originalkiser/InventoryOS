import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Select } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useVendors } from './useLookups'
import { weekStartOf } from './engine'
import { SCHEDULE_LABELS, type ScheduleType } from './types'

const sb = () => supabase as any
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DOW_LOOKUP: Record<string, number> = Object.fromEntries(DOW.map((d, i) => [d.toLowerCase(), i]))
function parseWeekday(raw: string): number | null {
  const v = DOW_LOOKUP[raw.trim().toLowerCase()]
  return v == null ? null : v
}
// "Weekly" vs a Week 1/Week 2 (= this app's existing A/B) label — matches
// however loosely the source file spells it ("Week 1", "Week1", "A").
function parseWeekPhase(raw: string): 'weekly' | 'A' | 'B' | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  if (v === 'weekly') return 'weekly'
  if (v === 'a' || /week\s*1\b/.test(v)) return 'A'
  if (v === 'b' || /week\s*2\b/.test(v)) return 'B'
  return null
}

interface ScheduleRow {
  id: string; location_id: string; vendor_id: string; schedule_type: ScheduleType
  delivery_dow: number | null; week_a_dow: number | null; week_b_dow: number | null
  lead_business_days: number
}
interface CalRow { id: string; week_start: string; week_label: 'A' | 'B' }

/**
 * Per-shop delivery schedules for vendors that don't run one weekday for
 * everyone. RelaDyne isn't configured here — it uses the delivery day on the
 * location list.
 */
export function DeliverySchedulesCard() {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()

  const [vendorId, setVendorId] = useState('')
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [cal, setCal] = useState<CalRow[]>([])

  // New/edited schedule
  const [locationId, setLocationId] = useState('')
  const [type, setType] = useState<ScheduleType>('weekly')
  const [dow, setDow] = useState('4')
  const [aDow, setADow] = useState('4')
  const [bDow, setBDow] = useState('1')
  const [lead, setLead] = useState('4')

  const load = useCallback(async () => {
    if (!profile?.company_id || !vendorId) { setRows([]); setCal([]); return }
    const [s, c] = await Promise.all([
      sb().schema('inventory').from('ov2_location_schedules').select('*')
        .eq('company_id', profile.company_id).eq('vendor_id', vendorId),
      sb().schema('inventory').from('ov2_delivery_calendar').select('id, week_start, week_label')
        .eq('company_id', profile.company_id).eq('vendor_id', vendorId).order('week_start'),
    ])
    setRows((s.data ?? []) as ScheduleRow[])
    setCal((c.data ?? []) as CalRow[])
  }, [profile?.company_id, vendorId])
  useEffect(() => { void load() }, [load])

  async function save() {
    if (!profile?.company_id || !vendorId || !locationId) return
    const { error } = await sb().schema('inventory').from('ov2_location_schedules').upsert({
      company_id: profile.company_id, location_id: locationId, vendor_id: vendorId,
      schedule_type: type,
      delivery_dow: type === 'weekly' ? Number(dow) : null,
      week_a_dow: type === 'week_ab' ? Number(aDow) : null,
      week_b_dow: type === 'week_ab' ? Number(bDow) : null,
      lead_business_days: Number(lead) || 0,
      updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,location_id,vendor_id' })
    if (error) { toast.error(error.message); return }
    toast.success('Schedule saved'); setLocationId(''); void load()
  }

  async function remove(id: string) {
    const { error } = await sb().schema('inventory').from('ov2_location_schedules').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    void load()
  }

  /**
   * Bulk schedule upload — one row per shop instead of adding each by hand.
   * Expected shape (see the real Valvoline schedule file this was built
   * against): Shop #, Order DoW, Delivery DoW, Order Week, Delivery Week,
   * optionally a Min Lead (business days) column. Only Shop #, Delivery DoW,
   * and Delivery Week actually drive what gets saved — Order DoW/Order Week
   * describe the same cycle from the other end but aren't needed here:
   *   - Delivery Week "Weekly"  -> schedule_type 'weekly', delivery_dow set.
   *   - Delivery Week "Week 1"/"Week 2" (this app's A/B) -> schedule_type
   *     'week_ab', with ONLY that phase's day set and the other phase left
   *     null — resolveDeliveryDate() (engine.ts) already treats a null
   *     week_a_dow/week_b_dow as "skip this week, don't guess," which is
   *     exactly biweekly-on-one-phase-only behavior, not a second weekday.
   *   - Delivery DoW "Order +N" (a literal turnaround, not a weekday name)
   *     -> schedule_type 'plus_business_days', lead = N.
   * A Min Lead column is used when present; otherwise defaults to 4 (this
   * card's own manual-add default) for weekly/week_ab rows.
   */
  async function importSchedules(parsed: { headers: string[]; rows: Record<string, string>[] }) {
    if (!profile?.company_id || !vendorId) { toast.error('Pick a vendor first'); return }
    const shopCol = parsed.headers.find((h) => /shop|store|location/i.test(h))
    const deliveryDowCol = parsed.headers.find((h) => /deliver.*d(ay|ow)\b/i.test(h))
    const deliveryWeekCol = parsed.headers.find((h) => /deliver.*week/i.test(h))
    const leadCol = parsed.headers.find((h) => /lead/i.test(h))
    if (!shopCol || !deliveryDowCol) {
      toast.error('Need a Shop # column and a Delivery DoW column')
      return
    }

    const payload: Record<string, unknown>[] = []
    const unmatchedShops: string[] = []
    const unreadableRows: string[] = []
    for (const r of parsed.rows) {
      const shopRaw = (r[shopCol] ?? '').trim()
      if (!shopRaw) continue
      const locationId = loc.resolveId(shopRaw)
      if (!locationId) { unmatchedShops.push(shopRaw); continue }

      const deliveryRaw = (r[deliveryDowCol] ?? '').trim()
      const plusMatch = deliveryRaw.match(/order\s*\+?\s*(\d+)/i)
      const leadRaw = leadCol ? Number(r[leadCol]) : NaN
      const lead = Number.isFinite(leadRaw) && leadRaw > 0 ? leadRaw : 4

      let row: Pick<ScheduleRow, 'schedule_type' | 'delivery_dow' | 'week_a_dow' | 'week_b_dow' | 'lead_business_days'>
      if (plusMatch) {
        row = { schedule_type: 'plus_business_days', delivery_dow: null, week_a_dow: null, week_b_dow: null, lead_business_days: Number(plusMatch[1]) }
      } else {
        const deliveryDow = parseWeekday(deliveryRaw)
        const phase = deliveryWeekCol ? parseWeekPhase(r[deliveryWeekCol] ?? '') : 'weekly'
        if (deliveryDow == null || phase == null) { unreadableRows.push(shopRaw); continue }
        row = phase === 'weekly'
          ? { schedule_type: 'weekly', delivery_dow: deliveryDow, week_a_dow: null, week_b_dow: null, lead_business_days: lead }
          : { schedule_type: 'week_ab', delivery_dow: null, week_a_dow: phase === 'A' ? deliveryDow : null, week_b_dow: phase === 'B' ? deliveryDow : null, lead_business_days: lead }
      }
      payload.push({
        company_id: profile.company_id, location_id: locationId, vendor_id: vendorId,
        ...row, updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
      })
    }
    if (!payload.length) { toast.error('No usable rows found'); return }
    const { error } = await sb().schema('inventory').from('ov2_location_schedules')
      .upsert(payload, { onConflict: 'company_id,location_id,vendor_id' })
    if (error) { toast.error(error.message); return }
    const problems = [
      unmatchedShops.length ? `${unmatchedShops.length} shop(s) not matched (${unmatchedShops.slice(0, 5).join(', ')}${unmatchedShops.length > 5 ? '…' : ''})` : '',
      unreadableRows.length ? `${unreadableRows.length} row(s) with an unreadable day/week value` : '',
    ].filter(Boolean).join(' — ')
    if (problems) toast(`Loaded ${payload.length} schedule${payload.length !== 1 ? 's' : ''} — ${problems}`, { icon: '⚠️', duration: 10000 })
    else toast.success(`Loaded ${payload.length} schedule${payload.length !== 1 ? 's' : ''}`)
    void load()
  }

  /**
   * Calendar upload: any sheet with a date column and an A/B column. Each row
   * is normalised to the Sunday of its week, so an upload listing delivery
   * dates works as well as one listing week-start dates.
   */
  async function importCalendar(parsed: { headers: string[]; rows: Record<string, string>[] }) {
    if (!profile?.company_id || !vendorId) { toast.error('Pick a vendor first'); return }
    // A literal "Date"+"Week" header pair (the common real-world shape — see
    // the sample file this was built against) used to fail outright: the
    // date matcher's own `date|week` alternation is deliberately broad (also
    // accepts "Week Start"/"Week Of" as the date column when there's no
    // literal "Date" header), but that meant a bare "Week" column matched
    // dateCol first and never got a chance to be tried as the label column.
    // Prefer a literal "date" header for dateCol; only fall back to a
    // week-start-ish header when there isn't one. The label matcher then
    // accepts an exact "Week" header (not just "Week Type"/"A/B") once it's
    // no longer needed for the date slot.
    const dateCol =
      parsed.headers.find((h) => /date/i.test(h)) ??
      parsed.headers.find((h) => /week/i.test(h) && /start|of/i.test(h))
    const labelCol = parsed.headers.find((h) => h !== dateCol && /^week$|label|week.?type|a.?\/?.?b/i.test(h))
    if (!dateCol || !labelCol) {
      toast.error('Need a date column and an A/B label column')
      return
    }
    const seen = new Map<string, 'A' | 'B'>()
    for (const r of parsed.rows) {
      const raw = (r[dateCol] ?? '').trim()
      const label = (r[labelCol] ?? '').trim().toUpperCase()
      if (!raw || (label !== 'A' && label !== 'B')) continue
      const d = new Date(raw)
      if (Number.isNaN(d.getTime())) continue
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      seen.set(weekStartOf(iso), label as 'A' | 'B')
    }
    if (!seen.size) { toast.error('No usable rows found'); return }
    const payload = [...seen.entries()].map(([week_start, week_label]) => ({
      company_id: profile.company_id, vendor_id: vendorId, week_start, week_label,
      updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }))
    const { error } = await sb().schema('inventory').from('ov2_delivery_calendar')
      .upsert(payload, { onConflict: 'company_id,vendor_id,week_start' })
    if (error) { toast.error(error.message); return }
    toast.success(`Loaded ${payload.length} week${payload.length !== 1 ? 's' : ''}`)
    void load()
  }

  async function clearCalendar() {
    if (!profile?.company_id || !vendorId) return
    if (!confirm('Remove every A/B week for this vendor?')) return
    await sb().schema('inventory').from('ov2_delivery_calendar')
      .delete().eq('company_id', profile.company_id).eq('vendor_id', vendorId)
    void load()
  }

  const shopLabel = (id: string) => loc.fieldValue(id, 'shop_city') || loc.codeOf(id) || id
  const describe = (r: ScheduleRow) => {
    if (r.schedule_type === 'plus_business_days') return `+${r.lead_business_days} business days`
    if (r.schedule_type === 'week_ab') {
      return `A: ${r.week_a_dow == null ? '—' : DOW[r.week_a_dow]} · B: ${r.week_b_dow == null ? '—' : DOW[r.week_b_dow]} (${r.lead_business_days}d lead)`
    }
    return `${r.delivery_dow == null ? '—' : DOW[r.delivery_dow]} weekly (${r.lead_business_days}d lead)`
  }
  const usesCalendar = rows.some((r) => r.schedule_type === 'week_ab')

  return (
    <Card><CardBody className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Delivery Schedules</h3>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5">
          For vendors whose shops don&apos;t share one delivery day. Shops are on a fixed weekday, on alternating
          A/B weekdays, or on a flat business-day turnaround. RelaDyne isn&apos;t set here — it uses the delivery day
          on the location list.
        </p>
      </div>

      <div className="w-64">
        <Combobox label="Vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
      </div>

      {vendorId && (
        <>
          {/* Existing schedules */}
          <div className="overflow-auto max-h-72 rounded border border-navy/20">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Pattern</th>
                <th className="text-left px-2 py-1">Schedule</th><th />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-navy/10">
                    <td className="px-2 py-1 text-navy">{shopLabel(r.location_id)}</td>
                    <td className="px-2 py-1 text-inky/70">{SCHEDULE_LABELS[r.schedule_type]}</td>
                    <td className="px-2 py-1 text-navy">{describe(r)}</td>
                    <td className="px-2 py-1 text-right">
                      <button onClick={() => remove(r.id)} className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="px-2 py-4 text-center text-inky/40">
                    No schedules — these shops fall back to the location list&apos;s delivery day.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Add / update */}
          <div className="flex items-end gap-2 flex-wrap border-t border-navy/10 pt-3">
            <div className="w-56"><Combobox label="Shop" options={loc.includedOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" /></div>
            <div className="w-56">
              <Select label="Pattern" value={type} onChange={(e) => setType(e.target.value as ScheduleType)}
                options={(Object.keys(SCHEDULE_LABELS) as ScheduleType[]).map((t) => ({ value: t, label: SCHEDULE_LABELS[t] }))} />
            </div>
            {type === 'weekly' && (
              <div className="w-36"><Select label="Delivery day" value={dow} onChange={(e) => setDow(e.target.value)}
                options={DOW.map((d, i) => ({ value: String(i), label: d }))} /></div>
            )}
            {type === 'week_ab' && (
              <>
                <div className="w-36"><Select label="Week A day" value={aDow} onChange={(e) => setADow(e.target.value)}
                  options={DOW.map((d, i) => ({ value: String(i), label: d }))} /></div>
                <div className="w-36"><Select label="Week B day" value={bDow} onChange={(e) => setBDow(e.target.value)}
                  options={DOW.map((d, i) => ({ value: String(i), label: d }))} /></div>
              </>
            )}
            <Input label={type === 'plus_business_days' ? 'Turnaround (business days)' : 'Min lead (business days)'}
              type="number" min={0} value={lead} onChange={(e) => setLead(e.target.value)} className="w-40" />
            <Button size="sm" variant="secondary" disabled={!locationId} onClick={save}>Save schedule</Button>
          </div>
          <p className="text-[10px] font-mono text-inky/50">
            Min lead: a delivery day closer than this many business days is skipped and the next occurrence used —
            so an order placed too near the cutoff lands on the following delivery instead.
          </p>

          {/* Bulk schedule upload */}
          <div className="border-t border-navy/10 pt-3 flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
              Bulk upload — one row per shop, instead of adding each above
            </span>
            <p className="text-[11px] font-mono text-inky/60">
              Columns: <span className="text-navy">Shop #</span>, <span className="text-navy">Delivery DoW</span> (a
              weekday name, or &quot;Order +N&quot; for a flat N-business-day turnaround), and{' '}
              <span className="text-navy">Delivery Week</span> (&quot;Weekly&quot;, or &quot;Week 1&quot;/&quot;Week 2&quot;
              for this vendor&apos;s A/B pattern — Week 1 = A, Week 2 = B). An optional{' '}
              <span className="text-navy">Min Lead</span> column overrides the default of 4 business days.
              Order DoW / Order Week columns are fine to leave in the file — they aren&apos;t read.
            </p>
            <FileUploadZone onParsed={(r) => importSchedules(r)} label="Drop a CSV / Excel with Shop #, Delivery DoW, Delivery Week" />
          </div>

          {/* A/B calendar */}
          <div className="border-t border-navy/10 pt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
                Week A / B calendar ({cal.length} week{cal.length !== 1 ? 's' : ''})
              </span>
              {cal.length > 0 && (
                <button onClick={clearCalendar} className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] hover:underline">clear</button>
              )}
            </div>
            <p className="text-[11px] font-mono text-inky/60">
              Upload a sheet with a date column and an A/B column. Dates are normalised to the Sunday of their week,
              so a list of delivery dates works as well as a list of week starts. A week with no entry is skipped
              rather than guessed at — so gaps show up as a missing delivery date, not a wrong one.
            </p>
            {usesCalendar && cal.length === 0 && (
              <p className="text-[11px] font-mono text-[#C0392B]">
                Shops here are on an A/B pattern but no calendar is loaded — their delivery dates will be blank until
                one is.
              </p>
            )}
            <FileUploadZone onParsed={(r) => importCalendar(r)} label="Drop a CSV / Excel with date + A/B columns" />
            {cal.length > 0 && (
              <div className="overflow-auto max-h-40 rounded border border-navy/20">
                <table className="w-full text-[11px] font-mono">
                  <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                    <th className="text-left px-2 py-1">Week starting</th><th className="text-left px-2 py-1">Label</th>
                  </tr></thead>
                  <tbody>
                    {cal.map((c) => (
                      <tr key={c.id} className="border-b border-navy/10">
                        <td className="px-2 py-1 text-navy">{String(c.week_start).slice(0, 10)}</td>
                        <td className="px-2 py-1 text-navy">{c.week_label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </CardBody></Card>
  )
}
