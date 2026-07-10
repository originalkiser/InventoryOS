// Droptop usage + on-hands sync.
// Reads all core.locations with droptop_operation_id set, pulls sales change
// events and/or current inventory from Droptop, and upserts into
// inventory.product_usage. Can also scan adjustment activity against
// inventory.alert_thresholds and write inventory.inventory_alerts.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, daysBack?, locationId?, categories? }
//   mode       — 'both' (default) | 'inventory' (on-hands only, 1 call/location)
//                | 'usage' (sales changes only) | 'alerts' (adjustment scan)
//                Partial modes preserve the other side's existing values and
//                recompute days_of_supply from the merged pair.
//   daysBack   — usage/alerts window in days; default 30 (alerts: 1), max 365
//   locationId — sync a single location
//   categories — product_type filter terms (case-insensitive substring match,
//                e.g. ["engine oil", "additive"]); empty/absent = all products.
//                Droptop has no server-side category filter, so this is applied
//                after fetch, before writing to product_usage.

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

async function callDroptop(
  endpoint: string,
  params: Record<string, string>,
  publicKey: string,
  privateKey: string,
): Promise<any> {
  const [sig] = await buildSig(publicKey, 'GET', privateKey)
  const qs = new URLSearchParams({ sig, ...params })
  const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
  const res = await fetch(url, {
    headers: { 'x-api-key': publicKey.trim() },
    redirect: 'follow',
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
  return JSON.parse(text)
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
    const mode: 'both' | 'inventory' | 'usage' | 'alerts' =
      ['inventory', 'usage', 'alerts'].includes(body.mode) ? body.mode : 'both'
    const defaultDays = mode === 'alerts' ? 1 : 30
    const daysBack = Math.min(Math.max(Number(body.daysBack ?? defaultDays), 1), 365)
    const locationId: string | null = body.locationId ?? null
    const categories: string[] = Array.isArray(body.categories)
      ? body.categories.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean)
      : []
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
      const { data, error } = await q
      if (error) return ok({ error: `Locations query failed: ${error.message}` })
      locations = (data ?? []).filter((l: any) => l.droptop_operation_id)
    }

    if (!locations.length) {
      return ok({ error: 'No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.' })
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

      for (const loc of locations) {
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
      }

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
    // for partial modes, to carry over the side we aren't pulling.
    const { data: existingRows } = await (admin as any)
      .schema('inventory').from('product_usage')
      .select('id, location_id, product_id, category, daily_usage, on_hands')
      .eq('company_id', me.company_id)

    const existingMap = new Map<string, any>()
    for (const r of (existingRows ?? [])) {
      existingMap.set(`${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}`, r)
    }

    // 4. Sync each location
    const allUpsertRows: Record<string, unknown>[] = []
    let operationsSynced = 0
    const opErrors: string[] = []

    for (const loc of locations) {
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

        // Aggregate sales by product_id
        const salesByProduct = new Map<string, number>()
        for (const change of changes) {
          if (change.change_type !== 'sale') continue
          if (!matchesCategory(change.product_type)) continue
          const pid: string = change.product_id
          const qty = Math.abs(parseFloat(change.quantity_change || '0'))
          salesByProduct.set(pid, (salesByProduct.get(pid) ?? 0) + qty)
        }

        // Index inventory by product_id
        const invByProduct = new Map<string, { on_hands: number; product_type: string }>()
        for (const item of inventory) {
          if (!matchesCategory(item.product_type)) continue
          invByProduct.set(item.product_id, {
            on_hands: parseFloat(item.quantity_on_hand || '0'),
            product_type: item.product_type || '',
          })
        }

        // Products touched by the side(s) we pulled
        const productIds = new Set([...salesByProduct.keys(), ...invByProduct.keys()])

        for (const productId of productIds) {
          const dedupeKey = `${loc.id ?? ''}|${productId.toLowerCase()}`
          const existing = existingMap.get(dedupeKey)
          const invData = invByProduct.get(productId)

          // Pulled side wins; other side carries over from the existing row.
          const dailyUsage = mode !== 'inventory'
            ? (salesByProduct.has(productId) ? (salesByProduct.get(productId)! / daysBack) : null)
            : (existing?.daily_usage ?? null)
          const onHands = mode !== 'usage'
            ? (invData ? invData.on_hands : null)
            : (existing?.on_hands ?? null)
          const daysOfSupply =
            dailyUsage && dailyUsage > 0 && onHands != null ? onHands / dailyUsage : null

          allUpsertRows.push({
            ...(existing ? { id: existing.id } : {}),
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
      } catch (opErr: unknown) {
        const msg = opErr instanceof Error ? opErr.message : String(opErr)
        opErrors.push(`${loc.droptop_operation_id}: ${msg}`)
        console.error(`Droptop sync error for operation ${loc.droptop_operation_id}:`, msg)
      }
    }

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

    // If every location failed, surface the errors instead of returning 0/0 success.
    if (operationsSynced === 0 && opErrors.length > 0) {
      return ok({ error: opErrors.join(' | ') })
    }

    return ok({
      success: true,
      mode,
      operations_synced: operationsSynced,
      products_upserted: productsUpserted,
      ...(opErrors.length > 0 ? { warnings: opErrors } : {}),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return ok({ error: msg })
  }
})
