// Staffing Alerts — evaluates every enabled inventory.staffing_alert_rule
// against real staffing/order data and replaces the company's entire
// inventory.staffing_alert_violations set with whatever's true as of this
// run (a snapshot, not a history log — see that table's own migration
// comment). Runs on the Data Connections dispatcher's existing schedule
// (connection_key 'staffing_alerts', a 'daily' schedule row) exactly like
// heatmap_rollup_refresh/run-automated-checks, plus a manual "Run Now"
// from the Alerts tab for an immediate refresh right after adding/editing
// a rule rather than waiting for the next scheduled tick.
//
// Evaluation period per KPI (fixed, not a per-rule field):
//   lhce / labor_pct_revenue / daily_hours_shop / daily_hours_employee -> YESTERDAY
//   weekly_hours_shop / weekly_hours_employee -> the last COMPLETED week
//     (Sunday-start, matching this app's existing week convention)
// Both periods are always covered by ONE fetch range [lastWeekStart,
// yesterday] — lastWeekEnd is always <= yesterday (since the current
// week's start is always <= today), so there's no gap to fetch twice.
//
// "Apply to all shops" for a shop/company-level KPI (lhce,
// labor_pct_revenue, daily/weekly_hours_shop) means every eligible shop
// gets checked against the same threshold individually — NOT that every
// shop's numbers get rolled into one combined company figure first.
//
// Same dual-auth shape as heatmap-rollup-refresh (reuses
// DATA_CONNECTION_DISPATCH_SECRET, no secret of its own) — this function
// is only ever invoked by the dispatcher or an admin's own "Run Now".
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const PAGE = 1000
async function fetchAllPages<T>(build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    all.push(...batch)
    if (batch.length < PAGE) break
  }
  return all
}

function numOrNull(v: unknown): number { return v != null && Number.isFinite(Number(v)) ? Number(v) : 0 }
function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }

interface Rule {
  id: string
  company_id: string
  kpi: 'lhce' | 'labor_pct_revenue' | 'daily_hours_employee' | 'weekly_hours_employee' | 'daily_hours_shop' | 'weekly_hours_shop'
  operator: 'gt' | 'lt' | 'between'
  threshold_low: number
  threshold_high: number | null
  scope: 'all' | 'selected'
  location_ids: string[]
  enabled: boolean
}

function violatesThreshold(rule: Rule, value: number): boolean {
  if (rule.operator === 'gt') return value > rule.threshold_low
  if (rule.operator === 'lt') return value < rule.threshold_low
  // between — inclusive both ends
  const high = rule.threshold_high ?? rule.threshold_low
  return value >= rule.threshold_low && value <= high
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const dispatchSecret = Deno.env.get('DATA_CONNECTION_DISPATCH_SECRET')

    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    let authorized = !!dispatchSecret && suppliedSecret === dispatchSecret
    let companyId: string | null = null
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as any

    if (authorized) {
      const { data: anyLoc } = await admin.schema('core').from('locations').select('company_id').limit(1).maybeSingle()
      companyId = anyLoc?.company_id ?? null
    } else {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (authHeader) {
        const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
        const { data: who, error: whoErr } = await caller.auth.getUser()
        if (!whoErr && who.user) {
          authorized = true
          const { data: me } = await (caller as any).schema('platform').from('user_profiles').select('company_id').eq('id', who.user.id).single()
          companyId = me?.company_id ?? null
        }
      }
    }
    if (!authorized || !companyId) return ok({ error: 'Not authorized' })

    const { data: rules, error: rulesErr } = await admin
      .schema('inventory').from('staffing_alert_rules').select('*').eq('company_id', companyId).eq('enabled', true)
    if (rulesErr) return ok({ error: rulesErr.message })
    const activeRules = (rules ?? []) as Rule[]
    if (!activeRules.length) {
      // Still clear out any stale violations from rules that got disabled/deleted.
      await admin.schema('inventory').from('staffing_alert_violations').delete().eq('company_id', companyId)
      return ok({ success: true, rules_checked: 0, violations_found: 0 })
    }

    // ---- Date ranges -----------------------------------------------------
    const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0)
    const yesterdayUtc = new Date(todayUtc); yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1)
    const yesterdayStr = isoDate(yesterdayUtc)
    const currentWeekStart = new Date(todayUtc); currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - currentWeekStart.getUTCDay())
    const lastWeekStart = new Date(currentWeekStart); lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7)
    const lastWeekEnd = new Date(currentWeekStart); lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1)
    const lastWeekStartStr = isoDate(lastWeekStart)
    const lastWeekEndStr = isoDate(lastWeekEnd)
    // lastWeekEnd is always <= yesterday (currentWeekStart <= today), so one
    // fetch range covers both the daily and weekly evaluation windows.
    const fetchStartIso = `${lastWeekStartStr}T00:00:00.000Z`
    const fetchEndIso = `${yesterdayStr}T23:59:59.999Z`

    // ---- Shops + shop labels — same Droptop-eligible scope as every other
    // Droptop feature (has a droptop_operation_id set) — without this, a
    // shop/company-level "all shops" rule would also flag every non-
    // Droptop location as "0 hours" (a false violation, not a real gap).
    const { data: locs, error: locErr } = await admin.schema('core').from('locations')
      .select('id, name, shop_city').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
    if (locErr) return ok({ error: locErr.message })
    const shopLabel = new Map((locs ?? []).map((l: { id: string; name: string; shop_city: string | null }) =>
      [l.id, l.shop_city ? `${l.name}-${l.shop_city}` : l.name]))

    // ---- Raw data for the whole window, aggregated once and reused by
    // every rule (rather than a separate fetch per rule) ------------------
    interface TR { location_id: string; droptop_user_id: string; first_name: string | null; last_name: string | null; clock_in: string; hours: string | number | null; hourly_wage: string | number | null }
    interface OR { location_id: string | null; order_finalized_at: string | null; final_price: string | number | null; status: string | null }
    const timeRecords = await fetchAllPages<TR>((from) => admin.schema('inventory').from('droptop_time_records')
      .select('location_id, droptop_user_id, first_name, last_name, clock_in, hours, hourly_wage')
      .eq('company_id', companyId).gte('clock_in', fetchStartIso).lte('clock_in', fetchEndIso)
      .range(from, from + PAGE - 1))
    const orders = await fetchAllPages<OR>((from) => admin.schema('inventory').from('droptop_orders')
      .select('location_id, order_finalized_at, final_price, status')
      .eq('company_id', companyId).gte('order_finalized_at', fetchStartIso).lte('order_finalized_at', fetchEndIso)
      .range(from, from + PAGE - 1))

    // location|date -> hours/laborDollars ; location|user|date -> {hours, name}
    const shopDayHours = new Map<string, number>()
    const shopDayDollars = new Map<string, number>()
    const empDayHours = new Map<string, { hours: number; name: string; locationId: string; userId: string }>()
    for (const t of timeRecords) {
      const date = t.clock_in.slice(0, 10)
      const hours = numOrNull(t.hours)
      const wage = numOrNull(t.hourly_wage)
      const shopKey = `${t.location_id}|${date}`
      shopDayHours.set(shopKey, (shopDayHours.get(shopKey) ?? 0) + hours)
      shopDayDollars.set(shopKey, (shopDayDollars.get(shopKey) ?? 0) + hours * wage)
      const empKey = `${t.location_id}|${t.droptop_user_id}|${date}`
      const e = empDayHours.get(empKey) ?? { hours: 0, name: [t.first_name, t.last_name].filter(Boolean).join(' ') || t.droptop_user_id, locationId: t.location_id, userId: t.droptop_user_id }
      e.hours += hours
      empDayHours.set(empKey, e)
    }
    // location|date -> {orders, revenue} — Finalized only, matching the
    // app-wide "effective car" convention (Staffing Report/Droptop Orders).
    const shopDayOrders = new Map<string, number>()
    const shopDayRevenue = new Map<string, number>()
    for (const o of orders) {
      if (!o.location_id || o.status !== 'Finalized' || !o.order_finalized_at) continue
      const date = o.order_finalized_at.slice(0, 10)
      const key = `${o.location_id}|${date}`
      shopDayOrders.set(key, (shopDayOrders.get(key) ?? 0) + 1)
      shopDayRevenue.set(key, (shopDayRevenue.get(key) ?? 0) + numOrNull(o.final_price))
    }

    const weekDates: string[] = []
    for (let d = new Date(lastWeekStart); d <= lastWeekEnd; d.setUTCDate(d.getUTCDate() + 1)) weekDates.push(isoDate(d))

    function shopIdsForRule(rule: Rule): string[] {
      const allIds = [...shopLabel.keys()]
      if (rule.scope === 'all') return allIds
      return allIds.filter((id) => rule.location_ids.includes(id))
    }

    interface ViolationRow {
      rule_id: string; company_id: string; location_id: string | null; shop_label: string | null
      droptop_user_id: string | null; employee_name: string | null
      period_start: string; period_end: string; actual_value: number; rule_snapshot: unknown
    }
    const violations: ViolationRow[] = []

    for (const rule of activeRules) {
      const snapshot = { kpi: rule.kpi, operator: rule.operator, threshold_low: rule.threshold_low, threshold_high: rule.threshold_high, scope: rule.scope }
      if (rule.kpi === 'daily_hours_shop') {
        for (const locId of shopIdsForRule(rule)) {
          const value = shopDayHours.get(`${locId}|${yesterdayStr}`) ?? 0
          if (violatesThreshold(rule, value)) {
            violations.push({ rule_id: rule.id, company_id: companyId, location_id: locId, shop_label: shopLabel.get(locId) ?? locId, droptop_user_id: null, employee_name: null, period_start: yesterdayStr, period_end: yesterdayStr, actual_value: value, rule_snapshot: snapshot })
          }
        }
      } else if (rule.kpi === 'weekly_hours_shop') {
        for (const locId of shopIdsForRule(rule)) {
          const value = weekDates.reduce((sum, d) => sum + (shopDayHours.get(`${locId}|${d}`) ?? 0), 0)
          if (violatesThreshold(rule, value)) {
            violations.push({ rule_id: rule.id, company_id: companyId, location_id: locId, shop_label: shopLabel.get(locId) ?? locId, droptop_user_id: null, employee_name: null, period_start: lastWeekStartStr, period_end: lastWeekEndStr, actual_value: value, rule_snapshot: snapshot })
          }
        }
      } else if (rule.kpi === 'lhce' || rule.kpi === 'labor_pct_revenue') {
        for (const locId of shopIdsForRule(rule)) {
          const key = `${locId}|${yesterdayStr}`
          const hours = shopDayHours.get(key) ?? 0
          const dollars = shopDayDollars.get(key) ?? 0
          const ordersCount = shopDayOrders.get(key) ?? 0
          const revenue = shopDayRevenue.get(key) ?? 0
          const value = rule.kpi === 'lhce'
            ? (ordersCount > 0 ? hours / ordersCount : null)
            : (revenue > 0 ? (dollars / revenue) * 100 : null)
          if (value != null && violatesThreshold(rule, value)) {
            violations.push({ rule_id: rule.id, company_id: companyId, location_id: locId, shop_label: shopLabel.get(locId) ?? locId, droptop_user_id: null, employee_name: null, period_start: yesterdayStr, period_end: yesterdayStr, actual_value: value, rule_snapshot: snapshot })
          }
        }
      } else if (rule.kpi === 'daily_hours_employee') {
        const allowedShops = new Set(shopIdsForRule(rule))
        for (const [key, e] of empDayHours) {
          if (!key.endsWith(`|${yesterdayStr}`) || !allowedShops.has(e.locationId)) continue
          if (violatesThreshold(rule, e.hours)) {
            violations.push({ rule_id: rule.id, company_id: companyId, location_id: e.locationId, shop_label: shopLabel.get(e.locationId) ?? e.locationId, droptop_user_id: e.userId, employee_name: e.name, period_start: yesterdayStr, period_end: yesterdayStr, actual_value: e.hours, rule_snapshot: snapshot })
          }
        }
      } else if (rule.kpi === 'weekly_hours_employee') {
        const allowedShops = new Set(shopIdsForRule(rule))
        const perEmployee = new Map<string, { hours: number; name: string; locationId: string }>()
        for (const [key, e] of empDayHours) {
          if (!allowedShops.has(e.locationId)) continue
          const date = key.split('|')[2]
          if (!weekDates.includes(date)) continue
          const ek = `${e.locationId}|${e.userId}`
          const acc = perEmployee.get(ek) ?? { hours: 0, name: e.name, locationId: e.locationId }
          acc.hours += e.hours
          perEmployee.set(ek, acc)
        }
        for (const [ek, e] of perEmployee) {
          if (violatesThreshold(rule, e.hours)) {
            const userId = ek.split('|')[1]
            violations.push({ rule_id: rule.id, company_id: companyId, location_id: e.locationId, shop_label: shopLabel.get(e.locationId) ?? e.locationId, droptop_user_id: userId, employee_name: e.name, period_start: lastWeekStartStr, period_end: lastWeekEndStr, actual_value: e.hours, rule_snapshot: snapshot })
          }
        }
      }
    }

    // Snapshot replace — see this table's own migration comment for why
    // (a "builds a table looking for those configurations" checklist, not
    // a history log).
    await admin.schema('inventory').from('staffing_alert_violations').delete().eq('company_id', companyId)
    const BATCH = 500
    for (let i = 0; i < violations.length; i += BATCH) {
      const { error: insErr } = await admin.schema('inventory').from('staffing_alert_violations').insert(violations.slice(i, i + BATCH))
      if (insErr) return ok({ error: `Failed writing violations: ${insErr.message}`, violations_found: violations.length })
    }

    return ok({ success: true, rules_checked: activeRules.length, violations_found: violations.length })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
