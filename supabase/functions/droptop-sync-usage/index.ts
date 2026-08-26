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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    // 1. Verify caller
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
    if (!me?.company_id) return ok({ error: 'Profile not found' })

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
    const matchesCategory = (productType: string | null | undefined): boolean => {
      if (!categories.length) return true
      const pt = (productType ?? '').toLowerCase()
      return categories.some((c) => pt.includes(c))
    }
    const endUnix = Math.floor(Date.now() / 1000)
    const startUnix = endUnix - daysBack * 86400

    // 2. Load locations with droptop_operation_id mapped
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let locations: any[]
    {
      let q = (admin as any)
        .schema('core').from('locations')
        .select('id, droptop_operation_id')
        .eq('company_id', me.company_id)
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
      return ok({
        success: true,
        operation_id: opId,
        inventory_sample: inventory.slice(0, 3),
        changes_sample: changes.slice(0, 5),
      })
    }

    // ── Alerts mode: scan adjustment activity against thresholds ────────────
    if (mode === 'alerts') {
      const { data: rules, error: rulesErr } = await (admin as any)
        .schema('inventory').from('alert_thresholds')
        .select('id, product_id, category, max_adjustment')
        .eq('company_id', me.company_id)
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
              company_id: me.company_id,
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
      const PAGE = 1000
      let from = 0
      for (;;) {
        const { data: rows, error } = await (admin as any)
          .schema('inventory').from('product_usage')
          .select('id, location_id, product_id, category, daily_usage, on_hands')
          .eq('company_id', me.company_id)
          .in('location_id', chunkLocationIds)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`Failed to load existing product_usage: ${error.message}`)
        const batch = (rows ?? []) as any[]
        for (const r of batch) {
          existingMap.set(`${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}`, r)
        }
        if (batch.length < PAGE) break
        from += PAGE
      }
    }

    // 4. Sync each location
    const allUpsertRows: Record<string, unknown>[] = []
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
            company_id: me.company_id,
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

    // 5b. Feed on-hands into Month End's count_products, under one dedicated
    // batch this sync owns per (company, period) — reused across calls
    // rather than one new batch per pull, so re-running "Pull Now" for the
    // same day/period replaces its own contribution instead of stacking a
    // fresh copy on top. On-hand is a snapshot, not a flow value like
    // sold/adjusted (which genuinely accumulate across distinct upload
    // batches) — summing two same-day pulls of the same snapshot would
    // double it, so this is scoped-delete-then-insert, not additive.
    let countProductsWarning: string | null = null
    if (countProductsMonth && succeededLocIds.length) {
      try {
        let batchId: string | null = null
        const { data: existingBatch } = await (admin as any)
          .schema('inventory').from('count_batches')
          .select('id')
          .eq('company_id', me.company_id)
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
            .insert({ company_id: me.company_id, module: 'monthly', count_month: countProductsMonth, file_name: 'Droptop Daily Pull', source_type: 'api', row_count: 0 })
            .select('id').single()
          if (batchErr) throw new Error(`Batch create failed: ${batchErr.message}`)
          batchId = newBatch.id
        }

        await (admin as any).schema('inventory').from('count_products')
          .delete()
          .eq('company_id', me.company_id)
          .eq('upload_batch_id', batchId)
          .in('location_id', succeededLocIds)

        const countProductRows = allUpsertRows
          .filter((r: any) => r.on_hands != null && succeededLocIds.includes(r.location_id))
          .map((r: any) => ({
            company_id: me.company_id,
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
      } catch (cpErr: unknown) {
        // Best-effort — product_usage already succeeded, so the sync itself
        // still reports success; this just didn't also reach Month End.
        countProductsWarning = cpErr instanceof Error ? cpErr.message : String(cpErr)
        console.error('count_products feed failed:', countProductsWarning)
      }
    }

    // 6. Log the sync (best-effort — table may not exist if migration pending)
    ;(admin as any)
      .schema('inventory').from('droptop_sync_log').insert({
        company_id: me.company_id,
        operations_count: operationsSynced,
        products_upserted: productsUpserted,
        status: opErrors.length > 0 ? 'partial' : 'success',
        error_message: opErrors.length > 0 ? opErrors.join(' | ') : null,
      })
      .then(() => {})

    // 6b. Same run, logged to the connection-agnostic history table the
    // Inventory Alerts "Data Connection Updates" section reads from
    // (best-effort — table may not exist if migration pending).
    ;(admin as any)
      .schema('inventory').from('data_connection_sync_log').insert({
        company_id: me.company_id,
        connection: 'droptop',
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        items_updated: productsUpserted - unchangedCount,
        items_unchanged: unchangedCount,
        status: opErrors.length > 0 ? 'partial' : 'success',
        error_message: opErrors.length > 0 ? opErrors.join(' | ') : null,
      })
      .then(() => {})

    // If every location failed, surface the errors instead of returning 0/0 success.
    if (operationsSynced === 0 && opErrors.length > 0) {
      return ok({ error: opErrors.join(' | ') })
    }

    const warnings = [...opErrors, ...(countProductsWarning ? [`Month End feed: ${countProductsWarning}`] : [])]
    return ok({
      success: true,
      mode,
      operations_synced: operationsSynced,
      products_upserted: productsUpserted,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return ok({ error: msg })
  }
})
