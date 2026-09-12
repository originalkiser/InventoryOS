// Droptop webhook receiver — real-time-ish push instead of waiting on the
// next scheduled/incremental pull for orders.finalized / orders.voided /
// orders.started / users.clocked_out. The existing batch syncs
// (droptop-sync-orders' incremental mode, droptop-sync-staff-time-clock)
// stay running unchanged as a reconciliation safety net for anything a
// missed/failed webhook delivery didn't cover — this is additive, not a
// replacement.
//
// AUTH: real HMAC-SHA256 verification, per Droptop's "Verifying Webhooks"
// doc. Every request must carry X-droptop-signature (hex HMAC) and
// X-droptop-timestamp; the signed message is
// `${timestamp}.${JSON.stringify(rawBodyText)}` — note that's
// JSON.stringify of the raw request body TEXT (a string), not of the
// parsed object, matching Droptop's own Node example exactly (their
// example reads the body via express.text(), i.e. already a string,
// before JSON.stringify-ing it again) — re-stringifying a parsed/re-
// serialized object would produce a different byte sequence and never
// match. Requires the DROPTOP_WEBHOOK_SECRET secret (from Droptop's
// webhook settings — get this value from Droptop's dashboard, it's not
// visible in the plain "Add Endpoint" screen). A request with a missing/
// invalid signature is rejected (403) before any DB work happens.
//
// This function's name (a random 16-hex-char suffix) is a SECONDARY,
// redundant layer on top of the real HMAC check above — cheap
// defense-in-depth, not the actual security boundary anymore. Fine to
// leave as-is; no need to rename now that signature verification exists.
//
// verify_jwt = false (supabase/config.toml) — Droptop sends no Supabase
// JWT at all, so the platform gateway would otherwise reject every
// request before this code even runs.
//
// Idempotency/observability: every delivery is logged to
// inventory.droptop_webhook_log keyed by Droptop's own delivery id
// (payload.id) — a delivery already logged 'success' is deduped (fast
// ack, no reprocessing). The actual writes below are also naturally
// idempotent on their own (upsert by natural key), so a duplicate that
// slips past the log check is still harmless, just redundant work.
//
// Ordering: Droptop's own docs flag that a retried delivery can arrive out
// of order. orders.* events carry order_last_updated — if what's already
// stored for that order is newer than the incoming event, the write is
// skipped (the newer state stays).
//
// users.clocked_out's own payload is deliberately sparse (user_id +
// clock in/out timestamps only — no hours/wage/name). Rather than trying
// to construct a full inventory.droptop_time_records row from that alone,
// this calls back into Droptop's get-staff-time-clock for a tight window
// around the punch and upserts the SAME enriched shape
// droptop-sync-staff-time-clock already writes — one extra round trip,
// but the row ends up identical either way it arrived.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
// A genuine processing failure (DB hiccup, Droptop API blip in
// handleClockedOut's callback, etc.) — a real non-2xx so Droptop's own
// retry mechanism (1h/3h/7h) gets a chance to succeed on what's often a
// transient issue, rather than silently relying on the next scheduled
// batch sync to eventually catch it up.
function fail(body: unknown) {
  return new Response(JSON.stringify(body), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
// An unsigned/invalid-signature request — rejected before any DB work.
function reject(body: unknown) {
  return new Response(JSON.stringify(body), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── HMAC signature verification (Droptop's "Verifying Webhooks" doc) ──────
async function computeHmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
// Constant-time compare — a plain === leaks timing info about how many
// leading characters matched, which is exactly what signature comparison
// is supposed to not leak.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Droptop auth sig — identical to the other Droptop sync functions ──────
// (only needed here for the one outbound call in handleClockedOut below)
async function parseKey(key: string): Promise<Uint8Array> {
  const k = key.trim()
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(k.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  const rawBytes = new TextEncoder().encode(k)
  if (rawBytes.length === 16 || rawBytes.length === 24 || rawBytes.length === 32) return rawBytes
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes)
  return new Uint8Array(hashBuffer)
}
async function buildSig(publicKey: string, method: string, privateKey: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey.trim()}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = new TextEncoder().encode(message)
  const padLen = 16 - (msgBytes.length % 16)
  const padded = new Uint8Array(msgBytes.length + padLen)
  padded.set(msgBytes)
  padded.fill(padLen, msgBytes.length)
  const keyBytes = await parseKey(privateKey)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt'])
  const zeroIV = new Uint8Array(16)
  const encrypted = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, padded.slice(i, i + 16))
    encrypted.set(new Uint8Array(enc).slice(0, 16), i)
  }
  return btoa(btoa(String.fromCharCode(...encrypted)))
}
async function callDroptop(endpoint: string, params: Record<string, string>, publicKey: string, privateKey: string): Promise<any> {
  const sig = await buildSig(publicKey, 'GET', privateKey)
  const qs = new URLSearchParams({ sig, ...params })
  const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
  const res = await fetch(url, { headers: { 'x-api-key': publicKey.trim() }, redirect: 'follow' })
  const text = await res.text()
  if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
  return JSON.parse(text)
}

function tsToIso(unix: unknown): string | null {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}
function numOrNull(v: unknown): number | null {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null
}

// One order upserted + its child tables wholesale-replaced — same shape
// droptop-sync-orders writes for a batch pull, just for a single order.
async function handleOrderEvent(admin: any, companyId: string, locationId: string, o: any): Promise<void> {
  const incomingUpdatedAt = tsToIso(o.order_last_updated)
  const { data: existingOrder } = await admin.schema('inventory').from('droptop_orders')
    .select('id, order_last_updated_at')
    .eq('company_id', companyId).eq('location_id', locationId).eq('order_id', o.order_id).maybeSingle()
  // Stale/out-of-order retry — a newer state is already stored, leave it alone.
  if (existingOrder?.order_last_updated_at && incomingUpdatedAt && existingOrder.order_last_updated_at > incomingUpdatedAt) return

  const c = o.customer ?? {}
  const zip = String(c.zip ?? '').trim() || null
  let coords: { lat: number; lng: number } | undefined
  if (zip) {
    const { data: zc } = await admin.schema('inventory').from('zip_centroids').select('lat, lng').eq('zip', zip).maybeSingle()
    if (zc) coords = zc
  }
  const owner = o.order_owner ?? {}
  const ownerName = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null
  const fleetLoc = o.fleet_location ?? {}
  const fleetCo = fleetLoc.fleet_company ?? {}
  const nowIso = new Date().toISOString()

  const row = {
    company_id: companyId, location_id: locationId, order_id: o.order_id,
    customer_id: c.customer_id ?? null, first_name: c.first_name ?? null, last_name: c.last_name ?? null,
    email: c.email ?? null, phone_number: c.phone_number ?? null, address: c.address ?? null,
    city: c.city ?? null, region: c.region ?? null, zip, country: c.country ?? null,
    lat: coords?.lat ?? null, lng: coords?.lng ?? null,
    status: o.status ?? null,
    subtotal: o.subtotal != null ? Number(o.subtotal) : null,
    final_price: o.final_price != null ? Number(o.final_price) : null,
    casual_items: o.casual_items ?? [], coupons: o.coupons ?? [], discounts: o.discounts ?? [],
    raw_data: o,
    order_finalized_at: tsToIso(o.order_finalized),
    order_scheduled_at: tsToIso(o.order_scheduled_at),
    order_opened_at: tsToIso(o.order_opened),
    order_sent_to_bay_at: tsToIso(o.order_sent_to_bay),
    order_service_completed_at: tsToIso(o.order_service_completed),
    order_last_updated_at: tsToIso(o.order_last_updated),
    bay_id: o.bay_id ?? null, bay_name: o.bay_name ?? null,
    order_owner_id: owner.user_id ?? null, order_owner_name: ownerName, order_owner_email: owner.email ?? null,
    pay_status: o.pay_status ?? null, tax_exempt_total: numOrNull(o.tax_exempt_total),
    fleet_location_id: fleetLoc.fleet_location_id ?? null, fleet_location_name: fleetLoc.name ?? null,
    fleet_company_id: fleetCo.fleet_company_id ?? null, fleet_company_name: fleetCo.name ?? null,
    synced_at: nowIso, last_change_source: 'droptop_webhook', updated_at: nowIso,
  }

  const { data: saved, error } = await admin.schema('inventory').from('droptop_orders')
    .upsert(row, { onConflict: 'company_id,location_id,order_id' }).select('id').single()
  if (error) throw new Error(`droptop_orders upsert: ${error.message}`)
  const orderUuid = saved.id

  await Promise.all([
    admin.schema('inventory').from('droptop_order_packages').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_products').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_services').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_vehicles').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_servicing_positions').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_payments').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_taxes').delete().eq('order_id', orderUuid),
    admin.schema('inventory').from('droptop_order_declined_items').delete().eq('order_id', orderUuid),
  ])

  const packageRows = (o.packages ?? []).map((p: any) => ({
    order_id: orderUuid, company_id: companyId, package_id: p.package_id ?? null, name: p.name ?? null,
    description: p.description ?? null, internal_name: p.internal_name ?? null,
    base_service_price: p.base_service_price != null ? Number(p.base_service_price) : null,
    price: p.price != null ? Number(p.price) : null, price_total: p.price_total != null ? Number(p.price_total) : null,
    price_total_after_discount: p.price_total_aft_discount != null ? Number(p.price_total_aft_discount) : null,
    vin: p.vin ?? null, license_plate: p.license_plate ?? null, vehicle_name: p.vehicle_name ?? null,
    financial_category_id: p.financial_category?.financial_category_id ?? null,
    financial_category_name: p.financial_category?.name ?? null, financial_category_code: p.financial_category?.code ?? null,
    coupons: p.coupons ?? [],
  }))
  const productRows = (o.products ?? []).map((pr: any) => ({
    order_id: orderUuid, company_id: companyId, inventory_id: pr.inventory_id ?? null, product_id: pr.product_id ?? null,
    sequence_id: pr.sequence_id ?? null, product_type: pr.product_type ?? null, product_type_pcdb_id: pr.product_type_pcdb_id ?? null,
    brand_name: pr.brand_name ?? null, uom: pr.uom ?? null, restocked: pr.restocked ?? null,
    quantity_total: pr.quantity_total != null ? Number(pr.quantity_total) : null,
    price_total: pr.price_total != null ? Number(pr.price_total) : null, cost_total: pr.cost_total != null ? Number(pr.cost_total) : null,
    quantity_on_hand: pr.quantity_on_hand != null ? Number(pr.quantity_on_hand) : null,
    financial_category_id: pr.financial_category?.financial_category_id ?? null,
    financial_category_name: pr.financial_category?.name ?? null, financial_category_code: pr.financial_category?.code ?? null,
  }))
  const serviceRows = (o.services ?? []).map((s: any) => ({
    order_id: orderUuid, company_id: companyId, package_id: s.package_id ?? null, service_id: s.service_id ?? null,
    service_name: s.service_name ?? null, vin: s.vin ?? null, license_plate: s.license_plate ?? null,
    vehicle_name: s.vehicle_name ?? null, products: s.products ?? [],
  }))
  const vehicleRows = (o.vehicles ?? []).map((v: any) => ({
    order_id: orderUuid, company_id: companyId, vin: v.vin ?? null, license_plate: v.license_plate ?? null,
    vehicle_name: v.other_vehicle_name ?? null, mileage: numOrNull(v.mileage),
    vin_vehicle_make: v.vin_vehicle_make ?? null, vin_vehicle_model: v.vin_vehicle_model ?? null,
    vin_vehicle_year: v.vin_vehicle_year != null ? Math.trunc(Number(v.vin_vehicle_year)) || null : null,
  }))
  const servicingPositionRows = (o.servicing_positions ?? []).map((p: any) => ({
    order_id: orderUuid, company_id: companyId, user_id: p.user_id ?? null, user_name: p.user_name ?? null,
    position: p.position ?? null, vin: p.vin ?? null, license_plate: p.license_plate ?? null, vehicle_name: p.vehicle_name ?? null,
  }))
  const paymentRows = (o.payments ?? []).map((pay: any) => ({
    order_id: orderUuid, company_id: companyId, payment_id: pay.payment_id ?? null, payment_type: pay.payment_type ?? null,
    sub_payment_type: pay.sub_payment_type ?? null, status: pay.status ?? null, final_amount: numOrNull(pay.final_amount),
    currency: pay.currency ?? null, payment_created_at: tsToIso(pay.created_timestamp), payment_updated_at: tsToIso(pay.last_updated_timestamp),
  }))
  const taxRows = (o.taxes ?? []).map((t: any) => ({
    order_id: orderUuid, company_id: companyId, name: t.name ?? null, amount: numOrNull(t.amount),
    percentage: numOrNull(t.percentage), taxed_subtotal: numOrNull(t.taxed_subtotal),
  }))
  const decl = o.declined_items ?? {}
  const declinedItemRows = [
    ...(decl.packages ?? []).map((raw: any) => ({ order_id: orderUuid, company_id: companyId, item_type: 'package', raw_data: raw })),
    ...(decl.services ?? []).map((raw: any) => ({ order_id: orderUuid, company_id: companyId, item_type: 'service', raw_data: raw })),
  ]

  const tables: [string, Record<string, unknown>[]][] = [
    ['droptop_order_packages', packageRows], ['droptop_order_products', productRows], ['droptop_order_services', serviceRows],
    ['droptop_order_vehicles', vehicleRows], ['droptop_order_servicing_positions', servicingPositionRows],
    ['droptop_order_payments', paymentRows], ['droptop_order_taxes', taxRows], ['droptop_order_declined_items', declinedItemRows],
  ]
  for (const [table, rowsToInsert] of tables) {
    if (!rowsToInsert.length) continue
    const { error: insErr } = await admin.schema('inventory').from(table).insert(rowsToInsert)
    if (insErr) throw new Error(`${table}: ${insErr.message}`)
  }
}

// Sparse webhook payload (user_id + clock in/out timestamps only) — calls
// back into get-staff-time-clock for a tight window around this one punch
// to get the enriched fields (hours, wage, name) droptop-sync-staff-time-
// clock already writes, and upserts the identical row shape.
async function handleClockedOut(admin: any, companyId: string, locationId: string, operationId: string, data: any): Promise<void> {
  const publicKey = Deno.env.get('DROPTOP_PUBLIC_KEY')
  const privateKey = Deno.env.get('DROPTOP_PRIVATE_KEY')
  if (!publicKey || !privateKey) throw new Error('credentials_not_configured')

  const clockIn = Number(data?.clocked_in_at_timestamp)
  const clockOut = Number(data?.clocked_out_at_timestamp)
  const userId = data?.user_id
  if (!userId || !Number.isFinite(clockIn)) throw new Error('users.clocked_out payload missing user_id/clocked_in_at_timestamp')

  const startUnix = clockIn - 3600
  const endUnix = (Number.isFinite(clockOut) ? clockOut : clockIn) + 3600
  const res = await callDroptop('get-staff-time-clock', { operation_ids: operationId, startUnix: String(startUnix), endUnix: String(endUnix) }, publicKey, privateKey)
  const entries: { user: any; time_records?: any[] }[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []

  const nowIso = new Date().toISOString()
  const rows: Record<string, unknown>[] = []
  for (const entry of entries) {
    const user = entry.user
    if (!user?.user_id || user.user_id !== userId) continue
    for (const record of entry.time_records ?? []) {
      if (!Number.isFinite(Number(record.clock_in))) continue
      if (Math.abs(Number(record.clock_in) - clockIn) > 60) continue // this specific punch, not every punch this user has in the window
      rows.push({
        company_id: companyId, location_id: locationId, droptop_user_id: user.user_id,
        first_name: user.first_name ?? null, last_name: user.last_name ?? null, email: user.email ?? null, phone_number: user.phone_number ?? null,
        clock_in: tsToIso(record.clock_in), clock_out: tsToIso(record.clock_out),
        hours: numOrNull(record.hours), hours_regular: numOrNull(record.hours_regular), hours_overtime: numOrNull(record.hours_overtime),
        hourly_wage: numOrNull(record.hourly_wage), overtime_pay_rate: numOrNull(record.overtime_pay_rate),
        work_week_start: record.work_week_start ?? null, work_week_end: record.work_week_end ?? null,
        hours_per_week: numOrNull(record.hours_per_week), raw: record, last_change_source: 'droptop_webhook', updated_at: nowIso,
      })
    }
  }
  if (!rows.length) throw new Error(`get-staff-time-clock returned no matching punch for user ${userId} at clock_in ${clockIn}`)
  const { error } = await admin.schema('inventory').from('droptop_time_records')
    .upsert(rows, { onConflict: 'company_id,location_id,droptop_user_id,clock_in' })
  if (error) throw new Error(`droptop_time_records upsert: ${error.message}`)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return ok({ error: 'method not allowed' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const webhookSecret = Deno.env.get('DROPTOP_WEBHOOK_SECRET')
  if (!webhookSecret) return fail({ error: 'DROPTOP_WEBHOOK_SECRET not configured' })
  const signature = req.headers.get('x-droptop-signature')
  const timestamp = req.headers.get('x-droptop-timestamp')
  if (!signature || !timestamp) return reject({ error: 'missing signature/timestamp headers' })

  // Read the RAW body text once — the signature is computed over
  // JSON.stringify(that raw text), not over a parsed-then-reserialized
  // object (see the header comment). req.text() must happen before any
  // req.json() call since the body stream can only be consumed once.
  const rawBody = await req.text()
  const expectedSig = await computeHmacHex(webhookSecret, `${timestamp}.${JSON.stringify(rawBody)}`)
  if (!timingSafeEqualHex(expectedSig, signature)) return reject({ error: 'invalid signature' })

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return ok({ error: 'invalid JSON body' })
  }

  const deliveryId: string = payload?.id ?? crypto.randomUUID()
  const event: string = payload?.event ?? 'unknown'
  const data = payload?.data ?? null
  const operationId: string | null = data?.operation_id ?? payload?.operation_ids?.[0] ?? null

  async function log(status: string, companyId: string | null, errorMessage: string | null) {
    await admin.schema('inventory').from('droptop_webhook_log').upsert({
      id: deliveryId, event, operation_id: operationId, company_id: companyId,
      status, error_message: errorMessage, received_at: new Date().toISOString(),
      raw_payload: payload,
    })
  }

  // Dedupe — a delivery already logged successful is acked again without
  // reprocessing (Droptop's own retry/manual-resend can redeliver the same id).
  const { data: existing } = await admin.schema('inventory').from('droptop_webhook_log').select('status').eq('id', deliveryId).maybeSingle()
  if (existing?.status === 'success') return ok({ success: true, deduped: true })

  if (!operationId) { await log('error', null, 'No operation_id in payload'); return ok({ success: false, error: 'no operation_id' }) }
  if (!data) { await log('ignored', null, 'Empty data payload (Droptop test/ping event?)'); return ok({ success: true, ignored: true }) }

  const { data: loc } = await admin.schema('core').from('locations')
    .select('id, company_id').eq('droptop_operation_id', operationId).maybeSingle()
  if (!loc) { await log('error', null, `No location matches operation_id ${operationId}`); return ok({ success: false, error: 'unknown operation_id' }) }

  try {
    if (event === 'orders.finalized' || event === 'orders.voided' || event === 'orders.started') {
      await handleOrderEvent(admin, loc.company_id, loc.id, data)
    } else if (event === 'users.clocked_out') {
      await handleClockedOut(admin, loc.company_id, loc.id, operationId, data)
    } else {
      await log('ignored', loc.company_id, `Unhandled event type: ${event}`)
      return ok({ success: true, ignored: true })
    }
    await log('success', loc.company_id, null)
    return ok({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await log('error', loc.company_id, message)
    return fail({ success: false, error: message })
  }
})
