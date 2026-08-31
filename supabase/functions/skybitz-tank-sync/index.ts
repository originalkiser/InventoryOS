// SkyBitz tank telemetry sync. Downloads the single combined CSV over SFTP
// and updates on-hand/level/battery/inventory-time for tank_monitors rows
// matched by RTUID (serial_rtu_id). Never touches location_id, product_id,
// or keep_fill on a row that already exists — those stay under Strickland's
// own manual upload process; this only refreshes numeric readings for tanks
// already onboarded that way. An RTUID in the file with no matching existing
// row gets a brand-new tank_monitors row instead (location_id/product_id
// left null, source_location/product carried over raw from the file) so a
// newly-installed monitor shows up for someone to match by hand later —
// same "keep unmatched rows, match later" convention as the manual CSV
// import in TankMonitorTab.tsx.
//
// The file's Location/Customer/Tank text columns are SkyBitz's own internal
// labels ("STB Reladyne Jacksonville - Receiving", "LOST MONITOR - STORE
// 122") and don't reliably map to real shop names, which is why an existing
// row is matched RTUID-only rather than by resolving a location from the file.
//
// Callable two ways:
//  - Interactively, from the Tank Monitor config page's "Pull from SkyBitz"
//    button — supabase.functions.invoke() attaches the logged-in user's
//    session automatically, verified the same way droptop-sync-usage does.
//  - Unattended, via pg_cron -> net.http_post (no user session available) —
//    authorized instead by an X-Sync-Token header matching the
//    SKYBITZ_SYNC_SECRET secret.
// Either is accepted; requests with neither are rejected.
//
// Requires Supabase secrets: SKYBITZ_SFTP_URL, SKYBITZ_SFTP_USERNAME,
// SKYBITZ_SFTP_PASSWORD, SKYBITZ_SYNC_SECRET (any random value — send it
// back as X-Sync-Token from the pg_cron job).
//
// POST body: { path? } — path overrides the file to fetch; defaults to
// /StricklandBrothers.CSV, the file found by skybitz-sftp-test.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import SftpClient from 'npm:ssh2-sftp-client@12'

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

interface ParsedTarget { host: string; port: number; path: string }

function parseTarget(raw: string): ParsedTarget {
  let s = raw.trim()
  s = s.replace(/^sftp:\/\//i, '')
  const slash = s.indexOf('/')
  const hostPort = slash === -1 ? s : s.slice(0, slash)
  const path = slash === -1 ? '/' : s.slice(slash) || '/'
  const [host, portStr] = hostPort.split(':')
  const port = portStr ? parseInt(portStr, 10) : 22
  return { host, port: isNaN(port) ? 22 : port, path }
}

// Minimal CSV line splitter with quoted-field support (the sample file has
// no quoted commas, but Address/Customer are free text and could gain one).
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = false
      } else cur += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
  }
  out.push(cur)
  return out
}

// "MM/DD/YYYY hh:mm:ss AM/PM" -> ISO string. Returns null for unparseable
// text and for SkyBitz's "never reported" placeholder (01/01/1900).
function parseSkybitzTime(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  const [, moS, dS, yS, hS, minS, secS, ap] = m
  let h = parseInt(hS, 10) % 12
  if (ap.toUpperCase() === 'PM') h += 12
  const year = parseInt(yS, 10)
  if (year < 2000) return null
  const d = new Date(Date.UTC(year, parseInt(moS, 10) - 1, parseInt(dS, 10), h, parseInt(minS, 10), parseInt(secS, 10)))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function numOrNull(s: string | undefined): number | null {
  const t = (s ?? '').trim()
  if (t === '') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

interface ExistingTank {
  id: string
  company_id: string
  location_id: string | null
  product_id: string | null
  keep_fill: boolean | null
  on_hand: number | null
  available_capacity: number | null
  raw_capacity: number | null
  level_inches: number | null
  battery_pct: number | null
  system_tank_id: string | null
  inventory_time: string | null
  reading_date: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Accept either the pg_cron shared secret, or a real logged-in user
    // (for the Tank Monitor config page's "Pull from SkyBitz" button).
    const syncSecret = Deno.env.get('SKYBITZ_SYNC_SECRET')
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    let authorized = !!syncSecret && suppliedSecret === syncSecret
    if (!authorized) {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (authHeader) {
        const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
        const { data: who, error: whoErr } = await caller.auth.getUser()
        authorized = !whoErr && !!who.user
      }
    }
    if (!authorized) return ok({ error: 'Not authorized' })

    const sftpUrl = Deno.env.get('SKYBITZ_SFTP_URL')
    const sftpUser = Deno.env.get('SKYBITZ_SFTP_USERNAME')
    const sftpPass = Deno.env.get('SKYBITZ_SFTP_PASSWORD')
    if (!sftpUrl || !sftpUser || !sftpPass) return ok({ error: 'credentials_not_configured' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    // Single-tenant deployment — every location belongs to the same company.
    const { data: anyLoc, error: locErr } = await (admin as any)
      .schema('core').from('locations').select('company_id').limit(1).maybeSingle()
    if (locErr || !anyLoc?.company_id) return ok({ error: 'Unable to resolve company_id' })
    const companyId = anyLoc.company_id as string

    const target = parseTarget(sftpUrl)
    const body = await req.json().catch(() => ({}))
    const remotePath: string = typeof body.path === 'string' ? body.path : '/StricklandBrothers.CSV'

    let csvText: string
    const sftp = new SftpClient()
    try {
      await sftp.connect({ host: target.host, port: target.port, username: sftpUser, password: sftpPass, readyTimeout: 20000 })
      const buf = await sftp.get(remotePath)
      csvText = (buf as Buffer).toString('utf-8')
    } finally {
      await sftp.end().catch(() => {})
    }

    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) return ok({ error: 'File had no data rows' })
    const headers = parseCsvLine(lines[0]).map((h) => h.trim())
    const idx = (name: string) => headers.indexOf(name)
    const iRtuid = idx('RTUID'), iTankId = idx('TankID'), iInventory = idx('Inventory'),
      iLevel = idx('Level'), iLevelUom = idx('Level UOM'), iCapacity = idx('Tank Capacity'),
      iBattery = idx('Battery Level'), iTime = idx('Inventory Time (UTC)'),
      iLocation = idx('Location'), iProduct = idx('Product')
    if (iRtuid === -1) return ok({ error: 'RTUID column not found in file' })

    // Existing tank_monitors, keyed by serial — paginated (the Droptop sync
    // in this same codebase learned the hard way that an un-ranged select
    // silently truncates at PostgREST's row cap).
    const existingBySerial = new Map<string, ExistingTank>()
    {
      const PAGE = 1000
      let from = 0
      for (;;) {
        const { data: rows, error } = await (admin as any)
          .schema('inventory').from('tank_monitors')
          .select('id, company_id, location_id, product_id, keep_fill, serial_rtu_id, on_hand, available_capacity, raw_capacity, level_inches, battery_pct, system_tank_id, inventory_time, reading_date')
          .eq('company_id', companyId)
          .not('serial_rtu_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) return ok({ error: `Failed to load existing tank_monitors: ${error.message}` })
        const batch = (rows ?? []) as any[]
        for (const r of batch) {
          existingBySerial.set(String(r.serial_rtu_id).trim().toLowerCase(), {
            id: r.id, company_id: r.company_id, location_id: r.location_id, product_id: r.product_id, keep_fill: r.keep_fill,
            on_hand: r.on_hand, available_capacity: r.available_capacity, raw_capacity: r.raw_capacity,
            level_inches: r.level_inches, battery_pct: r.battery_pct,
            system_tank_id: r.system_tank_id, inventory_time: r.inventory_time, reading_date: r.reading_date,
          })
        }
        if (batch.length < PAGE) break
        from += PAGE
      }
    }

    // Build updates — every row carries the FULL field set (falling back to
    // the tank's existing value when this pull has nothing new), because a
    // batch upsert sends an explicit NULL for any column a row's object
    // omits once ANY row in the batch supplies that column. Omitting a
    // field here to mean "leave alone" would instead null it out. Same
    // rule documented in droptop-sync-usage/index.ts.
    const updates: Record<string, unknown>[] = []
    const inserts: Record<string, unknown>[] = []
    const seenNewRtuids = new Set<string>() // dedupe brand-new rows within this one file
    let skippedNoRtuid = 0, unchangedCount = 0
    for (let li = 1; li < lines.length; li++) {
      const cols = parseCsvLine(lines[li])
      const rtuid = (cols[iRtuid] ?? '').trim()
      if (!rtuid) { skippedNoRtuid++; continue }
      const rtuidKey = rtuid.toLowerCase()
      const existing = existingBySerial.get(rtuidKey)

      const onHand = numOrNull(cols[iInventory])
      const capacity = numOrNull(cols[iCapacity])
      const levelUom = (cols[iLevelUom] ?? '').trim().toLowerCase()
      const level = iLevel !== -1 && (levelUom === 'in' || levelUom === 'inches') ? numOrNull(cols[iLevel]) : null
      const battery = numOrNull(cols[iBattery])
      const systemTankId = iTankId !== -1 ? ((cols[iTankId] ?? '').trim() || null) : null
      const isoTime = iTime !== -1 ? parseSkybitzTime(cols[iTime] ?? '') : null

      if (!existing) {
        // New RTUID — no tank_monitors row references it yet. Insert one
        // with location_id/keep_fill left unset so it shows up for a human
        // to match, same as an unmatched row from the manual CSV import.
        if (seenNewRtuids.has(rtuidKey)) continue
        seenNewRtuids.add(rtuidKey)
        const rawLocation = iLocation !== -1 ? ((cols[iLocation] ?? '').trim() || null) : null
        const rawProduct = iProduct !== -1 ? ((cols[iProduct] ?? '').trim() || null) : null
        inserts.push({
          id: crypto.randomUUID(),
          company_id: companyId,
          location_id: null,
          product_id: rawProduct,
          keep_fill: false,
          source_location: rawLocation,
          serial_rtu_id: rtuid,
          system_tank_id: systemTankId,
          on_hand: onHand,
          available_capacity: onHand != null && capacity != null ? Math.max(capacity - onHand, 0) : null,
          raw_capacity: capacity,
          level_inches: level,
          battery_pct: battery,
          inventory_time: isoTime,
          reading_date: isoTime ? isoTime.slice(0, 10) : null,
          last_change_source: 'skybitz',
          updated_at: new Date().toISOString(),
        })
        continue
      }

      const resolvedOnHand = onHand ?? existing.on_hand
      const resolvedLevel = level ?? existing.level_inches
      const resolvedBattery = battery ?? existing.battery_pct
      const resolvedTime = isoTime ?? existing.inventory_time
      if (resolvedOnHand === existing.on_hand && resolvedLevel === existing.level_inches
        && resolvedBattery === existing.battery_pct && resolvedTime === existing.inventory_time) {
        unchangedCount++
      }

      updates.push({
        id: existing.id,
        company_id: existing.company_id,
        location_id: existing.location_id,
        product_id: existing.product_id,
        keep_fill: existing.keep_fill,
        on_hand: resolvedOnHand,
        available_capacity: onHand != null && capacity != null ? Math.max(capacity - onHand, 0) : existing.available_capacity,
        raw_capacity: capacity ?? existing.raw_capacity,
        level_inches: resolvedLevel,
        battery_pct: resolvedBattery,
        system_tank_id: systemTankId ?? existing.system_tank_id,
        inventory_time: resolvedTime,
        reading_date: isoTime ? isoTime.slice(0, 10) : existing.reading_date,
        updated_at: new Date().toISOString(),
        last_change_source: 'skybitz',
      })
    }

    let updated = 0
    let inserted = 0
    let upsertError: string | null = null
    const BATCH = 500
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH)
      const { error } = await (admin as any).schema('inventory').from('tank_monitors').upsert(slice)
      if (error) { upsertError = error.message; break }
      updated += slice.length
    }
    if (!upsertError) {
      for (let i = 0; i < inserts.length; i += BATCH) {
        const slice = inserts.slice(i, i + BATCH)
        const { error } = await (admin as any).schema('inventory').from('tank_monitors').insert(slice)
        if (error) { upsertError = error.message; break }
        inserted += slice.length
      }
    }

    // Log the run to the connection-agnostic history table the Inventory
    // Alerts "Data Connection Updates" section reads from (best-effort —
    // table may not exist if migration pending).
    ;(admin as any)
      .schema('inventory').from('data_connection_sync_log').insert({
        company_id: companyId,
        connection: 'skybitz_tanks',
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        items_updated: updated - unchangedCount,
        items_unchanged: unchangedCount,
        items_inserted: inserted,
        status: upsertError ? 'error' : 'success',
        error_message: upsertError,
      })
      .then(() => {})

    if (upsertError) return ok({ error: `Upsert failed: ${upsertError}`, updated_so_far: updated, inserted_so_far: inserted })

    return ok({
      success: true,
      rows_in_file: lines.length - 1,
      updated,
      unchanged: unchangedCount,
      inserted,
      skipped_no_rtuid: skippedNoRtuid,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return ok({ error: msg })
  }
})
