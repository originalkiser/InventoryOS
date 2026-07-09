// Droptop usage + on-hands sync.
// Reads all core.locations with droptop_operation_id set, pulls sales change
// events and current inventory from Droptop, and upserts into
// inventory.product_usage.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { daysBack? }   — default 30, max 365

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
// sig = base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey))
// ECB implemented via AES-CBC with a zeroed IV applied per 16-byte block.

function parseKey(key: string): Uint8Array {
  const k = key.trim()
  // 64-char hex → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(k.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  // 44-char base64 → 32 bytes
  if (/^[A-Za-z0-9+/]{43}=?$/.test(k)) {
    const raw = atob(k)
    const bytes = new Uint8Array(32)
    for (let i = 0; i < Math.min(raw.length, 32); i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  }
  // Raw UTF-8 string → padded/truncated to 32 bytes
  const raw = new TextEncoder().encode(k)
  const bytes = new Uint8Array(32)
  bytes.set(raw.slice(0, 32))
  return bytes
}

async function buildSig(publicKey: string, method: string, privateKey: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey.trim()}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = new TextEncoder().encode(message)

  // PKCS7 pad to 16-byte boundary
  const padLen = 16 - (msgBytes.length % 16)
  const padded = new Uint8Array(msgBytes.length + padLen)
  padded.set(msgBytes)
  padded.fill(padLen, msgBytes.length)

  // Import key for AES-CBC (used to emulate ECB per-block)
  const cryptoKey = await crypto.subtle.importKey(
    'raw', parseKey(privateKey), { name: 'AES-CBC' }, false, ['encrypt'],
  )

  // Encrypt each 16-byte block independently (zero IV = ECB for each block)
  const zeroIV = new Uint8Array(16)
  const encrypted = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    // CBC with zero IV on one block; output is 32 bytes (block + PKCS7 tail — discard tail)
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, padded.slice(i, i + 16))
    encrypted.set(new Uint8Array(enc).slice(0, 16), i)
  }

  return btoa(String.fromCharCode(...encrypted))
}

async function callDroptop(
  endpoint: string,
  params: Record<string, string>,
  publicKey: string,
  privateKey: string,
): Promise<any> {
  const sig = await buildSig(publicKey, 'GET', privateKey)
  const qs = new URLSearchParams({ sig, ...params })
  const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
  const res = await fetch(url, {
    headers: { 'x-api-key': publicKey, 'Content-Type': 'application/json' },
    redirect: 'follow',
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
  return JSON.parse(text)
}

// ── Droptop data fetchers ────────────────────────────────────────────────────

// Returns all sale-type change events in [startUnix, endUnix], paginated.
async function fetchSalesChanges(
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

    all.push(...changes.filter((c: any) => c.change_type === 'sale'))

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
    const daysBack = Math.min(Math.max(Number(body.daysBack ?? 30), 1), 365)
    const endUnix = Math.floor(Date.now() / 1000)
    const startUnix = endUnix - daysBack * 86400

    // 2. Load locations with droptop_operation_id mapped
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let locations: any[]
    {
      // Use admin (service_role) to bypass RLS — RLS helper get_my_company_id()
      // queries the old profiles table, not platform.user_profiles, so caller JWT
      // would return 0 rows. Requires 20260708b_edge_function_schema_grants.sql applied.
      const { data, error } = await (admin as any)
        .schema('core').from('locations')
        .select('id, droptop_operation_id')
        .eq('company_id', me.company_id)
        .not('droptop_operation_id', 'is', null)
      if (error) return ok({ error: `Locations query failed: ${error.message}` })
      locations = (data ?? []).filter((l: any) => l.droptop_operation_id)
    }

    if (!locations.length) {
      return ok({ error: 'No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.' })
    }

    // 3. Load existing product_usage rows to dedup (match by location_id + product_id)
    const { data: existingRows } = await (admin as any)
      .schema('inventory').from('product_usage')
      .select('id, location_id, product_id')
      .eq('company_id', me.company_id)

    const existingMap = new Map<string, string>()
    for (const r of (existingRows ?? [])) {
      existingMap.set(`${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}`, r.id)
    }

    // 4. Sync each location
    const allUpsertRows: Record<string, unknown>[] = []
    let operationsSynced = 0
    const opErrors: string[] = []

    for (const loc of locations) {
      try {
        const opId: string = loc.droptop_operation_id

        // Pull sales changes (paginated) + current inventory in parallel
        const [sales, inventory] = await Promise.all([
          fetchSalesChanges(opId, startUnix, endUnix, publicKey, privateKey),
          fetchInventory(opId, publicKey, privateKey),
        ])

        // Aggregate sales by product_id
        const salesByProduct = new Map<string, number>()
        for (const change of sales) {
          const pid: string = change.product_id
          const qty = Math.abs(parseFloat(change.quantity_change || '0'))
          salesByProduct.set(pid, (salesByProduct.get(pid) ?? 0) + qty)
        }

        // Index inventory by product_id
        const invByProduct = new Map<string, { on_hands: number; product_type: string }>()
        for (const item of inventory) {
          invByProduct.set(item.product_id, {
            on_hands: parseFloat(item.quantity_on_hand || '0'),
            product_type: item.product_type || '',
          })
        }

        // Union of product IDs seen in either dataset
        const productIds = new Set([...salesByProduct.keys(), ...invByProduct.keys()])

        for (const productId of productIds) {
          const totalSold = salesByProduct.get(productId) ?? null
          const invData = invByProduct.get(productId)
          const dailyUsage = totalSold != null ? totalSold / daysBack : null
          const onHands = invData ? invData.on_hands : null
          const daysOfSupply =
            dailyUsage && dailyUsage > 0 && onHands != null ? onHands / dailyUsage : null

          const dedupeKey = `${loc.id ?? ''}|${productId.toLowerCase()}`
          const existingId = existingMap.get(dedupeKey)

          allUpsertRows.push({
            ...(existingId ? { id: existingId } : {}),
            company_id: me.company_id,
            location_id: loc.id,
            product_id: productId,
            category: invData?.product_type || null,
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
      operations_synced: operationsSynced,
      products_upserted: productsUpserted,
      ...(opErrors.length > 0 ? { warnings: opErrors } : {}),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return ok({ error: msg })
  }
})
