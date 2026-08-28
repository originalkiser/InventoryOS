// Automated inventory-movement checks: abnormal adjustment, a sale logged
// against zero on-hand, and tank monitor variance vs. Droptop's on-hand
// pull. Flags land in inventory.exception_reports (report_type
// 'Automated Check', metadata.source = 'automated') — this is part of
// Exception Reporting, not a parallel system.
//
// Abnormal RECEIPT is intentionally not implemented — Droptop's real
// change_type for a receiving event isn't confirmed (see
// droptop-sync-usage's own daily_product_activity comment: anything besides
// 'sale'/'adjustment*' currently lands in other_qty with the raw type
// preserved). Run droptop-sync-usage with {"mode":"inspect"} and inspect a
// real changes_sample before adding this check.
//
// Callable two ways, same dual-auth shape as the other sync functions:
//  - Unattended, via the Data Connections dispatcher (X-Sync-Token = the
//    same DATA_CONNECTION_DISPATCH_SECRET the dispatcher itself is called
//    with — this function is only ever invoked by that dispatcher or by an
//    admin's own session, so it doesn't need a secret of its own).
//  - Interactively, from a future "Run Now" button (logged-in user session).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

interface Config {
  adjustmentThreshold: number
  zeroOnHandSaleEnabled: boolean
  tankVarianceThreshold: number
}
const DEFAULT_CONFIG: Config = { adjustmentThreshold: 50, zeroOnHandSaleEnabled: true, tankVarianceThreshold: 50 }

const CHECK_LABELS: Record<string, string> = {
  abnormal_adjustment: 'Abnormal Adjustment',
  zero_on_hand_sale: 'Sale Logged With Zero On-Hand',
  tank_variance: 'Tank Monitor Variance vs. Droptop',
}

interface Flag {
  location_id: string
  product_id: string
  check_type: string
  details: Record<string, unknown>
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const dispatchSecret = Deno.env.get('DATA_CONNECTION_DISPATCH_SECRET')

    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    let authorized = !!dispatchSecret && suppliedSecret === dispatchSecret
    if (!authorized) {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (authHeader) {
        const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
        const { data: who, error: whoErr } = await caller.auth.getUser()
        authorized = !whoErr && !!who.user
      }
    }
    if (!authorized) return ok({ error: 'Not authorized' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: anyLoc } = await (admin as any).schema('core').from('locations').select('company_id').limit(1).maybeSingle()
    const companyId: string | null = anyLoc?.company_id ?? null
    if (!companyId) return ok({ error: 'Unable to resolve company' })

    const { data: settingRow } = await (admin as any).schema('platform').from('app_settings')
      .select('value').eq('company_id', companyId).eq('key', 'automated_checks_config').maybeSingle()
    const config: Config = { ...DEFAULT_CONFIG, ...(settingRow?.value ?? {}) }

    const { data: exclusionRows } = await (admin as any).schema('inventory').from('automated_check_exclusions')
      .select('location_id, product_id, check_type').eq('company_id', companyId)
    const exclusions = (exclusionRows ?? []) as { location_id: string | null; product_id: string | null; check_type: string }[]
    function isExcluded(checkType: string, locationId: string, productId: string): boolean {
      return exclusions.some((e) =>
        e.check_type === checkType
        && (e.location_id === null || e.location_id === locationId)
        && (e.product_id === null || e.product_id.toLowerCase() === productId.toLowerCase()),
      )
    }

    const flags: Flag[] = []

    // ── Abnormal adjustment + sale-with-zero-on-hand: latest activity day ──
    const { data: latestDayRow } = await (admin as any).schema('inventory').from('daily_product_activity')
      .select('activity_date').eq('company_id', companyId).order('activity_date', { ascending: false }).limit(1).maybeSingle()
    const activityDate: string | null = latestDayRow?.activity_date ?? null

    if (activityDate) {
      const { data: activityRows } = await (admin as any).schema('inventory').from('daily_product_activity')
        .select('location_id, product_id, sold_qty, adjusted_qty').eq('company_id', companyId).eq('activity_date', activityDate)
      const activity = (activityRows ?? []) as { location_id: string; product_id: string; sold_qty: number; adjusted_qty: number }[]

      for (const row of activity) {
        if (Math.abs(row.adjusted_qty ?? 0) > config.adjustmentThreshold && !isExcluded('abnormal_adjustment', row.location_id, row.product_id)) {
          flags.push({
            location_id: row.location_id, product_id: row.product_id, check_type: 'abnormal_adjustment',
            details: { activity_date: activityDate, adjusted_qty: row.adjusted_qty, threshold: config.adjustmentThreshold },
          })
        }
      }

      if (config.zeroOnHandSaleEnabled) {
        const soldToday = activity.filter((r) => (r.sold_qty ?? 0) > 0)
        if (soldToday.length > 0) {
          const locIds = [...new Set(soldToday.map((r) => r.location_id))]
          const { data: onHandRows } = await (admin as any).schema('inventory').from('product_usage')
            .select('location_id, product_id, on_hands').eq('company_id', companyId).in('location_id', locIds)
          const onHandByKey = new Map<string, number | null>()
          for (const r of (onHandRows ?? []) as { location_id: string; product_id: string; on_hands: number | null }[]) {
            onHandByKey.set(`${r.location_id}|${String(r.product_id).toLowerCase()}`, r.on_hands)
          }
          for (const row of soldToday) {
            const onHand = onHandByKey.get(`${row.location_id}|${row.product_id.toLowerCase()}`)
            if (onHand != null && onHand <= 0 && !isExcluded('zero_on_hand_sale', row.location_id, row.product_id)) {
              flags.push({
                location_id: row.location_id, product_id: row.product_id, check_type: 'zero_on_hand_sale',
                details: { activity_date: activityDate, sold_qty: row.sold_qty, on_hand: onHand },
              })
            }
          }
        }
      }
    }

    // ── Tank monitor variance vs. Droptop on-hand ──
    const { data: tankRows } = await (admin as any).schema('inventory').from('tank_monitors')
      .select('location_id, product_id, on_hand, serial_rtu_id').eq('company_id', companyId)
      .not('location_id', 'is', null).not('product_id', 'is', null)
    const tanks = (tankRows ?? []) as { location_id: string; product_id: string; on_hand: number | null; serial_rtu_id: string | null }[]

    if (tanks.length) {
      const { data: mapSetting } = await (admin as any).schema('platform').from('app_settings')
        .select('value').eq('company_id', companyId).eq('key', 'tank_product_map').maybeSingle()
      const productMap = (mapSetting?.value ?? {}) as Record<string, string>
      const { data: overrideRows } = await (admin as any).schema('inventory').from('tank_variance_overrides').select('*').eq('company_id', companyId)
      const overrides = (overrideRows ?? []) as { location_id: string; product_id: string; tank_serials: string[]; variance_qts: number }[]

      const locIds = [...new Set(tanks.map((t) => t.location_id))]
      const { data: usageRows } = await (admin as any).schema('inventory').from('product_usage')
        .select('location_id, product_id, on_hands').eq('company_id', companyId).in('location_id', locIds)
      const usageByKey = new Map<string, number | null>()
      for (const r of (usageRows ?? []) as { location_id: string; product_id: string; on_hands: number | null }[]) {
        usageByKey.set(`${r.location_id}|${String(r.product_id).toLowerCase()}`, r.on_hands)
      }

      for (const t of tanks) {
        // Resolve via the manual Tank Monitors -> internal product map
        // (Config -> Tank Monitors -> Product Mapping) when one exists;
        // otherwise assume the tank's own product_id is already the
        // internal one. Does not replicate that page's further Vendor
        // Parts description/part-number fallback matching.
        const resolved = productMap[String(t.product_id).toLowerCase().trim()] ?? t.product_id
        const droptopOnHand = usageByKey.get(`${t.location_id}|${String(resolved).toLowerCase()}`)
        if (droptopOnHand == null || t.on_hand == null) continue
        const diff = Math.abs(t.on_hand - droptopOnHand)
        const override = overrides.find((o) =>
          o.location_id === t.location_id && o.product_id.toLowerCase() === String(resolved).toLowerCase()
          && (o.tank_serials.length === 0 || (t.serial_rtu_id != null && o.tank_serials.includes(t.serial_rtu_id))),
        )
        const threshold = override?.variance_qts ?? config.tankVarianceThreshold
        if (diff > threshold && !isExcluded('tank_variance', t.location_id, resolved)) {
          flags.push({
            location_id: t.location_id, product_id: resolved, check_type: 'tank_variance',
            details: {
              tank_on_hand: t.on_hand, droptop_on_hand: droptopOnHand, variance_qts: diff, threshold,
              tank_serial: t.serial_rtu_id, raw_tank_product: t.product_id, override_applied: !!override,
            },
          })
        }
      }
    }

    // ── Write into exception_reports — skip anything already open for this
    //    exact (location, product, check_type) so an ongoing issue doesn't
    //    spawn a new row every run. ──
    let created = 0
    for (const f of flags) {
      const { data: existing } = await (admin as any).schema('inventory').from('exception_reports')
        .select('id')
        .eq('company_id', companyId).eq('location_id', f.location_id).eq('report_type', 'Automated Check')
        .filter('metadata->>check_type', 'eq', f.check_type)
        .filter('metadata->>product_id', 'eq', f.product_id)
        .not('status', 'in', '("Closed","Tentatively Closed")')
        .maybeSingle()
      if (existing) continue

      const { error } = await (admin as any).schema('inventory').from('exception_reports').insert({
        company_id: companyId,
        location_id: f.location_id,
        report_type: 'Automated Check',
        issue: CHECK_LABELS[f.check_type] ?? f.check_type,
        details: JSON.stringify(f.details),
        date_of_finding: new Date().toISOString().slice(0, 10),
        contacted: false,
        status: 'Pending Shop/AM Response',
        metadata: { source: 'automated', check_type: f.check_type, product_id: f.product_id, ...f.details },
        last_change_source: 'automated_checks',
      })
      if (!error) created++
    }

    ;(admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId, connection: 'automated_checks', started_at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt, items_updated: created, items_unchanged: flags.length - created,
      status: 'success', error_message: null,
    }).then(() => {})

    return ok({ success: true, checked: flags.length, created })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
