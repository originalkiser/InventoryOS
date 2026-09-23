import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Select } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useVendors } from './useLookups'
import { weekStartOf, businessDaysBetween, daysBetween } from './engine'
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
// Local-time YYYY-MM-DD — a date cell parsed via `cellDates`/`new Date(...)`
// must never round-trip through toISOString() (UTC), which can shift a
// midnight-local date to the previous day.
function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
function mode(nums: number[]): number {
  const counts = new Map<number, number>()
  for (const v of nums) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = nums[0], bestCount = 0
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; best = k }
  return best
}

interface ScheduleRow {
  id: string; location_id: string; vendor_id: string; schedule_type: ScheduleType
  delivery_dow: number | null; week_a_dow: number | null; week_b_dow: number | null
  lead_business_days: number
}
interface CalRow { id: string; week_start: string; week_label: 'A' | 'B' }
interface HistorySuggestion {
  shopRaw: string
  locationId: string | null
  sampleSize: number
  suggestion: Pick<ScheduleRow, 'schedule_type' | 'delivery_dow' | 'week_a_dow' | 'week_b_dow' | 'lead_business_days'> | null
  note: string
}

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
  const [historyAnalysis, setHistoryAnalysis] = useState<HistorySuggestion[] | null>(null)
  const [applyingAll, setApplyingAll] = useState(false)

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
      seen.set(weekStartOf(toIsoDate(d)), label as 'A' | 'B')
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

  /**
   * Order history analysis — instead of manually working out each shop's
   * pattern, infer it from real past orders (built against a real Valvoline
   * customer-order export: Sales Organization / Ship To Account / PO Number
   * / PO Date / Request Delivery Date / ... / sboc_shop_number). Produces a
   * PREVIEW of a suggested schedule per shop — nothing is saved until the
   * user applies a row (or Apply All), same "review before commit" shape as
   * every import in this app that can't be perfectly certain of its own
   * read (Template 4, TABLE_TEMPLATES.md).
   *
   * Per shop: dedupe to one (order date, delivery date) pair per real order
   * (a PO's several line items would otherwise be counted as separate
   * orders), then:
   *   - One consistent delivery weekday, ~weekly cadence between orders
   *     -> 'weekly'.
   *   - One consistent delivery weekday, ~biweekly cadence -> 'week_ab',
   *     but only if the ALREADY-uploaded A/B calendar covers every one of
   *     those delivery dates and they all land in the SAME labelled week —
   *     otherwise there's no way to know which phase it belongs to, so it's
   *     reported but left unsuggested rather than guessed at.
   *   - Two consistent delivery weekdays that line up exactly with the A/B
   *     calendar (weekday X on every A week, weekday Y on every B week)
   *     -> 'week_ab' with both phases set.
   *   - Otherwise, a consistent order-to-delivery business-day gap
   *     regardless of weekday -> 'plus_business_days'.
   *   - Anything else is reported as irregular with no suggestion — a human
   *     call, not a guess.
   * Lead/turnaround suggestions use the median observed business-day gap.
   */
  async function analyzeOrderHistory(parsed: { headers: string[]; rows: Record<string, string>[] }) {
    if (!profile?.company_id || !vendorId) { toast.error('Pick a vendor first'); return }
    const shopCol = parsed.headers.find((h) => /sboc.?shop|shop.?num/i.test(h))
    const poCol = parsed.headers.find((h) => /po\s*number/i.test(h))
    const orderDateCol = parsed.headers.find((h) => /po.*date/i.test(h))
    const deliveryDateCol = parsed.headers.find((h) => /deliver.*date/i.test(h))
    if (!shopCol || !orderDateCol || !deliveryDateCol) {
      toast.error('Need a shop column, an order/PO date column, and a delivery date column')
      return
    }

    const seenKeys = new Set<string>()
    const byShop = new Map<string, { orderDate: string; deliveryDate: string }[]>()
    for (const r of parsed.rows) {
      const shopRaw = (r[shopCol] ?? '').trim()
      const orderRaw = (r[orderDateCol] ?? '').trim()
      const deliveryRaw = (r[deliveryDateCol] ?? '').trim()
      if (!shopRaw || !orderRaw || !deliveryRaw) continue
      const od = new Date(orderRaw)
      const dd = new Date(deliveryRaw)
      if (Number.isNaN(od.getTime()) || Number.isNaN(dd.getTime())) continue
      const orderDate = toIsoDate(od)
      const deliveryDate = toIsoDate(dd)
      // Dedupe by PO number when present — several rows (line items) share
      // one PO/one real order. Falls back to the date pair itself so a file
      // with no PO column still dedupes exact repeats.
      const poRaw = poCol ? (r[poCol] ?? '').trim() : ''
      const key = `${shopRaw}|${poRaw || `${orderDate}|${deliveryDate}`}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      const list = byShop.get(shopRaw) ?? []
      list.push({ orderDate, deliveryDate })
      byShop.set(shopRaw, list)
    }
    if (!byShop.size) { toast.error('No usable rows found'); return }

    const calMap = new Map<string, 'A' | 'B'>()
    for (const c of cal) calMap.set(String(c.week_start).slice(0, 10), c.week_label)

    const results: HistorySuggestion[] = []
    for (const [shopRaw, pairs] of byShop) {
      const locationId = loc.resolveId(shopRaw)
      if (!locationId) { results.push({ shopRaw, locationId: null, sampleSize: pairs.length, suggestion: null, note: 'Shop not matched' }); continue }
      if (pairs.length < 2) { results.push({ shopRaw, locationId, sampleSize: pairs.length, suggestion: null, note: 'Not enough history (need at least 2 orders)' }); continue }

      const deliveryDows = pairs.map((p) => new Date(p.deliveryDate + 'T00:00:00').getDay())
      const bizGaps = pairs.map((p) => businessDaysBetween(p.orderDate, p.deliveryDate))
      const distinctDows = [...new Set(deliveryDows)]
      const sortedOrderDates = [...pairs.map((p) => p.orderDate)].sort()
      const orderGaps: number[] = []
      for (let i = 1; i < sortedOrderDates.length; i++) orderGaps.push(daysBetween(sortedOrderDates[i - 1], sortedOrderDates[i]))
      const cadence = orderGaps.length ? median(orderGaps) : 7
      const lead = Math.max(0, Math.round(median(bizGaps)))

      if (distinctDows.length === 1) {
        const dow = distinctDows[0]
        if (cadence >= 10 && cadence <= 18) {
          const labels = pairs.map((p) => calMap.get(weekStartOf(p.deliveryDate)))
          const fullyLabeled = labels.every((l) => l != null)
          const distinctLabels = [...new Set(labels)]
          if (fullyLabeled && distinctLabels.length === 1) {
            const phase = distinctLabels[0] as 'A' | 'B'
            results.push({
              shopRaw, locationId, sampleSize: pairs.length,
              suggestion: { schedule_type: 'week_ab', delivery_dow: null, week_a_dow: phase === 'A' ? dow : null, week_b_dow: phase === 'B' ? dow : null, lead_business_days: lead },
              note: `Every ~2 weeks on ${DOW[dow]}, always Week ${phase === 'A' ? '1' : '2'}`,
            })
          } else {
            results.push({ shopRaw, locationId, sampleSize: pairs.length, suggestion: null, note: `Every ~2 weeks on ${DOW[dow]}, but the A/B calendar doesn't fully cover these dates — extend it to confirm the phase` })
          }
        } else {
          results.push({
            shopRaw, locationId, sampleSize: pairs.length,
            suggestion: { schedule_type: 'weekly', delivery_dow: dow, week_a_dow: null, week_b_dow: null, lead_business_days: lead },
            note: `Always ${DOW[dow]}`,
          })
        }
        continue
      }

      // Multiple delivery weekdays — see if they line up cleanly with the A/B calendar.
      const byLabel = new Map<'A' | 'B', Set<number>>()
      let fullyLabeled = true
      for (const p of pairs) {
        const label = calMap.get(weekStartOf(p.deliveryDate))
        if (!label) { fullyLabeled = false; break }
        if (!byLabel.has(label)) byLabel.set(label, new Set())
        byLabel.get(label)!.add(new Date(p.deliveryDate + 'T00:00:00').getDay())
      }
      const aDows = byLabel.get('A')
      const bDows = byLabel.get('B')
      if (fullyLabeled && aDows?.size === 1 && bDows?.size === 1) {
        const aDow = [...aDows][0], bDow = [...bDows][0]
        results.push({
          shopRaw, locationId, sampleSize: pairs.length,
          suggestion: { schedule_type: 'week_ab', delivery_dow: null, week_a_dow: aDow, week_b_dow: bDow, lead_business_days: lead },
          note: `Week 1: ${DOW[aDow]} · Week 2: ${DOW[bDow]}`,
        })
        continue
      }

      const gapMode = mode(bizGaps)
      const consistentGap = bizGaps.filter((g) => Math.abs(g - gapMode) <= 1).length / bizGaps.length >= 0.7
      if (consistentGap) {
        results.push({
          shopRaw, locationId, sampleSize: pairs.length,
          suggestion: { schedule_type: 'plus_business_days', delivery_dow: null, week_a_dow: null, week_b_dow: null, lead_business_days: gapMode },
          note: `Delivery lands ~${gapMode} business day${gapMode === 1 ? '' : 's'} after ordering, regardless of weekday`,
        })
      } else {
        results.push({ shopRaw, locationId, sampleSize: pairs.length, suggestion: null, note: `Irregular — saw ${distinctDows.map((d) => DOW[d]).join(', ')}, no clear pattern` })
      }
    }
    setHistoryAnalysis(results.sort((a, b) => a.shopRaw.localeCompare(b.shopRaw, undefined, { numeric: true })))
  }

  async function applySuggestion(s: HistorySuggestion) {
    if (!profile?.company_id || !vendorId || !s.suggestion || !s.locationId) return
    const { error } = await sb().schema('inventory').from('ov2_location_schedules').upsert({
      company_id: profile.company_id, location_id: s.locationId, vendor_id: vendorId,
      ...s.suggestion, updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,location_id,vendor_id' })
    if (error) { toast.error(error.message); return }
    toast.success(`Saved schedule for ${shopLabel(s.locationId)}`)
    setHistoryAnalysis((prev) => prev?.filter((x) => x !== s) ?? null)
    void load()
  }

  async function applyAllSuggestions() {
    if (!profile?.company_id || !vendorId || !historyAnalysis) return
    const applicable = historyAnalysis.filter((s): s is HistorySuggestion & { locationId: string; suggestion: NonNullable<HistorySuggestion['suggestion']> } => !!s.suggestion && !!s.locationId)
    if (!applicable.length) return
    setApplyingAll(true)
    const payload = applicable.map((s) => ({
      company_id: profile.company_id, location_id: s.locationId, vendor_id: vendorId,
      ...s.suggestion, updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }))
    const { error } = await sb().schema('inventory').from('ov2_location_schedules').upsert(payload, { onConflict: 'company_id,location_id,vendor_id' })
    setApplyingAll(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Applied ${payload.length} suggested schedule${payload.length !== 1 ? 's' : ''}`)
    setHistoryAnalysis((prev) => prev?.filter((x) => !x.suggestion || !x.locationId) ?? null)
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

          {/* Order history analysis */}
          <div className="border-t border-navy/10 pt-3 flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
              Suggest schedules from order history
            </span>
            <p className="text-[11px] font-mono text-inky/60">
              Upload past orders (a shop column, an order/PO date, and a delivery date — e.g. a Valvoline customer
              order export) and each shop&apos;s pattern is inferred from when it actually ordered vs. delivered.
              Nothing is saved until you apply a suggestion below — upload the A/B calendar above first if any shops
              are on a biweekly pattern, so it can be detected correctly.
            </p>
            <FileUploadZone onParsed={(r) => analyzeOrderHistory(r)} label="Drop a CSV / Excel of past orders" />
            {historyAnalysis && (
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-inky/60">
                    {historyAnalysis.length} shop{historyAnalysis.length !== 1 ? 's' : ''} analyzed
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm" variant="secondary" disabled={applyingAll || !historyAnalysis.some((s) => s.suggestion && s.locationId)}
                      onClick={applyAllSuggestions}
                    >
                      Apply all ({historyAnalysis.filter((s) => s.suggestion && s.locationId).length})
                    </Button>
                    <button onClick={() => setHistoryAnalysis(null)} className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] hover:underline">
                      dismiss
                    </button>
                  </div>
                </div>
                <div className="overflow-auto max-h-96 rounded border border-navy/20">
                  <table className="w-full text-[11px] font-mono">
                    <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                      <th className="text-left px-2 py-1">Shop</th><th className="text-right px-2 py-1">Orders</th>
                      <th className="text-left px-2 py-1">Suggested Schedule</th><th className="text-left px-2 py-1">Note</th><th />
                    </tr></thead>
                    <tbody>
                      {historyAnalysis.map((s) => (
                        <tr key={s.shopRaw} className="border-b border-navy/10">
                          <td className="px-2 py-1 text-navy whitespace-nowrap">{s.locationId ? shopLabel(s.locationId) : s.shopRaw}</td>
                          <td className="px-2 py-1 text-right text-inky/70">{s.sampleSize}</td>
                          <td className="px-2 py-1 text-navy">
                            {s.suggestion ? `${SCHEDULE_LABELS[s.suggestion.schedule_type]} — ${describe({ ...s.suggestion, id: '', location_id: '', vendor_id: '' })}` : '—'}
                          </td>
                          <td className="px-2 py-1 text-inky/60">{s.note}</td>
                          <td className="px-2 py-1 text-right">
                            {s.suggestion && s.locationId && (
                              <Button size="sm" variant="secondary" onClick={() => applySuggestion(s)}>Apply</Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </CardBody></Card>
  )
}
