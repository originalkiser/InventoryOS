// Droptop Purchase Orders sync.
// Reads all core.locations with droptop_operation_id set, pulls purchase
// orders from Droptop's get-purchase-orders endpoint, and upserts into
// inventory.droptop_purchase_orders / droptop_purchase_order_items. Same
// conventions as droptop-sync-usage (dual auth, sig-signed requests,
// data_connection_sync_log entry) — see that function's own header comment
// for the full rationale; not re-explained here.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, daysBack?, locationId?, locationIds?, poStatus? }
//   mode        — 'sync' (default) | 'inspect' (read-only raw-shape peek,
//                 same purpose as droptop-sync-usage's inspect mode — never
//                 writes anything)
//   daysBack    — hard safety ceiling on how far back a location's own
//                 known-still-open POs will be chased (see recentDaysBack);
//                 default 180. Results come back newest-created-first, so
//                 once a page's oldest PO predates this, pagination stops
//                 outright rather than walking the vendor's entire history.
//   recentDaysBack — the everyday window for catching brand-new POs;
//                 default 14. Once past this point, a location only keeps
//                 paging as long as it still has POs from OUR OWN table
//                 that aren't yet terminal (see isTerminal()) — most
//                 locations stop right here. daysBack is the outer bound
//                 for the rare location still chasing a genuinely old
//                 back-order.
//   locationId  — sync a single location
//   locationIds — sync a specific batch of locations (client-side chunking,
//                 same as runDroptopSync in droptopService.ts). Ignored if
//                 locationId is also set. Neither set = every location with
//                 a droptop_operation_id.
//   poStatus    — forwarded to Droptop's own filter: draft | sent | accepted
//                 | closed | cancelled. Unset = all statuses.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── Droptop auth sig — identical to droptop-sync-usage's own copy ──────────
// sig = base64(base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey)))
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

// 502/503/504 are transient gateway/timeout errors from Droptop's own
// infrastructure, not a signal the request itself is invalid (unlike a
// 4xx) — droptop-sync-orders hit this for real (a busy shop's response
// apparently takes long enough that Droptop's own gateway times out
// before it finishes) and got retry-with-backoff for it; this function
// only ever retried 429, so a run of pure 502s (every operation_id in the
// same run failing identically, per the real report that surfaced this)
// took down the whole sync immediately instead of recovering the way the
// orders sync already does from the exact same upstream failure mode.
// 500 added 2026-09-16 to match droptop-sync-orders (which added it
// 2026-09-08 after a real production run showed two locations failing
// outright on "Droptop 500: {"message": "Internal server error"}" with zero
// retry) — this function was written without picking up that fix, and a
// generic internal-server-error is exactly as likely to be a one-off blip
// on Droptop's end as a 502/503/504 is.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

// Deno/Supabase's own outbound-fetch platform limiter can reject a fetch()
// call outright (thrown, not returned as a Response) with a message like
// "Rate limit exceeded for trace <id>. Retry after 51786ms." — found for
// real in droptop-sync-orders (same callDroptop shape, see that file's own
// comment) and ported here for the identical exposure: fetch() had no
// try/catch, so this skipped the RETRYABLE_STATUSES handling below
// entirely and killed the whole run outright, with nothing logged
// anywhere to confirm it (this file never called console.* at all before
// this fix). Extract the platform's own requested wait so we honor it
// precisely instead of guessing with exponential backoff.
const PLATFORM_RETRY_AFTER_MS_RE = /retry after (\d+)\s*ms/i

async function callDroptop(
  endpoint: string, params: Record<string, string>, publicKey: string, privateKey: string, maxRetries = 5,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const sig = await buildSig(publicKey, 'GET', privateKey)
    const qs = new URLSearchParams({ sig, ...params })
    const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`

    let res: Response
    try {
      res = await fetch(url, { headers: { 'x-api-key': publicKey.trim() }, redirect: 'follow' })
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      if (attempt < maxRetries) {
        const platformWaitMatch = message.match(PLATFORM_RETRY_AFTER_MS_RE)
        const waitMs = platformWaitMatch ? Number(platformWaitMatch[1]) : 2000 * 2 ** attempt
        console.warn(`[droptop-sync-purchase-orders] ${endpoint} fetch threw (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${message}`)
        await sleep(waitMs)
        continue
      }
      console.error(`[droptop-sync-purchase-orders] ${endpoint} fetch threw, retries exhausted: ${message}`)
      throw fetchErr
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2000 * 2 ** attempt
      const body = await res.text().catch(() => '')
      console.warn(`[droptop-sync-purchase-orders] ${endpoint} returned ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${body}`)
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      console.error(`[droptop-sync-purchase-orders] ${endpoint} failed with ${res.status}, retries exhausted or non-retryable: ${text}`)
      throw new Error(`Droptop ${res.status}: ${text}`)
    }
    return JSON.parse(text)
  }
}

// Droptop's get-purchase-orders has no "updated since" filter at all — only
// pagination sorted newest-created-first plus a poStatus filter. That's the
// entire reason this used to always walk back a fixed `daysBack` (180) for
// EVERY location on EVERY run: a PO's status/delivery info can keep
// changing long after it was created (confirmed live 2026-09-21: 262 real
// rows are po_status='closed' with delivery_status='back_ordered' — closed
// on the ordering side, still not physically received), so the only way to
// catch a status change on an old PO was to keep re-fetching a wide window
// of everything, whether it had actually changed or not.
//
// isTerminal()/recentCutoffUnix+stillOpenPoIds below make this adaptive
// instead of a blind fixed window. Terminal = po_status is 'closed' or
// 'cancelled' — an explicit product decision (2026-09-21): po_status is the
// shop's own "nothing more to do here" signal, independent of whatever
// delivery_status happens to say. Deliberately NOT keyed on
// delivery_status='fully_received' — real production data shows 4,436 rows
// that are po_status='closed' with a non-final delivery_status (2,278
// partially_received, 1,896 null, 262 back_ordered): once a shop closes a
// PO, Droptop apparently doesn't keep delivery_status current for it
// either, so a stale/incomplete delivery_status on an already-closed PO
// isn't a real still-open order needing action, it's just Droptop not
// bothering to update a field nobody's tracking anymore. A null/unknown
// po_status is NOT treated as terminal — stays tracked until it actually
// reaches closed or cancelled.
function isTerminal(poStatus: string | null | undefined): boolean {
  return poStatus === 'closed' || poStatus === 'cancelled'
}

// Paginates one operation's POs (newest-created-first) and stops once BOTH:
// (a) we're past recentCutoffUnix (catches everything genuinely new), AND
// (b) every po_id in stillOpenPoIds (this location's own already-known,
// not-yet-terminal POs, from OUR OWN table — Droptop can't be asked for
// them directly) has actually been observed in this run.
// hardFloorUnix is the original daysBack-derived absolute ceiling, kept as
// a safety net — if a known-still-open PO somehow never turns up even at
// that depth, pagination stops anyway rather than walking Droptop's entire
// history, and that PO's stored status just stays whatever it was last
// synced as until a future run finds it.
async function fetchPurchaseOrders(
  operationId: string, recentCutoffUnix: number, hardFloorUnix: number, stillOpenPoIds: Set<string>,
  poStatus: string | undefined, pub: string, priv: string,
): Promise<any[]> {
  const all: any[] = []
  const remaining = new Set(stillOpenPoIds)
  let cursor: string | null = null
  while (true) {
    const params: Record<string, string> = { operation_ids: operationId, limit: '250' }
    if (cursor) params.startingAfter = cursor
    if (poStatus) params.poStatus = poStatus
    const res = await callDroptop('get-purchase-orders', params, pub, priv)
    // Defensive unwrap: get-inventory-changes' real response nests an extra
    // level below what its own docs show (see fetchChanges in
    // droptop-sync-usage — needed the same `res?.data ?? res` fallback), so
    // don't assume get-purchase-orders' documented top-level shape
    // (more_available/next_cursor/data) is exactly what comes back either.
    const inner = res?.data && !Array.isArray(res.data) && 'data' in res.data ? res.data : res
    const pos: any[] = Array.isArray(inner?.data) ? inner.data : []
    let stop = false
    for (const po of pos) {
      const created = Number(po.created_timestamp)
      if (created < hardFloorUnix) { stop = true; break }
      all.push(po)
      remaining.delete(String(po.po_id))
      if (created < recentCutoffUnix && remaining.size === 0) { stop = true; break }
    }
    if (stop || !inner?.more_available || !inner?.next_cursor) break
    cursor = inner.next_cursor
  }
  return all
}

function tsToIso(unix: unknown): string | null {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

// data-connection-dispatcher now runs several location-chunks of THIS
// function concurrently (runChunksConcurrently, added 2026-09-09) instead
// of strictly one at a time — confirmed live the same day: concurrent
// chunks' item delete/insert batches against inventory
// .droptop_purchase_order_items started hitting real Postgres deadlocks
// ("deadlock detected", SQLSTATE 40P01), something that couldn't happen
// back when only one chunk's writes were ever in flight at once. A
// deadlock is Postgres deliberately rolling back ONE of two conflicting
// transactions — by the time this retries, the other one has already
// committed and released its locks, so blindly retrying is safe and
// expected, same shape as droptop-sync-orders' own insertWithRetry.
async function withRetry<T>(
  fn: () => Promise<{ data: T; error: { message: string } | null }>,
): Promise<{ data: T | null; error: string | null }> {
  let lastErr: string | null = null
  for (let attempt = 0; attempt <= 2; attempt++) {
    const { data, error } = await fn()
    if (!error) return { data, error: null }
    lastErr = error.message
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
  }
  return { data: null, error: lastErr }
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

    // Same dual-auth shape as droptop-sync-usage: shared secret (dispatcher/
    // pg_cron, no user session) or a real logged-in user (Data Connections'
    // "Run Now" button, or the new PO Status page's manual refresh).
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
    const mode: 'sync' | 'inspect' = body.mode === 'inspect' ? 'inspect' : 'sync'
    // daysBack is now the hard SAFETY CEILING (see fetchPurchaseOrders'
    // own comment), not "always pull this much" — recentDaysBack is the
    // actual everyday window; a location only pages further back than that
    // when it genuinely still has known-open POs to find.
    const daysBack = Math.min(730, Math.max(1, Number(body.daysBack) || 180))
    const hardFloorUnix = Math.floor(Date.now() / 1000) - daysBack * 86400
    const recentDaysBack = Math.min(daysBack, Math.max(1, Number(body.recentDaysBack) || 14))
    const recentCutoffUnix = Math.floor(Date.now() / 1000) - recentDaysBack * 86400
    const poStatus: string | undefined = typeof body.poStatus === 'string' ? body.poStatus : undefined
    const locationId: string | undefined = body.locationId
    const locationIds: string[] = Array.isArray(body.locationIds) ? body.locationIds : []

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
      // Raw, un-parsed response first — so if fetchPurchaseOrders' shape
      // assumption is still wrong, this shows the real thing to fix it
      // against instead of another guess.
      const rawParams: Record<string, string> = { operation_ids: opId, limit: '5' }
      if (poStatus) rawParams.poStatus = poStatus
      const raw = await callDroptop('get-purchase-orders', rawParams, publicKey, privateKey)
      // Diagnostic peek only — no need for the still-open tracking below,
      // a plain single-cutoff pass matches this mode's original purpose.
      const pos = await fetchPurchaseOrders(opId, hardFloorUnix, hardFloorUnix, new Set(), poStatus, publicKey, privateKey)
      return ok({ success: true, operation_id: opId, raw_response: raw, parsed_sample: pos.slice(0, 3) })
    }

    let posUpserted = 0
    let itemsWritten = 0
    const opToLocation = new Map<string, string>(locations.map((l: any) => [l.droptop_operation_id, l.id]))
    const warnings: string[] = []

    // Already-known, not-yet-terminal POs for exactly the locations in this
    // run — one combined query rather than one per location. See
    // isTerminal()/fetchPurchaseOrders' own comments for why this is what
    // lets most locations stop after just recentDaysBack instead of always
    // walking the full daysBack ceiling.
    const targetLocationIds = locations.map((l: any) => opToLocation.get(l.droptop_operation_id)).filter(Boolean) as string[]
    const { data: knownRows, error: knownErr } = await (admin as any)
      .schema('inventory').from('droptop_purchase_orders')
      .select('location_id, po_id, po_status')
      .eq('company_id', companyId).in('location_id', targetLocationIds)
    if (knownErr) return ok({ error: `Existing PO lookup failed: ${knownErr.message}` })
    const stillOpenByLocation = new Map<string, Set<string>>()
    for (const row of (knownRows ?? []) as { location_id: string | null; po_id: string; po_status: string | null }[]) {
      if (!row.location_id || isTerminal(row.po_status)) continue
      const set = stillOpenByLocation.get(row.location_id) ?? new Set<string>()
      set.add(row.po_id)
      stillOpenByLocation.set(row.location_id, set)
    }

    // Fetch phase — sequential per location (has to be: each is its own
    // Droptop API call), low concurrency isn't needed here the way it is
    // for the usage sync since get-purchase-orders is one call per page,
    // not one call per product.
    // Droptop's po_id ("PO178", "PO179", ...) is scoped PER OPERATION
    // (per shop), not company-wide — confirmed live 2026-09-16 (two
    // different shops each independently have their own PO178/179/180).
    // Keyed by (location_id, po_id), not bare po_id — an earlier version
    // keyed this Map by po_id alone (comment used to claim "the same PO
    // visible under more than one operation_id", which was the wrong
    // read of the same evidence) and paired it with a company-wide
    // UNIQUE(company_id, po_id) DB constraint; together those silently
    // collapsed every shop's Nth PO into whichever shop's sync happened to
    // run last for that number, which is the actual reason only a small,
    // arbitrary set of shops ever ended up with any PO data at all. See
    // migration 20260930w_droptop_po_unique_per_location.sql.
    const poKey = (locationId: string | null, poId: string) => `${locationId ?? ''}|${poId}`
    const posByPoId = new Map<string, { po: any; locationId: string | null }>()
    for (const loc of locations) {
      try {
        const locationId = opToLocation.get(loc.droptop_operation_id) ?? null
        const stillOpen = (locationId && stillOpenByLocation.get(locationId)) || new Set<string>()
        const pos = await fetchPurchaseOrders(
          loc.droptop_operation_id, recentCutoffUnix, hardFloorUnix, stillOpen, poStatus, publicKey, privateKey,
        )
        for (const po of pos) posByPoId.set(poKey(locationId, po.po_id), { po, locationId })
      } catch (e) {
        warnings.push(`location ${loc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const allPos = [...posByPoId.values()]

    // Write phase — batched, not one upsert/delete/insert per PO. At real
    // volume (a shop can carry a couple hundred POs) that per-PO loop was
    // easily 100,000+ sequential database round-trips company-wide, slow
    // enough to risk hitting the execution time limit even after chunking
    // by location. Same "batch of BATCH, insert/upsert once" shape as
    // ov2_order_draft_lines/history_lines use elsewhere in this app.
    const BATCH = 500
    const nowIso = new Date().toISOString()
    const headers = allPos.map(({ po, locationId }) => ({
      company_id: companyId,
      location_id: locationId,
      po_id: po.po_id,
      custom_po_id: po.custom_po_id ?? null,
      supplier_id: po.supplier_id ?? null,
      supplier_name: po.supplier?.name ?? null,
      po_status: po.po_status ?? null,
      approved_status: po.approved_status ?? null,
      delivery_status: po.delivery_status ?? null,
      pay_status: po.pay_status ?? null,
      total_cost: po.total_cost != null ? Number(po.total_cost) : null,
      note: po.note ?? null,
      ship_to_name: po.ship_to?.name ?? null,
      last_updated_user_name: po.last_updated_user_name ?? null,
      created_timestamp: tsToIso(po.created_timestamp),
      closed_timestamp: tsToIso(po.closed_timestamp),
      last_updated_timestamp: tsToIso(po.last_updated_timestamp),
      to_receive_timestamp: tsToIso(po.to_receive_timestamp),
      delivery_status_updated_timestamp: tsToIso(po.delivery_status_updated_timestamp),
      raw_data: po,
      synced_at: nowIso,
    }))

    // (location_id, po_id) -> saved row id, filled in as each upsert batch
    // returns — same composite key as posByPoId above, so a bare-po_id
    // collision between two shops can't cross-contaminate items either.
    const idByPoId = new Map<string, string>()
    for (let i = 0; i < headers.length; i += BATCH) {
      const slice = headers.slice(i, i + BATCH)
      const { data: saved, error: upsertErr } = await withRetry(() =>
        (admin as any).schema('inventory').from('droptop_purchase_orders')
          .upsert(slice, { onConflict: 'company_id,location_id,po_id' })
          .select('id, po_id, location_id'),
      )
      if (upsertErr) { warnings.push(`PO batch ${i}-${i + slice.length}: ${upsertErr}`); continue }
      for (const row of (saved ?? []) as { id: string; po_id: string; location_id: string | null }[]) idByPoId.set(poKey(row.location_id, row.po_id), row.id)
      posUpserted += saved?.length ?? 0
    }

    const savedPoIds = [...idByPoId.values()]
    if (savedPoIds.length) {
      // Replace items wholesale for every synced PO — one bulk delete
      // instead of one per PO — then bulk-insert everything fresh.
      for (let i = 0; i < savedPoIds.length; i += BATCH) {
        const { error: delErr } = await withRetry(() =>
          (admin as any).schema('inventory').from('droptop_purchase_order_items')
            .delete().in('purchase_order_id', savedPoIds.slice(i, i + BATCH)),
        )
        if (delErr) warnings.push(`Item delete batch ${i}: ${delErr}`)
      }

      const allItems = allPos.flatMap(({ po, locationId }) => {
        const purchaseOrderId = idByPoId.get(poKey(locationId, po.po_id))
        if (!purchaseOrderId) return []
        return (po.items ?? []).map((it: any) => ({
          purchase_order_id: purchaseOrderId,
          company_id: companyId,
          purchase_order_item_id: it.purchase_order_item_id ?? null,
          purchase_order_item_type: it.purchase_order_item_type ?? null,
          inventory_id: it.inventory_id ?? null,
          product_id: it.product_id ?? null,
          name: it.name ?? null,
          quantity: it.quantity != null ? Number(it.quantity) : null,
          unit_cost: it.unit_cost != null ? Number(it.unit_cost) : null,
          received_quantity: it.received_quantity != null ? Number(it.received_quantity) : null,
          back_ordered_quantity: it.back_ordered_quantity != null ? Number(it.back_ordered_quantity) : null,
          remaining_quantity: it.remaining_quantity != null ? Number(it.remaining_quantity) : null,
          total_cost: it.total_cost != null ? Number(it.total_cost) : null,
          purchase_uom: it.purchase_uom ?? null,
          sell_uom: it.sell_uom ?? null,
        }))
      })
      for (let i = 0; i < allItems.length; i += BATCH) {
        const slice = allItems.slice(i, i + BATCH)
        const { error: itemsErr } = await withRetry(() =>
          (admin as any).schema('inventory').from('droptop_purchase_order_items').insert(slice),
        )
        if (itemsErr) warnings.push(`Item insert batch ${i}: ${itemsErr}`)
        else itemsWritten += slice.length
      }
    }

    const status = warnings.length ? (posUpserted > 0 ? 'partial' : 'error') : 'success'
    await (admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId,
      connection: 'droptop_purchase_orders',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      items_updated: posUpserted,
      items_unchanged: 0,
      items_inserted: itemsWritten,
      status,
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({ success: status !== 'error', locations_synced: locations.length, pos_upserted: posUpserted, items_written: itemsWritten, warnings })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
