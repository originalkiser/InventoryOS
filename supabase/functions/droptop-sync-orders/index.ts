// Droptop Orders sync — replaces the customer-list approach
// (droptop-sync-customers / inventory.droptop_customers) as the Customer
// Heatmap's data source. See inventory.droptop_orders' own migration
// comment for why: that approach pulled a shop's ENTIRE customer history
// (10,000+ per location in practice) every run; orders are naturally
// date-bounded, so a routine pull only ever touches a recent window.
//
// droptop-sync-customers and inventory.droptop_customers are left in place
// (real synced data, not dropped) but nothing writes to or reads them
// going forward — this function and inventory.droptop_orders replace them.
//
// Same conventions as droptop-sync-usage/droptop-sync-purchase-orders/
// droptop-sync-customers (dual auth, sig-signed requests, per-location
// calls, data_connection_sync_log entry, lat/lng resolved from
// inventory.zip_centroids by zip) — not re-explained here.
//
// get-orders caps each request at a 31-day range, so a wider requested
// window is split into sequential 31-day sub-windows per location and
// merged (deduped by order_id, same "Map not array push" precedent as the
// PO/customer syncs — a repeat order_id across sub-windows, e.g. a
// last_updated edit near a window boundary, just overwrites in place).
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, daysBack?, startUnix?, endUnix?, statusTypes?, locationId?, locationIds? }
//   mode        — 'sync' (explicit range, daysBack or startUnix/endUnix) |
//                 'incremental' (routine steady-state mode — per location,
//                 pulls from the day after inventory.droptop_order_
//                 sync_state's last_synced_date through yesterday, capped
//                 at a 30-day catch-up; see that table's own migration
//                 comment for the full design, including why it's safe
//                 for shops closed on Sundays) | 'inspect' (read-only
//                 raw-shape peek)
//   daysBack    — mode:'sync' only: window size ending now; default 30.
//                 Ignored if startUnix/endUnix are both given.
//   startUnix/endUnix — mode:'sync' only: explicit window (unix seconds) —
//                 lets the Historical Orders Backfill (Data Connections)
//                 and the Customer Heatmap pull an arbitrary custom range
//                 on demand.
//   statusTypes — forwarded to Droptop's own filter (comma-separated:
//                 Finalized, Void, Uncollectible, Scheduled). Unset = the
//                 API's own default (Finalized, Void, Uncollectible).
//   locationId  — sync a single location
//   locationIds — sync a specific batch of locations (client-side chunking)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── Droptop auth sig — identical to the other Droptop sync functions ──────
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function callDroptop(
  endpoint: string, params: Record<string, string>, publicKey: string, privateKey: string, maxRetries = 5,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const sig = await buildSig(publicKey, 'GET', privateKey)
    const qs = new URLSearchParams({ sig, ...params })
    const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
    const res = await fetch(url, { headers: { 'x-api-key': publicKey.trim() }, redirect: 'follow' })
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2000 * 2 ** attempt
      await res.text().catch(() => {})
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
    return JSON.parse(text)
  }
}

const MAX_RANGE_SECONDS = 31 * 86400

// Splits [startUnix, endUnix] into <=31-day sub-windows and fetches each,
// merging results. get-orders' own docs show a plain array response (no
// pagination envelope) — defensively unwrapped anyway, matching every
// other Droptop endpoint in this codebase that nested one level deeper
// than its docs claimed.
async function fetchOrders(
  operationId: string, startUnix: number, endUnix: number, statusTypes: string | undefined, pub: string, priv: string,
): Promise<any[]> {
  const all: any[] = []
  let windowStart = startUnix
  while (windowStart < endUnix) {
    const windowEnd = Math.min(windowStart + MAX_RANGE_SECONDS, endUnix)
    const params: Record<string, string> = { operation_ids: operationId, startUnix: String(windowStart), endUnix: String(windowEnd) }
    if (statusTypes) params.statusTypes = statusTypes
    const res = await callDroptop('get-orders', params, pub, priv)
    const orders: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    all.push(...orders)
    windowStart = windowEnd
  }
  return all
}

function tsToIso(unix: unknown): string | null {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const publicKey = Deno.env.get('DROPTOP_PUBLIC_KEY')
    const privateKey = Deno.env.get('DROPTOP_PRIVATE_KEY')
    if (!publicKey || !privateKey) return ok({ error: 'credentials_not_configured' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const syncSecret = Deno.env.get('DROPTOP_SYNC_SECRET')
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    const secretAuthed = !!syncSecret && suppliedSecret === syncSecret

    let companyId: string | null = null
    if (secretAuthed) {
      const { data: anyLoc } = await (admin as any).schema('core').from('locations').select('company_id').limit(1).maybeSingle()
      companyId = anyLoc?.company_id ?? null
    } else {
      const authHeader = req.headers.get('Authorization') ?? ''
      const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: who, error: whoErr } = await caller.auth.getUser()
      if (whoErr || !who.user) return ok({ error: 'Not authenticated' })
      const { data: me } = await (caller as any).schema('platform').from('user_profiles').select('company_id').eq('id', who.user.id).single()
      companyId = me?.company_id ?? null
    }
    if (!companyId) return ok({ error: 'Unable to resolve company' })

    const body = await req.json().catch(() => ({}))
    const mode: 'sync' | 'inspect' | 'incremental' =
      body.mode === 'inspect' ? 'inspect' : body.mode === 'incremental' ? 'incremental' : 'sync'
    const nowUnix = Math.floor(Date.now() / 1000)
    const hasExplicitRange = Number.isFinite(Number(body.startUnix)) && Number.isFinite(Number(body.endUnix))
    const daysBack = Math.min(3650, Math.max(1, Number(body.daysBack) || 30))
    const startUnix = hasExplicitRange ? Number(body.startUnix) : nowUnix - daysBack * 86400
    const endUnix = hasExplicitRange ? Number(body.endUnix) : nowUnix
    const statusTypes: string | undefined = typeof body.statusTypes === 'string' ? body.statusTypes : undefined
    const locationId: string | undefined = body.locationId
    const locationIds: string[] = Array.isArray(body.locationIds) ? body.locationIds : []

    // Incremental mode: per-location "pull just what's new" instead of one
    // shared window for every location. Each location's own start date is
    // the day after inventory.droptop_order_sync_state's last_synced_date
    // for it — a location that's never been tracked (e.g. the first
    // incremental run right after a historical backfill covered it some
    // other way) falls back to a bounded lookback rather than erroring or
    // guessing further back than is safe. A location whose sync failed
    // yesterday, or for several days running, simply never advanced its
    // tracked date — so the very next run's start date is still "the day
    // after whatever last succeeded", naturally widening to cover the gap
    // with no separate catch-up code path needed. Capped at
    // MAX_CATCHUP_DAYS so a location stuck for a long time catches up over
    // several runs instead of one huge, timeout-prone pull.
    //
    // This also already does the right thing for the real cohort of
    // locations closed on Sundays: the tracked date advances on a
    // *successful fetch*, not on "did we find any orders" — a closed
    // Sunday with zero real orders is indistinguishable here from any
    // other successfully-checked day, so it's never mistaken for a gap
    // that needs re-catching-up.
    const MAX_CATCHUP_DAYS = 30
    const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0)
    const yesterdayUtc = new Date(todayUtc); yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1)
    const yesterdayEndUnix = Math.floor(yesterdayUtc.getTime() / 1000) + 86399 // 23:59:59 UTC

    let locQuery = (admin as any).schema('core').from('locations')
      .select('id, droptop_operation_id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
    if (locationId) locQuery = locQuery.eq('id', locationId)
    else if (locationIds.length) locQuery = locQuery.in('id', locationIds)
    const { data: locs, error: locErr } = await locQuery
    if (locErr) return ok({ error: `Locations query failed: ${locErr.message}` })
    const locations = (locs ?? []).filter((l: any) => l.droptop_operation_id)
    if (!locations.length) {
      return ok({ error: 'No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.' })
    }

    if (mode === 'inspect') {
      const opId = locations[0].droptop_operation_id
      const params: Record<string, string> = { operation_ids: opId, startUnix: String(startUnix), endUnix: String(Math.min(endUnix, startUnix + MAX_RANGE_SECONDS)) }
      if (statusTypes) params.statusTypes = statusTypes
      const raw = await callDroptop('get-orders', params, publicKey, privateKey)
      return ok({ success: true, operation_id: opId, raw_response: raw })
    }

    let ordersUpserted = 0
    const warnings: string[] = []
    const ordersByKey = new Map<string, { o: any; locationId: string }>()
    // location_id -> the endUnix its fetch actually succeeded through —
    // only these get their sync-state advanced afterward.
    const succeededThrough = new Map<string, number>()
    // Widest [start,end] actually fetched this run, across all locations —
    // for incremental mode the response's `window` below reports this
    // instead of the unused shared-range fallback, since each location can
    // have a different real start date.
    let incrementalMinStart = Infinity
    let incrementalMaxEnd = -Infinity

    // Best-effort — brand-new table, may not be migrated in production yet.
    const syncStateByLocation = new Map<string, string>() // location_id -> last_synced_date (yyyy-mm-dd)
    if (mode === 'incremental') {
      const { data: stateRows, error: stateReadErr } = await (admin as any)
        .schema('inventory').from('droptop_order_sync_state')
        .select('location_id, last_synced_date')
        .eq('company_id', companyId)
        .in('location_id', locations.map((l: any) => l.id))
      if (stateReadErr) warnings.push(`sync-state read: ${stateReadErr.message}`)
      for (const r of (stateRows ?? []) as { location_id: string; last_synced_date: string }[]) {
        syncStateByLocation.set(r.location_id, r.last_synced_date)
      }
    }

    for (const loc of locations) {
      try {
        let locStartUnix: number
        let locEndUnix: number
        if (mode === 'incremental') {
          const lastDate = syncStateByLocation.get(loc.id)
          const earliestAllowed = new Date(yesterdayUtc.getTime() - MAX_CATCHUP_DAYS * 86400_000)
          let start = lastDate ? new Date(`${lastDate}T00:00:00.000Z`) : earliestAllowed
          if (lastDate) start.setUTCDate(start.getUTCDate() + 1) // day AFTER last synced, not that day again
          if (start < earliestAllowed) start = earliestAllowed
          locStartUnix = Math.floor(start.getTime() / 1000)
          locEndUnix = yesterdayEndUnix
          if (locStartUnix > locEndUnix) continue // already caught up (e.g. run more than once today)
        } else {
          locStartUnix = startUnix
          locEndUnix = endUnix
        }
        const orders = await fetchOrders(loc.droptop_operation_id, locStartUnix, locEndUnix, statusTypes, publicKey, privateKey)
        for (const o of orders) ordersByKey.set(`${loc.id}|${o.order_id}`, { o, locationId: loc.id })
        if (mode === 'incremental') {
          succeededThrough.set(loc.id, locEndUnix)
          incrementalMinStart = Math.min(incrementalMinStart, locStartUnix)
          incrementalMaxEnd = Math.max(incrementalMaxEnd, locEndUnix)
        }
      } catch (e) {
        warnings.push(`location ${loc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const allOrders = [...ordersByKey.values()]

    const zips = [...new Set(allOrders.map(({ o }) => String(o.customer?.zip ?? '').trim()).filter(Boolean))]
    const zipToLatLng = new Map<string, { lat: number; lng: number }>()
    const ZIP_BATCH = 500
    for (let i = 0; i < zips.length; i += ZIP_BATCH) {
      const slice = zips.slice(i, i + ZIP_BATCH)
      const { data: rows, error } = await (admin as any)
        .schema('inventory').from('zip_centroids').select('zip, lat, lng').in('zip', slice)
      if (error) { warnings.push(`zip_centroids lookup: ${error.message}`); break }
      for (const r of (rows ?? []) as { zip: string; lat: number; lng: number }[]) zipToLatLng.set(r.zip, { lat: r.lat, lng: r.lng })
    }

    const nowIso = new Date().toISOString()
    const rows = allOrders.map(({ o, locationId: locId }) => {
      const c = o.customer ?? {}
      const zip = String(c.zip ?? '').trim() || null
      const coords = zip ? zipToLatLng.get(zip) : undefined
      return {
        company_id: companyId,
        location_id: locId,
        order_id: o.order_id,
        customer_id: c.customer_id ?? null,
        first_name: c.first_name ?? null,
        last_name: c.last_name ?? null,
        email: c.email ?? null,
        phone_number: c.phone_number ?? null,
        address: c.address ?? null,
        city: c.city ?? null,
        region: c.region ?? null,
        zip,
        country: c.country ?? null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        status: o.status ?? null,
        subtotal: o.subtotal != null ? Number(o.subtotal) : null,
        final_price: o.final_price != null ? Number(o.final_price) : null,
        casual_items: o.casual_items ?? [],
        coupons: o.coupons ?? [],
        discounts: o.discounts ?? [],
        raw_data: o,
        order_finalized_at: tsToIso(o.order_finalized),
        order_scheduled_at: tsToIso(o.order_scheduled_at),
        synced_at: nowIso,
        last_change_source: 'droptop',
        updated_at: nowIso,
      }
    })

    const BATCH = 500
    // location_id|order_id -> saved row id, filled in as each upsert batch
    // returns — needed below to attach package/product line items to the
    // right order via its internal uuid, not Droptop's own order_id.
    const idByOrderKey = new Map<string, string>()
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { data: saved, error: upsertErr } = await (admin as any)
        .schema('inventory').from('droptop_orders')
        .upsert(slice, { onConflict: 'company_id,location_id,order_id' })
        .select('id, location_id, order_id')
      if (upsertErr) { warnings.push(`Order batch ${i}-${i + slice.length}: ${upsertErr.message}`); continue }
      for (const r of (saved ?? []) as { id: string; location_id: string; order_id: string }[]) {
        idByOrderKey.set(`${r.location_id}|${r.order_id}`, r.id)
      }
      ordersUpserted += slice.length
    }

    // Package/product/service line items — replaced wholesale per synced
    // order (delete then insert), same pattern as
    // droptop_purchase_order_items. services is captured separately from
    // the top-level products array: it's the only place a product is
    // linked to the package it was used to perform (package_id + its own
    // nested products[]) — see droptop_order_services' own migration
    // comment for why that distinction matters.
    const savedOrderIds = [...idByOrderKey.values()]
    let packagesWritten = 0
    let productsWritten = 0
    let servicesWritten = 0
    if (savedOrderIds.length) {
      for (let i = 0; i < savedOrderIds.length; i += BATCH) {
        const slice = savedOrderIds.slice(i, i + BATCH)
        const [{ error: pkgDelErr }, { error: prodDelErr }, { error: svcDelErr }] = await Promise.all([
          (admin as any).schema('inventory').from('droptop_order_packages').delete().in('order_id', slice),
          (admin as any).schema('inventory').from('droptop_order_products').delete().in('order_id', slice),
          (admin as any).schema('inventory').from('droptop_order_services').delete().in('order_id', slice),
        ])
        if (pkgDelErr) warnings.push(`Package delete batch ${i}: ${pkgDelErr.message}`)
        if (prodDelErr) warnings.push(`Product delete batch ${i}: ${prodDelErr.message}`)
        if (svcDelErr) warnings.push(`Service delete batch ${i}: ${svcDelErr.message}`)
      }

      const packageRows = allOrders.flatMap(({ o, locationId: locId }) => {
        const orderUuid = idByOrderKey.get(`${locId}|${o.order_id}`)
        if (!orderUuid) return []
        return (o.packages ?? []).map((p: any) => ({
          order_id: orderUuid,
          company_id: companyId,
          package_id: p.package_id ?? null,
          name: p.name ?? null,
          description: p.description ?? null,
          internal_name: p.internal_name ?? null,
          base_service_price: p.base_service_price != null ? Number(p.base_service_price) : null,
          price: p.price != null ? Number(p.price) : null,
          price_total: p.price_total != null ? Number(p.price_total) : null,
          price_total_after_discount: p.price_total_aft_discount != null ? Number(p.price_total_aft_discount) : null,
          vin: p.vin ?? null,
          license_plate: p.license_plate ?? null,
          vehicle_name: p.vehicle_name ?? null,
          financial_category_id: p.financial_category?.financial_category_id ?? null,
          financial_category_name: p.financial_category?.name ?? null,
          financial_category_code: p.financial_category?.code ?? null,
          coupons: p.coupons ?? [],
        }))
      })
      const productRows = allOrders.flatMap(({ o, locationId: locId }) => {
        const orderUuid = idByOrderKey.get(`${locId}|${o.order_id}`)
        if (!orderUuid) return []
        return (o.products ?? []).map((pr: any) => ({
          order_id: orderUuid,
          company_id: companyId,
          inventory_id: pr.inventory_id ?? null,
          product_id: pr.product_id ?? null,
          sequence_id: pr.sequence_id ?? null,
          product_type: pr.product_type ?? null,
          product_type_pcdb_id: pr.product_type_pcdb_id ?? null,
          brand_name: pr.brand_name ?? null,
          uom: pr.uom ?? null,
          restocked: pr.restocked ?? null,
          quantity_total: pr.quantity_total != null ? Number(pr.quantity_total) : null,
          price_total: pr.price_total != null ? Number(pr.price_total) : null,
          cost_total: pr.cost_total != null ? Number(pr.cost_total) : null,
          quantity_on_hand: pr.quantity_on_hand != null ? Number(pr.quantity_on_hand) : null,
          financial_category_id: pr.financial_category?.financial_category_id ?? null,
          financial_category_name: pr.financial_category?.name ?? null,
          financial_category_code: pr.financial_category?.code ?? null,
        }))
      })
      const serviceRows = allOrders.flatMap(({ o, locationId: locId }) => {
        const orderUuid = idByOrderKey.get(`${locId}|${o.order_id}`)
        if (!orderUuid) return []
        return (o.services ?? []).map((s: any) => ({
          order_id: orderUuid,
          company_id: companyId,
          package_id: s.package_id ?? null,
          service_id: s.service_id ?? null,
          service_name: s.service_name ?? null,
          vin: s.vin ?? null,
          license_plate: s.license_plate ?? null,
          vehicle_name: s.vehicle_name ?? null,
          products: s.products ?? [],
        }))
      })

      // Insert the 3 child tables' batches in parallel per batch-index
      // (they're independent tables, no reason to wait on one before
      // starting the next) — cuts this phase's wall time roughly 3x versus
      // running them one after another, which matters now that every
      // location invocation is doing meaningfully more write work than
      // when this sync only wrote order headers.
      const maxLen = Math.max(packageRows.length, productRows.length, serviceRows.length)
      for (let i = 0; i < maxLen; i += BATCH) {
        const pkgSlice = packageRows.slice(i, i + BATCH)
        const prodSlice = productRows.slice(i, i + BATCH)
        const svcSlice = serviceRows.slice(i, i + BATCH)
        const [pkgRes, prodRes, svcRes] = await Promise.all([
          pkgSlice.length ? (admin as any).schema('inventory').from('droptop_order_packages').insert(pkgSlice) : Promise.resolve({ error: null }),
          prodSlice.length ? (admin as any).schema('inventory').from('droptop_order_products').insert(prodSlice) : Promise.resolve({ error: null }),
          svcSlice.length ? (admin as any).schema('inventory').from('droptop_order_services').insert(svcSlice) : Promise.resolve({ error: null }),
        ])
        if (pkgRes.error) warnings.push(`Package insert batch ${i}: ${pkgRes.error.message}`); else packagesWritten += pkgSlice.length
        if (prodRes.error) warnings.push(`Product insert batch ${i}: ${prodRes.error.message}`); else productsWritten += prodSlice.length
        if (svcRes.error) warnings.push(`Service insert batch ${i}: ${svcRes.error.message}`); else servicesWritten += svcSlice.length
      }
    }

    // Advance sync-state only for locations whose fetch actually succeeded
    // this run — a location that errored keeps its prior last_synced_date,
    // so the next run's start date naturally widens to cover the gap.
    // Best-effort: never fails the whole sync (brand-new table).
    if (mode === 'incremental' && succeededThrough.size > 0) {
      const stateRows = [...succeededThrough.entries()].map(([locationId2, endUnix2]) => ({
        company_id: companyId,
        location_id: locationId2,
        last_synced_date: new Date(endUnix2 * 1000).toISOString().slice(0, 10),
        updated_at: nowIso,
      }))
      const { error: stateErr } = await (admin as any)
        .schema('inventory').from('droptop_order_sync_state')
        .upsert(stateRows, { onConflict: 'company_id,location_id' })
      if (stateErr) warnings.push(`sync-state update: ${stateErr.message}`)
    }

    const withCoords = rows.filter((r) => r.lat != null).length
    const status = warnings.length ? (ordersUpserted > 0 ? 'partial' : 'error') : 'success'
    await (admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId,
      connection: 'droptop_orders',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      items_updated: ordersUpserted,
      items_unchanged: 0,
      items_inserted: 0,
      status,
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({
      success: status !== 'error',
      locations_synced: locations.length,
      orders_upserted: ordersUpserted,
      orders_with_coordinates: withCoords,
      orders_missing_zip_match: ordersUpserted - withCoords,
      packages_written: packagesWritten,
      products_written: productsWritten,
      services_written: servicesWritten,
      window: mode === 'incremental'
        ? (incrementalMaxEnd >= incrementalMinStart ? { startUnix: incrementalMinStart, endUnix: incrementalMaxEnd } : null)
        : { startUnix, endUnix },
      warnings,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
