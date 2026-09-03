// Droptop usage + on-hands sync.
// Reads all core.locations with droptop_operation_id set, pulls sales change
// events and/or current inventory from Droptop, and upserts into
// inventory.product_usage. Can also scan adjustment activity against
// inventory.alert_thresholds and write inventory.inventory_alerts.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, daysBack?, locationId?, locationIds?, categories?, writeToCountProducts?, countMonth? }
//   mode        — 'both' (default) | 'inventory' (on-hands only, 1 call/location)
//                 | 'usage' (sales changes only) | 'alerts' (adjustment scan)
//                 Partial modes preserve the other side's existing values and
//                 recompute days_of_supply from the merged pair.
//   daysBack    — usage/alerts window in days; default 30 (alerts: 1), max 365
//   locationId  — sync a single location
//   locationIds — sync a specific batch of locations (client-side chunking for
//                 a full-company sync — see runDroptopSync in droptopService.ts).
//                 Ignored if locationId is also set. Neither set = every
//                 location with a droptop_operation_id.
//   categories  — product_type filter terms (case-insensitive substring match,
//                 e.g. ["engine oil", "additive"]); empty/absent = all products.
//                 Droptop has no server-side category filter, so this is applied
//                 after fetch, before writing to product_usage.
//   writeToCountProducts / countMonth — opt-in: also feed this pull's on-hands
//                 into inventory.count_products for the given Month End period
//                 (YYYY-MM-01), so a same-day Droptop pull shows up in Month
//                 End's Product Detail without also needing a manual upload.
//                 Set only by Month End's Daily Pull panel — see step 5b below.
//
// Per-location work (one or two Droptop API calls, more if a location's
// change-event window paginates) runs with bounded concurrency rather than
// one location at a time — a full-company "all shops" sync used to run every
// location sequentially, which for 200+ locations could easily exceed the
// Edge Function's execution time limit. The platform kills the invocation at
// that point and returns a non-2xx status with no useful body, which is what
// surfaces client-side as "Edge Function returned a non-2xx status code" —
// the function's own code always tries to respond 200, even on internal
// errors, so that generic message only ever comes from the platform, not
// from a `return ok({ error: ... })` path below.
//
// Kept deliberately low (2) — Droptop's own rate limit is tight enough that
// higher concurrency (5 was tried) produced a wall of 429s once a sync got a
// few batches in. callDroptop retries 429s with backoff, so occasional ones
// are fine; the low concurrency just keeps them occasional instead of the
// default state. Batching locations across several invocations (see
// runDroptopSync in droptopService.ts) is what actually keeps each
// invocation's wall-clock time bounded — concurrency here is a modest speed
// bonus on top of that, not the timeout fix.
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ── Droptop auth sig ─────────────────────────────────────────────────────────
// sig = base64(base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey)))
// ECB implemented via AES-CBC with a zeroed IV applied per 16-byte block.

// Returns [keyBytes, detectedFormat] for diagnostics.
async function parseKey(key: string): Promise<[Uint8Array, string]> {
  const k = key.trim()
  // 64-char hex → 32 bytes directly
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(k.slice(i * 2, i * 2 + 2), 16)
    return [bytes, `hex-64`]
  }
  // Raw UTF-8 bytes: if already a valid AES key size (16/24/32) use directly.
  const rawBytes = new TextEncoder().encode(k)
  if (rawBytes.length === 16 || rawBytes.length === 24 || rawBytes.length === 32) {
    return [rawBytes, `raw-utf8-${rawBytes.length}bytes`]
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes)
  return [new Uint8Array(hashBuffer), `sha256-from-${rawBytes.length}bytes`]
}

async function buildSig(publicKey: string, method: string, privateKey: string): Promise<[string, string, string]> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey.trim()}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = new TextEncoder().encode(message)

  // PKCS7 pad to 16-byte boundary
  const padLen = 16 - (msgBytes.length % 16)
  const padded = new Uint8Array(msgBytes.length + padLen)
  padded.set(msgBytes)
  padded.fill(padLen, msgBytes.length)

  const [keyBytes, keyFormat] = await parseKey(privateKey)
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt'],
  )

  // Encrypt each 16-byte block independently with zero IV = AES-ECB
  const zeroIV = new Uint8Array(16)
  const encrypted = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, padded.slice(i, i + 16))
    encrypted.set(new Uint8Array(enc).slice(0, 16), i)
  }

  // Droptop expects DOUBLE base64: their reference aesEncrypt already returns
  // base64 (PHP openssl_encrypt default), which is then base64-encoded again.
  const sig = btoa(btoa(String.fromCharCode(...encrypted)))
  return [sig, keyFormat, message]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Retries on 429 (Droptop's own rate limit, not a transient network blip) —
// a full-company sync easily makes hundreds of Droptop calls across the run,
// which trips Droptop's rate limiter regardless of how conservative the
// concurrency setting is. Honors Retry-After when Droptop sends one, else
// backs off exponentially (2s, 4s, 8s, 16s, 32s). The signature is
// timestamp-based, so each retry rebuilds it rather than reusing the first
// attempt's — Droptop would otherwise see a stale/replayed signature.
async function callDroptop(
  endpoint: string,
  params: Record<string, string>,
  publicKey: string,
  privateKey: string,
  maxRetries = 5,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const [sig] = await buildSig(publicKey, 'GET', privateKey)
    const qs = new URLSearchParams({ sig, ...params })
    const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
    const res = await fetch(url, {
      headers: { 'x-api-key': publicKey.trim() },
      redirect: 'follow',
    })
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : 2000 * 2 ** attempt
      await res.text().catch(() => {}) // drain the body before retrying
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
    return JSON.parse(text)
  }
}

// ── Droptop data fetchers ────────────────────────────────────────────────────

// Returns all change events in [startUnix, endUnix], paginated. Caller filters
// by change_type — the API has no change_type filter.
async function fetchChanges(
  operationId: string,
  startUnix: number,
  endUnix: number,
  pub: string,
  priv: string,
): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null

  while (true) {
    const params: Record<string, string> = {
      operation_ids: operationId,
      limit: '1000',
      startUnix: String(startUnix),
      endUnix: String(endUnix),
    }
    if (cursor) params.startingAfter = cursor

    const res = await callDroptop('get-inventory-changes', params, pub, priv)
    // Response: { data: { more_available, data_count, data: [...] } }
    const inner = res?.data ?? res
    const changes: any[] = Array.isArray(inner) ? inner : (inner?.data ?? [])

    all.push(...changes)

    if (!inner?.more_available) break
    cursor = changes.length > 0 ? changes[changes.length - 1].inventory_change_id : null
    if (!cursor) break
  }

  return all
}

// Returns the full inventory list (current on-hands) for one operation.
async function fetchInventory(operationId: string, pub: string, priv: string): Promise<any[]> {
  const res = await callDroptop('get-inventory', { operation_ids: operationId }, pub, priv)
  // Response: { data: [...] }
  const items = res?.data ?? res
  return Array.isArray(items) ? items : []
}

// ── Main handler ─────────────────────────────────────────────────────────────

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

    // 1. Verify caller — either a shared secret (pg_cron/the Data Connections
    // dispatcher, no user session available) or a real logged-in user (the
    // Config page's "Run Now" button). Same dual-auth shape as
    // skybitz-tank-sync.
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const syncSecret = Deno.env.get('DROPTOP_SYNC_SECRET')
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    const secretAuthed = !!syncSecret && suppliedSecret === syncSecret

    let companyId: string | null = null
    if (secretAuthed) {
      // Single-tenant deployment — every location belongs to the same company.
      const { data: anyLoc } = await (admin as any)
        .schema('core').from('locations').select('company_id').limit(1).maybeSingle()
      companyId = anyLoc?.company_id ?? null
    } else {
      const authHeader = req.headers.get('Authorization') ?? ''
      const caller = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: who, error: whoErr } = await caller.auth.getUser()
      if (whoErr || !who.user) return ok({ error: 'Not authenticated' })
      const { data: me } = await (caller as any)
        .schema('platform').from('user_profiles')
        .select('company_id')
        .eq('id', who.user.id)
        .single()
      companyId = me?.company_id ?? null
    }
    if (!companyId) return ok({ error: 'Unable to resolve company' })

    const body = await req.json().catch(() => ({}))
    const mode: 'both' | 'inventory' | 'usage' | 'alerts' | 'inspect' =
      ['inventory', 'usage', 'alerts', 'inspect'].includes(body.mode) ? body.mode : 'both'
    const defaultDays = mode === 'alerts' ? 1 : 30
    const daysBack = Math.min(Math.max(Number(body.daysBack ?? defaultDays), 1), 365)
    const locationId: string | null = body.locationId ?? null
    const locationIds: string[] = !locationId && Array.isArray(body.locationIds)
      ? body.locationIds.filter((v: unknown) => typeof v === 'string')
      : []
    const categories: string[] = Array.isArray(body.categories)
      ? body.categories.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean)
      : []
    // Opt-in: also feed this pull's on-hands into inventory.count_products for
    // Month End, under a dedicated batch this sync owns (source_type 'api',
    // file_name 'Droptop Daily Pull'). Only Month End's Daily Pull sets this —
    // Product Usage's own sync stays scoped to product_usage as before, so an
    // unrelated manual refresh there can't quietly create month-end count data.
    const writeToCountProducts = body.writeToCountProducts === true
    const countProductsMonth: string | null = writeToCountProducts && typeof body.countMonth === 'string' ? body.countMonth : null
    // Opt-in: also write each change event into inventory.daily_product_activity,
    // bucketed by the calendar day it actually happened on — a real day-by-day
    // ledger, unlike product_usage's rolling daily_usage rate. Explicit flag
    // (not inferred from daysBack) so a manual daysBack:1 "Run Now" doesn't
    // accidentally start logging — only the Data Connections dispatcher's
    // scheduled daily run sets this.
    const logDailyActivity = body.logDailyActivity === true && mode !== 'inventory'
    const matchesCategory = (productType: string | null | undefined): boolean => {
      if (!categories.length) return true
      const pt = (productType ?? '').toLowerCase()
      return categories.some((c) => pt.includes(c))
    }
    const endUnix = Math.floor(Date.now() / 1000)
    const startUnix = endUnix - daysBack * 86400

    // 2. Load locations with droptop_operation_id mapped
    let locations: any[]
    {
      let q = (admin as any)
        .schema('core').from('locations')
        .select('id, droptop_operation_id')
        .eq('company_id', companyId)
        .not('droptop_operation_id', 'is', null)
      if (locationId) q = q.eq('id', locationId)
      else if (locationIds.length) q = q.in('id', locationIds)
      const { data, error } = await q
      if (error) return ok({ error: `Locations query failed: ${error.message}` })
      locations = (data ?? []).filter((l: any) => l.droptop_operation_id)
    }

    if (!locations.length) {
      return ok({ error: 'No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.' })
    }

    // ── Inspect mode: read-only peek at Droptop's raw response shape ───────
    // Never writes anything — returns a couple of un-mapped items exactly as
    // Droptop sends them, so we can see fields the sync doesn't currently
    // read (e.g. a per-item cost/value) before deciding how to use them.
    if (mode === 'inspect') {
      const opId = locations[0].droptop_operation_id
      const [inventory, changes] = await Promise.all([
        fetchInventory(opId, publicKey, privateKey),
        fetchChanges(opId, startUnix, endUnix, publicKey, privateKey),
      ])

      // Per-product breakdown — the exact same aggregation the real sync
      // uses to compute daily_usage (sum of change_type:'sale' quantity_change
      // over the window, divided by daysBack), surfaced raw so one location's
      // numbers can be checked against an independent manual count. Built
      // to investigate a case (Aug 2026, 239-Warr Acres) where daily_usage
      // came out well above a manual last-30-days calc for several products.
      type Breakdown = {
        product_id: string; sale_event_count: number; sale_qty_sum: number
        daily_usage: number; other_change_types: Record<string, number>
      }
      const breakdownByKey = new Map<string, Breakdown>()
      const displayId = new Map<string, string>()
      for (const change of changes) {
        if (!matchesCategory(change.product_type)) continue
        const pid: string = change.product_id
        if (!pid) continue
        const key = pid.toLowerCase()
        if (!displayId.has(key)) displayId.set(key, pid)
        let row = breakdownByKey.get(key)
        if (!row) {
          row = { product_id: displayId.get(key)!, sale_event_count: 0, sale_qty_sum: 0, daily_usage: 0, other_change_types: {} }
          breakdownByKey.set(key, row)
        }
        if (change.change_type === 'sale') {
          row.sale_event_count++
          row.sale_qty_sum += Math.abs(parseFloat(change.quantity_change || '0'))
        } else {
          const t = change.change_type || 'unknown'
          row.other_change_types[t] = (row.other_change_types[t] ?? 0) + 1
        }
      }
      const productBreakdown = Array.from(breakdownByKey.values())
        .map((r) => ({ ...r, daily_usage: Math.round((r.sale_qty_sum / daysBack) * 1000) / 1000 }))
        .sort((a, b) => b.sale_qty_sum - a.sale_qty_sum)

      // Optional: hand back every raw change event for one product (not just
      // a 5-row sample) so individual events can be eyeballed — duplicate
      // inventory_change_id, an out-of-window timestamp, an unexpectedly
      // large single quantity_change, etc.
      const requestedProductId: string | null = typeof body.productId === 'string' && body.productId.trim() ? body.productId.trim() : null
      const matchingRawChanges = requestedProductId
        ? changes.filter((c: any) => (c.product_id ?? '').toLowerCase() === requestedProductId.toLowerCase())
        : []

      return ok({
        success: true,
        operation_id: opId,
        location_id: locations[0].id,
        window_days: daysBack,
        total_change_events: changes.length,
        inventory_sample: inventory.slice(0, 3),
        changes_sample: changes.slice(0, 5),
        product_breakdown: productBreakdown,
        ...(requestedProductId ? { requested_product_id: requestedProductId, matching_raw_changes: matchingRawChanges } : {}),
      })
    }

    // ── Alerts mode: scan adjustment activity against thresholds ────────────
    if (mode === 'alerts') {
      const { data: rules, error: rulesErr } = await (admin as any)
        .schema('inventory').from('alert_thresholds')
        .select('id, product_id, category, max_adjustment')
        .eq('company_id', companyId)
        .eq('enabled', true)
      if (rulesErr) return ok({ error: `Thresholds query failed: ${rulesErr.message}` })
      if (!rules?.length) {
        return ok({ error: 'No enabled alert thresholds configured. Add rules in the Inventory Alerts section first.' })
      }

      const matchRule = (productId: string, productType: string): any | null => {
        for (const r of rules) {
          const pidOk = !r.product_id || r.product_id.trim().toLowerCase() === productId.toLowerCase()
          const catOk = !r.category || productType.toLowerCase().includes(r.category.trim().toLowerCase())
          if (pidOk && catOk) return r
        }
        return null
      }

      const alertRows: Record<string, unknown>[] = []
      let operationsScanned = 0
      const opErrors: string[] = []

      await mapWithConcurrency(locations, 2, async (loc: any) => {
        try {
          const changes = await fetchChanges(loc.droptop_operation_id, startUnix, endUnix, publicKey, privateKey)
          for (const c of changes) {
            const type: string = c.change_type ?? ''
            if (!type.startsWith('adjustment')) continue
            const qty = Math.abs(parseFloat(c.quantity_change || '0'))
            const rule = matchRule(c.product_id ?? '', c.product_type ?? '')
            if (!rule || qty < Number(rule.max_adjustment)) continue
            alertRows.push({
              company_id: companyId,
              location_id: loc.id,
              operation_id: loc.droptop_operation_id,
              product_id: c.product_id,
              category: c.product_type ?? null,
              change_type: type,
              quantity_change: parseFloat(c.quantity_change || '0'),
              threshold_id: rule.id,
              inventory_change_id: c.inventory_change_id,
              event_timestamp: c.created_timestamp
                ? new Date(Number(c.created_timestamp) * 1000).toISOString()
                : null,
            })
          }
          operationsScanned++
        } catch (opErr: unknown) {
          opErrors.push(`${loc.droptop_operation_id}: ${opErr instanceof Error ? opErr.message : String(opErr)}`)
        }
      })

      let alertsCreated = 0
      if (alertRows.length) {
        // ignoreDuplicates: re-scans of the same window must not duplicate alerts
        const { data: inserted, error: insErr } = await (admin as any)
          .schema('inventory').from('inventory_alerts')
          .upsert(alertRows, { onConflict: 'inventory_change_id', ignoreDuplicates: true })
          .select('id')
        if (insErr) return ok({ error: `Alert insert failed: ${insErr.message}` })
        alertsCreated = inserted?.length ?? 0
      }

      if (operationsScanned === 0 && opErrors.length > 0) {
        return ok({ error: opErrors.join(' | ') })
      }
      return ok({
        success: true,
        operations_synced: operationsScanned,
        alerts_created: alertsCreated,
        ...(opErrors.length > 0 ? { warnings: opErrors } : {}),
      })
    }

    // ── Sync modes: inventory / usage / both ────────────────────────────────

    // 3. Load existing product_usage rows — used both to dedup (id match) and,
    // for partial modes, to carry over the side we aren't pulling. Scoped to
    // just this invocation's locations (a chunked "all locations" sync
    // scopes each call to ~20 of them via locationIds) rather than the whole
    // company — pulling every row for every chunk added an unpaginated
    // full-table read per invocation, which is what pushed a heavy "Usage
    // Only" sync over the platform's execution time limit (see the top-level
    // comment on non-2xx errors). Still paginated as a safety net in case a
    // single chunk's own rows somehow clear PostgREST's db-max-rows (~1000)
    // — that cap is what silently truncated this before scoping was added,
    // letting rows look "new" and collide with their real pre-existing row
    // on the (company, location, product) unique index.
    const chunkLocationIds = locations.map((l: any) => l.id)
    const existingMap = new Map<string, any>()
    {
      // Raised to 5000 (2026-09-03, project Max Rows now 10,000). Exit
      // condition changed from `batch.length < PAGE` to a genuinely EMPTY
      // page — the former silently drops data the instant PAGE is set
      // above whatever the Max Rows cap happens to be (same fix already
      // applied to the ledger-read loop below and this app's client-side
      // fetch loops).
      const PAGE = 5000
      let from = 0
      for (;;) {
        const { data: rows, error } = await (admin as any)
          .schema('inventory').from('product_usage')
          .select('id, location_id, product_id, category, daily_usage, on_hands')
          .eq('company_id', companyId)
          .in('location_id', chunkLocationIds)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`Failed to load existing product_usage: ${error.message}`)
        const batch = (rows ?? []) as any[]
        for (const r of batch) {
          existingMap.set(`${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}`, r)
        }
        if (batch.length === 0) break
        from += PAGE
      }
    }

    // 4. Sync each location
    const allUpsertRows: Record<string, unknown>[] = []
    const dailyActivityRows = new Map<string, Record<string, unknown>>() // key: location|product|date
    let operationsSynced = 0
    // Rows touched but whose daily_usage/on_hands came out identical to what
    // was already there — reported separately from real changes in the
    // data-connection sync log, not excluded from allUpsertRows itself.
    let unchangedCount = 0
    const opErrors: string[] = []
    // Only locations that actually succeeded this pull — a location that
    // errored keeps whatever count_products it already had rather than
    // having them wiped by a scoped delete for data we don't actually have.
    const succeededLocIds: string[] = []

    await mapWithConcurrency(locations, 2, async (loc: any) => {
      try {
        const opId: string = loc.droptop_operation_id

        const [changes, inventory] = await Promise.all([
          mode !== 'inventory'
            ? fetchChanges(opId, startUnix, endUnix, publicKey, privateKey)
            : Promise.resolve([]),
          mode !== 'usage'
            ? fetchInventory(opId, publicKey, privateKey)
            : Promise.resolve([]),
        ])

        // Aggregate sales by product_id — keyed case-insensitively. The POS
        // API and existing product_usage rows don't always agree on casing
        // for the same product, and treating "Product-A" / "PRODUCT-A" as
        // two different products is what produced duplicate on-hand rows
        // for the same (location, product) before the unique index existed.
        const salesByProduct = new Map<string, number>() // key: lowercased product_id
        const displayId = new Map<string, string>() // lowercased -> first-seen raw casing
        for (const change of changes) {
          if (change.change_type !== 'sale') continue
          if (!matchesCategory(change.product_type)) continue
          const pid: string = change.product_id
          const key = pid.toLowerCase()
          const qty = Math.abs(parseFloat(change.quantity_change || '0'))
          salesByProduct.set(key, (salesByProduct.get(key) ?? 0) + qty)
          if (!displayId.has(key)) displayId.set(key, pid)
        }

        // Day-by-day ledger — every change event bucketed by the UTC calendar
        // date it happened on, split into sold/adjusted/other. Only built
        // when the caller opted in (the scheduled daily run), so a routine
        // 30-day resync doesn't churn this table for no reason.
        if (logDailyActivity) {
          for (const change of changes) {
            if (!matchesCategory(change.product_type)) continue
            const pid: string = change.product_id
            if (!pid) continue
            const ts = change.created_timestamp ? Number(change.created_timestamp) * 1000 : null
            if (ts == null || isNaN(ts)) continue
            const activityDate = new Date(ts).toISOString().slice(0, 10)
            const key = pid.toLowerCase()
            const rowKey = `${loc.id}|${key}|${activityDate}`
            const type: string = change.change_type ?? ''
            const qty = parseFloat(change.quantity_change || '0')
            let row = dailyActivityRows.get(rowKey)
            if (!row) {
              row = {
                company_id: companyId, location_id: loc.id, product_id: pid, activity_date: activityDate,
                category: change.product_type || null, sold_qty: 0, adjusted_qty: 0, other_qty: 0,
                raw_change_types: [] as string[], last_change_source: 'droptop', updated_at: new Date().toISOString(),
              }
              dailyActivityRows.set(rowKey, row)
            }
            if (type === 'sale') row.sold_qty = (row.sold_qty as number) + Math.abs(qty)
            else if (type.startsWith('adjustment')) row.adjusted_qty = (row.adjusted_qty as number) + qty
            else {
              row.other_qty = (row.other_qty as number) + Math.abs(qty)
              const raw = row.raw_change_types as string[]
              if (type && !raw.includes(type)) raw.push(type)
            }
          }
        }

        // Index inventory by product_id (same case-insensitive keying)
        const invByProduct = new Map<string, { on_hands: number; product_type: string }>()
        for (const item of inventory) {
          if (!matchesCategory(item.product_type)) continue
          const key = item.product_id.toLowerCase()
          invByProduct.set(key, {
            on_hands: parseFloat(item.quantity_on_hand || '0'),
            product_type: item.product_type || '',
          })
          if (!displayId.has(key)) displayId.set(key, item.product_id)
        }

        // Stamp today's on-hand snapshot onto today's activity row, when one
        // exists — the inventory pull is a live "right now" read, so it's
        // only contemporaneous with the current UTC date, not whichever
        // historical date a given change event happened to fall on.
        if (logDailyActivity && mode === 'both') {
          const today = new Date().toISOString().slice(0, 10)
          for (const [key, invData] of invByProduct) {
            const rowKey = `${loc.id}|${key}|${today}`
            const existingRow = dailyActivityRows.get(rowKey)
            if (existingRow) existingRow.ending_on_hand = invData.on_hands
            else dailyActivityRows.set(rowKey, {
              company_id: companyId, location_id: loc.id, product_id: displayId.get(key) ?? key, activity_date: today,
              category: invData.product_type || null, sold_qty: 0, adjusted_qty: 0, other_qty: 0,
              raw_change_types: [] as string[], ending_on_hand: invData.on_hands,
              last_change_source: 'droptop', updated_at: new Date().toISOString(),
            })
          }
        }

        // Products touched by the side(s) we pulled
        const productKeys = new Set([...salesByProduct.keys(), ...invByProduct.keys()])

        for (const key of productKeys) {
          const dedupeKey = `${loc.id ?? ''}|${key}`
          const existing = existingMap.get(dedupeKey)
          const invData = invByProduct.get(key)
          // Prefer the casing already on record for this row, so an existing
          // product_id (possibly referenced elsewhere) never gets rewritten
          // just because the POS API happened to send different casing.
          const productId = existing?.product_id ?? displayId.get(key) ?? key

          // Pulled side wins; other side carries over from the existing row.
          const dailyUsage = mode !== 'inventory'
            ? (salesByProduct.has(key) ? (salesByProduct.get(key)! / daysBack) : null)
            : (existing?.daily_usage ?? null)
          const onHands = mode !== 'usage'
            ? (invData ? invData.on_hands : null)
            : (existing?.on_hands ?? null)
          const daysOfSupply =
            dailyUsage && dailyUsage > 0 && onHands != null ? onHands / dailyUsage : null

          if (existing && existing.daily_usage === dailyUsage && existing.on_hands === onHands) {
            unchangedCount++
          }

          // Always supply an id, never rely on the column default — a batch
          // upsert mixes existing rows (which carry their real id) and new
          // rows in one INSERT ... ON CONFLICT statement, and PostgREST
          // sends an explicit NULL (not "use the default") for any column a
          // given row's object doesn't include, once ANY row in the batch
          // supplies that column. Same fix as useConfigTab.ts's importRows.
          allUpsertRows.push({
            id: existing?.id ?? crypto.randomUUID(),
            company_id: companyId,
            location_id: loc.id,
            product_id: productId,
            category: invData?.product_type || existing?.category || null,
            daily_usage: dailyUsage,
            on_hands: onHands,
            days_of_supply: daysOfSupply,
            last_change_source: 'droptop',
            updated_at: new Date().toISOString(),
          })
        }

        operationsSynced++
        succeededLocIds.push(loc.id)
      } catch (opErr: unknown) {
        const msg = opErr instanceof Error ? opErr.message : String(opErr)
        opErrors.push(`${loc.droptop_operation_id}: ${msg}`)
        console.error(`Droptop sync error for operation ${loc.droptop_operation_id}:`, msg)
      }
    })

    // 5. Batch upsert into inventory.product_usage
    let productsUpserted = 0
    const BATCH = 1000
    for (let i = 0; i < allUpsertRows.length; i += BATCH) {
      const batch = allUpsertRows.slice(i, i + BATCH)
      const { error: upsertErr } = await (admin as any)
        .schema('inventory').from('product_usage').upsert(batch)
      if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`)
      productsUpserted += batch.length
    }

    // 5a. Batch upsert the day-by-day ledger, when opted in — full replace
    // per (location, product, date) via the unique constraint, so re-running
    // the same day's job is idempotent rather than double-counting.
    let dailyActivityWritten = 0
    let dailyActivityWarning: string | null = null
    if (logDailyActivity && dailyActivityRows.size > 0) {
      const rows = [...dailyActivityRows.values()]
      try {
        for (let i = 0; i < rows.length; i += BATCH) {
          const slice = rows.slice(i, i + BATCH)
          const { error: dailyErr } = await (admin as any)
            .schema('inventory').from('daily_product_activity')
            .upsert(slice, { onConflict: 'company_id,location_id,product_id,activity_date' })
          if (dailyErr) throw new Error(dailyErr.message)
          dailyActivityWritten += slice.length
        }
      } catch (dailyErr: unknown) {
        // Best-effort — product_usage already succeeded, so the sync itself
        // still reports success; this just didn't also reach the ledger.
        dailyActivityWarning = dailyErr instanceof Error ? dailyErr.message : String(dailyErr)
        console.error('[DAILY-ACTIVITY] daily_product_activity upsert failed:', dailyActivityWarning)
      }
    }

    // 5b. Turn today's single-day pull into a real rolling average. When
    // daysBack < 30 (the routine daily job runs with daysBack:1 to keep the
    // Droptop API load light — see runDroptopChunked in
    // data-connection-dispatcher/index.ts), the daily_usage written in step
    // 5 above is just this call's own short window's total ÷ daysBack — for
    // a 1-day pull that's literally "today's raw sale total", not a rate,
    // and it overwrites whatever more-representative value was there before.
    // Recompute it here from the accumulated day-by-day ledger
    // (inventory.daily_product_activity, written in step 5a) instead: sum
    // sold_qty over the trailing 30 days and divide by however many of
    // those days the ledger actually has data for (min 1, so a
    // brand-new product doesn't divide by 30 on day one). Needs
    // logDailyActivity so the ledger this reads is actually being kept
    // current — without it there's no history to average over, so the
    // step-5 value (a plain window average, already correct for daysBack
    // >= 30) is left alone.
    let rollingUsageApplied = 0
    if (mode !== 'inventory' && logDailyActivity && daysBack < 30 && allUpsertRows.length > 0) {
      const windowStart = new Date(endUnix * 1000)
      windowStart.setUTCDate(windowStart.getUTCDate() - 29)
      const rollingStartDate = windowStart.toISOString().slice(0, 10)
      const todayDate = new Date(endUnix * 1000).toISOString().slice(0, 10)

      // The ledger can easily hold more than PostgREST's 1000-row default
      // cap once locations/products/30 days multiply out, so page through
      // it explicitly rather than trusting an un-ranged select.
      const ledgerRows: { location_id: string; product_id: string; activity_date: string; sold_qty: number | null }[] = []
      {
        // Raised to 5000 (2026-09-03, project Max Rows now 10,000) with the
        // same genuinely-EMPTY-page exit condition fix as the existing-
        // product_usage loop above.
        const PAGE = 5000
        let from = 0
        for (;;) {
          const { data: page, error: ledgerErr } = await (admin as any)
            .schema('inventory').from('daily_product_activity')
            .select('location_id, product_id, activity_date, sold_qty')
            .eq('company_id', companyId)
            .in('location_id', succeededLocIds)
            .gte('activity_date', rollingStartDate)
            .range(from, from + PAGE - 1)
          if (ledgerErr) { console.error('[USAGE-ROLLING] ledger read failed:', ledgerErr.message); break }
          const batch = page ?? []
          ledgerRows.push(...batch)
          if (batch.length === 0) break
          from += PAGE
        }
      }

      if (ledgerRows.length) {
        const agg = new Map<string, { sum: number; minDate: string }>() // key: location_id|lowercased product_id
        for (const r of ledgerRows) {
          const key = `${r.location_id}|${String(r.product_id).toLowerCase()}`
          const sold = Number(r.sold_qty) || 0
          const entry = agg.get(key)
          if (!entry) agg.set(key, { sum: sold, minDate: r.activity_date })
          else {
            entry.sum += sold
            if (r.activity_date < entry.minDate) entry.minDate = r.activity_date
          }
        }
        const msPerDay = 86_400_000
        for (const row of allUpsertRows) {
          const key = `${row.location_id}|${String(row.product_id).toLowerCase()}`
          const entry = agg.get(key)
          if (!entry) continue // no ledger history yet for this product — leave step 5's value as-is
          const daysTracked = Math.min(30, Math.max(1, Math.round((Date.parse(todayDate) - Date.parse(entry.minDate)) / msPerDay) + 1))
          const rollingUsage = entry.sum / daysTracked
          row.daily_usage = rollingUsage
          row.days_of_supply = rollingUsage > 0 && row.on_hands != null ? (row.on_hands as number) / rollingUsage : null
          rollingUsageApplied++
        }

        // Re-upsert with the corrected values — step 5's batch already ran
        // with the naive per-call figure.
        for (let i = 0; i < allUpsertRows.length; i += BATCH) {
          const batch = allUpsertRows.slice(i, i + BATCH)
          const { error: reupsertErr } = await (admin as any)
            .schema('inventory').from('product_usage').upsert(batch)
          if (reupsertErr) console.error('[USAGE-ROLLING] re-upsert with rolling average failed:', reupsertErr.message)
        }
      }
    }

    // 5c. Feed on-hands into Month End's count_products, under one dedicated
    // batch this sync owns per (company, period) — reused across calls
    // rather than one new batch per pull, so re-running "Pull Now" for the
    // same day/period replaces its own contribution instead of stacking a
    // fresh copy on top. On-hand is a snapshot, not a flow value like
    // sold/adjusted (which genuinely accumulate across distinct upload
    // batches) — summing two same-day pulls of the same snapshot would
    // double it, so this is scoped-delete-then-insert, not additive.
    let countProductsWarning: string | null = null
    console.log(`[MONTHEND-FEED] countProductsMonth=${countProductsMonth} succeededLocIds=${succeededLocIds.length} writeToCountProducts=${writeToCountProducts}`)
    if (countProductsMonth && succeededLocIds.length) {
      try {
        let batchId: string | null = null
        const { data: existingBatch } = await (admin as any)
          .schema('inventory').from('count_batches')
          .select('id')
          .eq('company_id', companyId)
          .eq('module', 'monthly')
          .eq('count_month', countProductsMonth)
          .eq('source_type', 'api')
          .eq('file_name', 'Droptop Daily Pull')
          .maybeSingle()
        if (existingBatch) {
          batchId = existingBatch.id
        } else {
          const { data: newBatch, error: batchErr } = await (admin as any)
            .schema('inventory').from('count_batches')
            .insert({ company_id: companyId, module: 'monthly', count_month: countProductsMonth, file_name: 'Droptop Daily Pull', source_type: 'api', row_count: 0 })
            .select('id').single()
          if (batchErr) throw new Error(`Batch create failed: ${batchErr.message}`)
          batchId = newBatch.id
        }

        await (admin as any).schema('inventory').from('count_products')
          .delete()
          .eq('company_id', companyId)
          .eq('upload_batch_id', batchId)
          .in('location_id', succeededLocIds)

        const countProductRows = allUpsertRows
          .filter((r: any) => r.on_hands != null && succeededLocIds.includes(r.location_id))
          .map((r: any) => ({
            company_id: companyId,
            upload_batch_id: batchId,
            location_id: r.location_id,
            product_id: r.product_id,
            category: r.category,
            on_hand: r.on_hands,
            count_month: countProductsMonth,
          }))

        const CP_BATCH = 1000
        for (let i = 0; i < countProductRows.length; i += CP_BATCH) {
          const slice = countProductRows.slice(i, i + CP_BATCH)
          const { error: cpErr } = await (admin as any).schema('inventory').from('count_products').insert(slice)
          if (cpErr) throw new Error(`count_products insert failed: ${cpErr.message}`)
        }
        ;(admin as any).schema('inventory').from('count_batches')
          .update({ row_count: countProductRows.length })
          .eq('id', batchId)
          .then(() => {})
        console.log(`[MONTHEND-FEED] wrote ${countProductRows.length} rows to batch ${batchId} (from ${allUpsertRows.length} total upsert rows)`)
      } catch (cpErr: unknown) {
        // Best-effort — product_usage already succeeded, so the sync itself
        // still reports success; this just didn't also reach Month End.
        countProductsWarning = cpErr instanceof Error ? cpErr.message : String(cpErr)
        console.error('[MONTHEND-FEED] count_products feed failed:', countProductsWarning)
      }
    }

    // 6. Log the sync (best-effort — table may not exist if migration pending)
    ;(admin as any)
      .schema('inventory').from('droptop_sync_log').insert({
        company_id: companyId,
        operations_count: operationsSynced,
        products_upserted: productsUpserted,
        status: opErrors.length > 0 ? 'partial' : 'success',
        error_message: opErrors.length > 0 ? opErrors.join(' | ') : null,
      })
      .then(() => {})

    // 6b. Same run, logged to the connection-agnostic history table the
    // Inventory Alerts "Data Connection Updates" section AND the Data
    // Connections config page both read from (best-effort — table may not
    // exist if migration pending). Named per-mode so the Data Connections
    // page's on-hand and usage schedules each get their own accurate last-run
    // status rather than sharing one generic "droptop" row.
    const dcConnectionKey = mode === 'inventory' ? 'droptop_on_hand' : mode === 'usage' ? 'droptop_usage' : 'droptop'
    ;(admin as any)
      .schema('inventory').from('data_connection_sync_log').insert({
        company_id: companyId,
        connection: dcConnectionKey,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        items_updated: productsUpserted - unchangedCount,
        items_unchanged: unchangedCount,
        status: opErrors.length > 0 ? 'partial' : 'success',
        error_message: [...opErrors, ...(dailyActivityWarning ? [`Daily activity log: ${dailyActivityWarning}`] : [])].join(' | ') || null,
      })
      .then(() => {})

    // If every location failed, surface the errors instead of returning 0/0 success.
    if (operationsSynced === 0 && opErrors.length > 0) {
      return ok({ error: opErrors.join(' | ') })
    }

    const warnings = [
      ...opErrors,
      ...(countProductsWarning ? [`Month End feed: ${countProductsWarning}`] : []),
      ...(dailyActivityWarning ? [`Daily activity log: ${dailyActivityWarning}`] : []),
    ]
    return ok({
      success: true,
      mode,
      operations_synced: operationsSynced,
      products_upserted: productsUpserted,
      ...(logDailyActivity ? { daily_activity_written: dailyActivityWritten } : {}),
      ...(rollingUsageApplied > 0 ? { rolling_usage_applied: rollingUsageApplied } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return ok({ error: msg })
  }
})
