// Automated inventory exceptions — five types, ONE open exception per shop per type that accumulates instead of a new row per product or day
// (see inventory.shop_exceptions / migration 20261009a and detect.ts for the rules):
//   PO should have delivered (medium) · Selling at zero on hand (high) · Large positive adjustment (medium)
//   Large negative adjustment (high) · Duplicate case types on hand (high when the quantities are within 40 qts of each other, else low)
//
// Replaces the old per-product flags that landed in inventory.exception_reports (abnormal adjustment, sale with zero on hand, tank variance).
// Those rows are left alone; nothing new is written there. Tank-variance checking is no longer part of this job.
//
// Callable two ways, same dual-auth shape as the other sync functions:
//  - Unattended, via the Data Connections dispatcher (X-Sync-Token = DATA_CONNECTION_DISPATCH_SECRET).
//  - Interactively, from a logged-in user's session (the Data Connections "Run Now" button).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  BASE_SEVERITY, baseProductId, detectAdjustments, detectDuplicates, detectLatePos, detectZeroSales, isExcluded, parseWeekday, reconcile,
  type ActivityRow, type Computed, type ExceptionItem, type ExceptionType, type ExistingException, type OpenPo, type Schedule, type WeekCalendar,
} from './detect.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

interface Config {
  adjustmentThreshold: number      // qts — an adjustment bigger than this in a day is "large"
  zeroOnHandSaleEnabled: boolean
  duplicateToleranceQts: number    // duplicate case types within this many qts of each other are high severity
  poGraceDays: number              // days past the expected delivery before a PO is flagged
  poSuppliers: string[]            // supplier names whose POs are checked
  categories: string[]             // product categories the ledger-based checks look at (Product Usage's own default scope)
}
const DEFAULT_CONFIG: Config = { adjustmentThreshold: 50, zeroOnHandSaleEnabled: true, duplicateToleranceQts: 40, poGraceDays: 2, poSuppliers: ['RelaDyne', 'Valvoline'], categories: ['Engine Oil', 'Engine Oil Additive'] }
const LOOKBACK_DAYS = 30

const isoToday = () => new Date().toISOString().slice(0, 10)
const chunked = <T,>(rows: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out }

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

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as any
    const inv = () => admin.schema('inventory')

    async function pageAll<T>(build: () => any, size = 1000): Promise<T[]> {
      const out: T[] = []
      for (let from = 0; ; ) {
        const { data, error } = await build().range(from, from + size - 1)
        if (error) throw new Error(error.message)
        const batch = (data ?? []) as T[]
        out.push(...batch)
        if (batch.length === 0 || batch.length < size) break
        from += batch.length
      }
      return out
    }

    const { data: anyLoc } = await admin.schema('core').from('locations').select('company_id').limit(1).maybeSingle()
    const companyId: string | null = anyLoc?.company_id ?? null
    if (!companyId) return ok({ error: 'Unable to resolve company' })

    const { data: settingRow } = await admin.schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', 'automated_checks_config').maybeSingle()
    const config: Config = { ...DEFAULT_CONFIG, ...(settingRow?.value ?? {}) }
    if (!Array.isArray(config.poSuppliers)) config.poSuppliers = DEFAULT_CONFIG.poSuppliers
    if (!Array.isArray(config.categories) || !config.categories.length) config.categories = DEFAULT_CONFIG.categories

    const today = isoToday()
    const lookbackFrom = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)

    // Active corporate shops only — same rule Orders v2 uses (a closed shop or a franchisee isn't ours to chase).
    const locRows = await pageAll<any>(() => admin.schema('core').from('locations')
      .select('id, active, location_type, owner, metadata, reladyne_delivery_day').eq('company_id', companyId).order('id'))
    const shops = locRows.filter((l) => l.active && l.location_type !== 'car_wash' && String(l.owner ?? l.metadata?.owner ?? '').trim().toLowerCase() === 'corporate')
    const shopIds = new Set<string>(shops.map((l) => l.id))
    const weekdayByLocation = new Map<string, number | null>(shops.map((l) => [l.id, parseWeekday(l.reladyne_delivery_day)]))

    const { data: exclusionRows } = await inv().from('automated_check_exclusions').select('location_id, product_id, check_type').eq('company_id', companyId)
    const exclusions = (exclusionRows ?? []) as { location_id: string | null; product_id: string | null; check_type: string }[]
    const excludedFor = (checkType: string) => (loc: string, product: string) => isExcluded(exclusions, checkType, loc, product)

    const computed = new Map<string, Computed>()
    const put = (type: ExceptionType, byLocation: Map<string, ExceptionItem[]>, severity = BASE_SEVERITY[type]) => {
      for (const [loc, items] of byLocation) if (shopIds.has(loc) && items.length) computed.set(`${loc}|${type}`, { severity, items })
    }

    // Open exceptions (needed first: zero-on-hand items stack on the ones already open).
    const existing = await pageAll<ExistingException>(() => inv().from('shop_exceptions')
      .select('id, location_id, type, status, severity, first_seen, items, acked_keys').eq('company_id', companyId).neq('status', 'resolved').order('id'))

    // ── ledger: large adjustments (only the big ones are read — the ledger is ~245k rows a month) ──
    const t = Math.abs(config.adjustmentThreshold)
    const bigAdjustments = (await pageAll<ActivityRow>(() => inv().from('daily_product_activity')
      .select('location_id, product_id, activity_date, sold_qty, adjusted_qty').eq('company_id', companyId)
      .in('category', config.categories).gte('activity_date', lookbackFrom).or(`adjusted_qty.gt.${t},adjusted_qty.lt.-${t}`).order('id'))).filter((r) => shopIds.has(r.location_id))

    const adj = detectAdjustments({ activity: bigAdjustments, threshold: config.adjustmentThreshold, excluded: excludedFor('abnormal_adjustment') })
    put('adj_positive', adj.positive)
    put('adj_negative', adj.negative)

    // Order-config families (what each shop actually orders) and old→new product ids — duplicate detection and the usage lookup both need them.
    const cfgRows = await pageAll<{ location_id: string; product_id: string }>(() => inv().from('location_order_config').select('location_id, product_id').eq('company_id', companyId).order('id'))
    const mapRows = await pageAll<{ old_product_id: string; new_product_id: string }>(() => inv().from('product_id_mappings').select('old_product_id, new_product_id').eq('company_id', companyId).order('id'))
    const mappings = new Map<string, string>(mapRows.filter((m) => m.old_product_id && m.new_product_id).map((m) => [m.old_product_id.trim().toLowerCase(), m.new_product_id]))
    const configured = new Map<string, Set<string>>()
    const families = new Set<string>()
    for (const c of cfgRows) {
      if (!c.product_id) continue
      const fam = baseProductId(mappings.get(c.product_id.trim().toLowerCase()) ?? c.product_id).toLowerCase()
      if (!configured.has(c.location_id)) configured.set(c.location_id, new Set())
      configured.get(c.location_id)!.add(fam)
      families.add(fam)
    }
    for (const m of mapRows) if (m.old_product_id) families.add(baseProductId(m.old_product_id).toLowerCase())
    // One set-based call for the on hand of every configured family (duplicate case types).
    const wanted = [...families].filter(Boolean)
    const usageRows: { location_id: string; product_id: string; on_hands: number | null }[] = []
    for (const part of chunked(wanted, 150)) {
      const { data, error } = await admin.rpc('get_ov2_usage_for_families', { p_families: part })
      if (error) throw new Error(`Usage lookup failed: ${error.message}`)
      usageRows.push(...((data ?? []) as any[]))
    }

    if (config.zeroOnHandSaleEnabled) {
      // Sales of products at zero on hand that sold in the last 3 days — joined in the database (get_zero_on_hand_sales).
      const { data: zeroRows, error: zeroErr } = await admin.rpc('get_zero_on_hand_sales', { p_from: lookbackFrom, p_recent_from: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), p_categories: config.categories })
      if (zeroErr) throw new Error(`Zero-on-hand lookup failed: ${zeroErr.message}`)
      const zero = ((zeroRows ?? []) as (ActivityRow & { on_hands: number | null })[]).filter((r) => shopIds.has(r.location_id))
      const onHand = new Map<string, number | null>(zero.map((r) => [`${r.location_id}|${String(r.product_id).toLowerCase()}`, r.on_hands]))
      const prior = new Map<string, ExceptionItem[]>(existing.filter((e) => e.type === 'zero_sales').map((e) => [e.location_id, e.items ?? []]))
      put('zero_sales', detectZeroSales({ activity: zero, onHand, prior, today, excluded: excludedFor('zero_on_hand_sale') }))
    }

    const dups = detectDuplicates({ usage: usageRows.filter((u) => shopIds.has(u.location_id)), configured, mappings, tolerance: config.duplicateToleranceQts, excluded: excludedFor('duplicate_case_types') })
    for (const [loc, d] of dups) computed.set(`${loc}|duplicate_case`, { severity: d.severity, items: d.items })

    // ── POs that should have delivered ──
    if (config.poSuppliers.length) {
      const { data: vendorRows } = await inv().from('vendors').select('id, name').eq('company_id', companyId)
      const vendors = ((vendorRows ?? []) as { id: string; name: string }[]).filter((v) => config.poSuppliers.some((s) => v.name.toLowerCase().includes(s.toLowerCase())))
      const vendorOfSupplier = (supplier: string | null) => {
        const sup = (supplier ?? '').trim().toLowerCase()
        if (!sup) return null
        return vendors.find((v) => sup.includes(v.name.toLowerCase()) || v.name.toLowerCase().includes(sup))?.id ?? null
      }
      const poFrom = new Date(Date.now() - 60 * 86400000).toISOString()
      const pos: OpenPo[] = []
      for (const s of config.poSuppliers) {
        const rows = await pageAll<any>(() => inv().from('droptop_purchase_orders')
          .select('id, location_id, po_id, custom_po_id, supplier_name, created_timestamp, to_receive_timestamp').eq('company_id', companyId)
          .ilike('supplier_name', `%${s}%`).in('po_status', ['draft', 'sent', 'accepted']).gte('created_timestamp', poFrom).order('id'))
        for (const r of rows) pos.push({ ...r, vendor_id: vendorOfSupplier(r.supplier_name) })
      }
      const received = new Set<string>()
      for (const part of chunked(pos.map((p) => p.id), 150)) {
        const { data, error } = await inv().from('droptop_purchase_order_items').select('purchase_order_id, received_quantity').in('purchase_order_id', part).gt('received_quantity', 0)
        if (error) throw new Error(error.message)
        for (const it of (data ?? []) as any[]) received.add(it.purchase_order_id)
      }
      const schedules = new Map<string, Schedule>()
      const calendars = new Map<string, WeekCalendar>()
      if (vendors.length) {
        const vendorIds = vendors.map((v) => v.id)
        const schedRows = await pageAll<any>(() => inv().from('ov2_location_schedules').select('*').eq('company_id', companyId).in('vendor_id', vendorIds).order('id'))
        for (const r of schedRows) {
          schedules.set(`${r.location_id}|${r.vendor_id}`, {
            type: r.schedule_type, delivery_dow: r.delivery_dow, week_a_dow: r.week_a_dow, week_b_dow: r.week_b_dow,
            biweekly_anchor_date: r.biweekly_anchor_date ?? null, lead_business_days: Number(r.lead_business_days ?? 4),
          })
        }
        const calRows = await pageAll<any>(() => inv().from('ov2_delivery_calendar').select('vendor_id, week_start, week_label').eq('company_id', companyId).in('vendor_id', vendorIds).order('week_start'))
        for (const r of calRows) {
          if (!calendars.has(r.vendor_id)) calendars.set(r.vendor_id, new Map())
          calendars.get(r.vendor_id)!.set(String(r.week_start).slice(0, 10), r.week_label)
        }
      }
      put('po_late', detectLatePos({
        pos, received, schedules, calendars, weekdayByLocation, today, graceDays: config.poGraceDays,
        isReladyne: (s) => /reladyne/i.test(s ?? ''),
      }))
    }

    // ── combine into the one-per-shop-per-type rows ──
    const ops = reconcile(existing, computed, today, new Date().toISOString())
    for (const part of chunked(ops.inserts.map((i) => ({ ...i, company_id: companyId, status: 'pending' })), 200)) {
      const { error } = await inv().from('shop_exceptions').insert(part)
      if (error) throw new Error(`Insert failed: ${error.message}`)
    }
    for (const part of chunked(ops.updates, 15)) {
      const results = await Promise.all(part.map((u) => inv().from('shop_exceptions').update(u.patch).eq('id', u.id)))
      const bad = results.find((r: any) => r.error)
      if (bad) throw new Error(`Update failed: ${bad.error.message}`)
    }

    const resolved = ops.updates.filter((u) => u.patch.status === 'resolved').length
    const byType: Record<string, number> = {}
    for (const k of computed.keys()) { const t = k.slice(k.indexOf('|') + 1); byType[t] = (byType[t] ?? 0) + 1 }
    inv().from('data_connection_sync_log').insert({
      company_id: companyId, connection: 'automated_checks', started_at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt, items_updated: ops.inserts.length + ops.updates.length - resolved, items_unchanged: 0,
      status: 'success', error_message: null,
    }).then(() => {})

    return ok({ success: true, shops_with_exceptions: new Set([...computed.keys()].map((k) => k.slice(0, k.indexOf('|')))).size, by_type: byType, created: ops.inserts.length, updated: ops.updates.length - resolved, resolved })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
