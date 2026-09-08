// Syncs core.locations from the "Open Stores List" Monday.com board
// (https://strickland-brothers-10-minute-oil-change-team.monday.com/boards/2536769965)
// — this replaces the old ad-hoc "Location Data Sources" config UI +
// mondayService.ts scaffold (client-side API key, generic multi-source
// column mapper, and a sync path that referenced columns core.locations
// doesn't even have — location_id/is_active instead of the real id/active).
// That whole UI has been removed. Every data connection now runs through
// this app's own Data Connections page, the same as Droptop/SkyBitz — no
// more per-page ad hoc integrations.
//
// Requires Supabase secret MONDAY_API_KEY (server-side only — never a
// client env var, unlike the old scaffold's VITE_MONDAY_API_KEY).
//
// Matching rule (explicit product decision from the request that built
// this): the board's own item name IS the store number ("001", "002", ...)
// — normalized by stripping leading zeros before comparing, since
// core.locations.name is stored WITHOUT them ("1", not "001" — confirmed
// against live data). A match UPDATEs that row; no match INSERTs a new
// one — including closed/pre-opening stores, which this board does list
// (Status: Open/Closed/Pre-opening/blank) and which SB Net may not already
// have if they closed before ever being brought in via file upload. Only
// "Open" counts as active=true; Closed/Pre-opening/blank all write
// active=false, so a closed shop lands correctly instead of looking live.
// Two known non-shop admin rows on this board ("LOF Office", "WS Office")
// have non-numeric names and are skipped entirely — not updated, not
// inserted (see isRealStoreNumber below).
//
// This does NOT deactivate a SB Net location that's missing from the
// board entirely — only real matches get updated, and only real new board
// items get inserted. A location present in SB Net but absent from Monday
// is left untouched, matching the "only updates locations that already
// exist... and adds new locations" scope this was explicitly built to.
//
// Field mapping: every column on the board with a clear, verified 1:1
// counterpart on core.locations is synced (FIELD_MAP below — built by
// cross-referencing the board's real column ids against
// information_schema.columns, not guessed). A handful of fields with no
// board equivalent (order_date, marketing_manager/mm_email/mm_cell,
// district) are intentionally left alone. raw_monday_data always gets the
// full item payload regardless, so nothing is ever unrecoverable even for
// a field this mapping doesn't cover.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const BOARD_ID = '2536769965'
const PAGE_SIZE = 100
const UPDATE_CONCURRENCY = 8

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// [core.locations column, Monday column id, kind]. kind controls how the
// raw column_value is turned into the value written — see valueFor() below.
// Verified 2026-09-08 against the live board's own columns { id title type }
// (not hand-guessed): every title here matched a real column, and no id or
// db column is reused across two rows.
type FieldKind = 'text' | 'mirror' | 'relation' | 'bool' | 'int' | 'numeric' | 'date'
const FIELD_MAP: [string, string, FieldKind][] = [
  ['owner', 'owner9', 'text'],
  ['market', 'mirror6__1', 'mirror'],
  ['region', 'dup__of_rd_2_email__1', 'mirror'],
  ['area_manager', 'connect_boards7__1', 'relation'],
  ['director', 'connect_boards0__1', 'relation'],
  ['am_phone', 'dup__of_dup__of_market__1', 'mirror'],
  ['am_email', 'dup__of_market__1', 'mirror'],
  ['rd_email', 'mirror5__1', 'mirror'],
  ['address', 'address1', 'text'],
  ['city', 'city2', 'text'],
  ['state', 'state', 'text'],
  ['county', 'text1', 'text'],
  ['zip', 'zip', 'text'],
  ['store_phone', 'phone3', 'text'],
  ['store_email', 'store_email', 'text'],
  ['num_bays', 'text98', 'int'],
  ['pit_type', 'dropdown7__1', 'text'],
  ['store_type', 'tags0', 'text'],
  ['classification', 'status_1', 'text'],
  ['groups', 'dropdown32', 'text'],
  ['entity_name', 'text55', 'text'],
  ['brand_used', 'dropdown1', 'text'],
  ['developer', 'dropdown2', 'text'],
  ['landlord', 'dropdown_mm2pq19q', 'text'],
  ['num_days_open', 'dup__of___days_open__1', 'int'],
  ['manager_workweek', 'numeric_mkwb7bd3', 'text'],
  ['second_asm_approved', 'dropdown_mkxjk1ys', 'bool'],
  ['date_opened', 'date_opened', 'date'],
  ['acquisition_date', 'date1', 'date'],
  ['year_opened', 'dropdown21', 'int'],
  ['droptop_go_live', 'date_mkm1a67t', 'date'],
  ['last_price_change', 'date_mm0p1748', 'date'],
  ['review_pricing_date', 'date_mm3t89yh', 'date'],
  ['last_day_of_business', 'date_mm3t9y55', 'date'],
  ['monday_hours', 'dropdown170__1', 'text'],
  ['tuesday_hours', 'dropdown70__1', 'text'],
  ['wednesday_hours', 'dropdown95__1', 'text'],
  ['thursday_hours', 'dropdown4__1', 'text'],
  ['friday_hours', 'dropdown5__1', 'text'],
  ['saturday_hours', 'dropdown30', 'text'],
  ['sunday_hours', 'dropdown6', 'text'],
  ['holiday_hours', 'text_mks8tqxb', 'text'],
  ['tire_rotations', 'color4', 'bool'],
  ['safety_inspections', 'color6', 'bool'],
  ['emissions_inspections', 'color3', 'bool'],
  ['royalty_rate', 'numbers0', 'numeric'],
  ['local_ad_percent', 'local_ad_percent8__1', 'numeric'],
  ['local_ad_dollar', 'numbers1__1', 'numeric'],
  ['brand_fund', 'text8__1', 'numeric'],
  ['technology_fee', 'text43__1', 'numeric'],
  ['sales_quartile', 'dropdown323', 'text'],
  ['economy', 'numeric_mm0e9ck7', 'numeric'],
  ['premium_hm', 'numeric_mm0ef68v', 'numeric'],
  ['premium_full_synthetic', 'numeric_mm0e2ajd', 'numeric'],
  ['premium_full_synthetic_hm', 'numeric_mm0e395h', 'numeric'],
  ['rp', 'numeric_mm0ea8ps', 'numeric'],
  ['diesel_syn_blend', 'numeric_mm0q4nmt', 'numeric'],
  ['diesel_full_syn', 'numeric_mm0qwdqy', 'numeric'],
  ['european', 'numeric_mm0qynw', 'numeric'],
  ['supply_fee', 'numeric_mm3t7551', 'numeric'],
  ['disposal_fee', 'numeric_mm3tzp17', 'numeric'],
  ['oil_inflation_surcharge', 'numeric_mm3t2m00', 'numeric'],
  ['planned_2023', 'dropdown8', 'text'],
  ['planned_2024', 'dropdown5', 'text'],
  ['valvoline_account_num', 'text24', 'text'],
  ['ai_shop_id', 'ai_shop_id', 'text'],
  ['ai_username', 'text9__1', 'text'],
  ['partnerconnect_username', 'text95__1', 'text'],
  ['google_review_url', 'link__1', 'text'],
  ['google_review_qr_code', 'link_1__1', 'text'],
  ['training_shops', 'dropdown1__1', 'text'],
  ['integration_manager_region', 'dropdown0__1', 'text'],
  ['opus_serial_primary', 'text4__1', 'text'],
  ['opus_serial_secondary', 'dup__of_opus_serial____1', 'text'],
  ['former_fz_store_num', 'numbers2__1', 'text'],
  ['tmcw_ql', 'dropdown49__1', 'text'],
  ['am_data_map', 'dup__of_market_names__1', 'mirror'],
  ['rd_data_map', 'dup__of_region__1', 'mirror'],
  ['droptop_num', 'numbers6__1', 'numeric'],
  ['droptop_operation_id', 'text_mkm1gjx', 'text'],
  ['reladyne_delivery_day', 'dropdown_mkrz4f4d', 'text'],
  ['ai_call_center', 'color_mks8m9x1', 'text'],
  ['ai_call_center_phone', 'phone_mm319xx8', 'text'],
  ['mighty_fz', 'dropdown_mkv0cyvj', 'text'],
  ['camera_system', 'dropdown_mkv5ny0e', 'text'],
  ['inspection_station_id', 'text_mkwzmr60', 'text'],
  ['mighty_po_upload', 'dropdown_mm448gg6', 'bool'],
  ['hrbp', 'dropdown_mm0yb9j6', 'text'],
  ['latitude', 'latitude', 'text'],
  ['longitude', 'longitude', 'text'],
]
const STATUS_COLUMN_ID = 'status2'
const ALL_COLUMN_IDS = [...new Set([...FIELD_MAP.map(([, id]) => id), STATUS_COLUMN_ID])]

interface MondayColumnValue { id: string; text: string | null; display_value?: string }
interface MondayItem { id: string; name: string; column_values: MondayColumnValue[] }

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) { const item = items[next++]; await fn(item) }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function mondayQuery(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Monday.com API error: HTTP ${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'Monday.com GraphQL error')
  return json.data
}

// Cursor-paginated — the board is ~371 items today (well under one page),
// but this board WILL grow, and a single-page assumption is exactly the
// class of bug this codebase has hit (and fixed) more than once elsewhere
// (see project memory on the PostgREST Max Rows cap). items_page/
// next_items_page is Monday's own cursor pattern, confirmed live.
async function fetchAllItems(apiKey: string): Promise<MondayItem[]> {
  const items: MondayItem[] = []
  const colValuesQuery = `id text ... on MirrorValue { display_value } ... on BoardRelationValue { display_value }`
  const first = await mondayQuery(
    apiKey,
    `query($boardId: ID!, $ids: [String!]) {
      boards(ids: [$boardId]) {
        items_page(limit: ${PAGE_SIZE}) { cursor items { id name column_values(ids: $ids) { ${colValuesQuery} } } }
      }
    }`,
    { boardId: BOARD_ID, ids: ALL_COLUMN_IDS },
  )
  const page = first.boards?.[0]?.items_page
  if (!page) throw new Error(`Board ${BOARD_ID} not found or not accessible`)
  items.push(...page.items)
  let cursor: string | null = page.cursor
  while (cursor) {
    const next = await mondayQuery(
      apiKey,
      `query($cursor: String!, $ids: [String!]) {
        next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { id name column_values(ids: $ids) { ${colValuesQuery} } } }
      }`,
      { cursor, ids: ALL_COLUMN_IDS },
    )
    items.push(...next.next_items_page.items)
    cursor = next.next_items_page.cursor
  }
  return items
}

function colVal(item: MondayItem, id: string): string | null {
  const cv = item.column_values.find((c) => c.id === id)
  if (!cv) return null
  const raw = cv.display_value ?? cv.text
  const trimmed = typeof raw === 'string' ? raw.trim() : raw
  return trimmed ? String(trimmed) : null
}

function valueFor(item: MondayItem, mondayId: string, kind: FieldKind): unknown {
  const text = colVal(item, mondayId)
  if (text == null) return null
  switch (kind) {
    case 'text': case 'mirror': case 'relation': case 'date': return text
    case 'bool': return text === 'Yes' ? true : text === 'No' ? false : null
    case 'int': { const n = parseInt(text, 10); return Number.isFinite(n) ? n : null }
    case 'numeric': { const n = Number(text); return Number.isFinite(n) ? n : null }
  }
}

// Only a plain numeric store number counts as a real shop row — two known
// admin rows on this board ("LOF Office", "WS Office") aren't shops and
// would otherwise get created as bogus locations.
function isRealStoreNumber(rawName: string): boolean {
  return /^[0-9]+$/.test(rawName.trim())
}
// core.locations.name has no leading zeros ("1", not "001" — confirmed
// live) while Monday's own item name does ("001") — normalize both sides
// to the same form before comparing, or every single item would read as
// "new" on every run.
function normalizeStoreNumber(rawName: string): string {
  return String(parseInt(rawName.trim(), 10))
}

// shop_city is stored PRE-PREFIXED with the store number ("1-Thomasville",
// not "Thomasville" — a real, already-documented quirk elsewhere in this
// app, see shopLabels.ts). Match that convention when writing it here too,
// guarding against double-prefixing if the board's own City text somehow
// already starts with the store number.
function buildShopCity(storeNumber: string, city: string | null): string | null {
  if (!city) return null
  const alreadyPrefixed = city.startsWith(`${storeNumber}-`) || city.startsWith(`${storeNumber} `)
  return alreadyPrefixed ? city : `${storeNumber}-${city}`
}

function buildLocationFields(item: MondayItem, storeNumber: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [dbCol, mondayId, kind] of FIELD_MAP) fields[dbCol] = valueFor(item, mondayId, kind)

  const status = colVal(item, STATUS_COLUMN_ID)
  fields.status = status
  fields.active = status === 'Open'
  fields.shop_city = buildShopCity(storeNumber, fields.city as string | null)

  fields.monday_item_id = item.id
  fields.raw_monday_data = item
  fields.last_synced_at = new Date().toISOString()
  fields.last_change_source = 'monday_sync'
  return fields
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const mondayApiKey = Deno.env.get('MONDAY_API_KEY')
    if (!mondayApiKey) return ok({ error: 'MONDAY_API_KEY not configured' })

    // Dual auth, same shape as heatmap-rollup-refresh/run-automated-checks:
    // the dispatcher's own shared secret, or a real logged-in user's JWT
    // for the Data Connections page's own "Run Now" button.
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

    // Single-tenant deployment (same assumption skybitz-tank-sync and the
    // dispatcher itself already make) — resolve the one real company_id
    // rather than hard-coding it.
    const { data: companyRow, error: companyErr } = await admin
      .schema('core').from('locations').select('company_id').limit(1).maybeSingle()
    if (companyErr) return ok({ error: companyErr.message })
    if (!companyRow?.company_id) return ok({ error: 'No existing locations to resolve company_id from' })
    const companyId = companyRow.company_id

    const items = await fetchAllItems(mondayApiKey)

    const { data: existing, error: existingErr } = await admin
      .schema('core').from('locations').select('id, name').eq('company_id', companyId)
    if (existingErr) return ok({ error: existingErr.message })
    const byStoreNumber = new Map<string, string>()
    for (const l of (existing ?? []) as { id: string; name: string }[]) {
      if (isRealStoreNumber(l.name)) byStoreNumber.set(normalizeStoreNumber(l.name), l.id)
    }

    let updated = 0
    let added = 0
    let skipped = 0
    const warnings: string[] = []
    const toInsert: Record<string, unknown>[] = []
    const toUpdate: { id: string; fields: Record<string, unknown> }[] = []

    for (const item of items) {
      if (!isRealStoreNumber(item.name)) { skipped++; continue }
      const storeNumber = normalizeStoreNumber(item.name)
      const fields = buildLocationFields(item, storeNumber)
      const existingId = byStoreNumber.get(storeNumber)
      if (existingId) {
        toUpdate.push({ id: existingId, fields })
      } else {
        toInsert.push({ company_id: companyId, name: storeNumber, ...fields })
      }
    }

    await mapWithConcurrency(toUpdate, UPDATE_CONCURRENCY, async ({ id, fields }) => {
      const { error } = await admin.schema('core').from('locations').update(fields).eq('id', id)
      if (error) warnings.push(`update ${id}: ${error.message}`)
      else updated++
    })

    if (toInsert.length) {
      const { error } = await admin.schema('core').from('locations').insert(toInsert)
      if (error) warnings.push(`insert batch: ${error.message}`)
      else added += toInsert.length
    }

    await admin.schema('core').from('location_sync_log').insert({
      synced_at: new Date().toISOString(),
      records_updated: updated,
      records_added: added,
      records_deactivated: 0,
      status: warnings.length ? 'partial' : 'success',
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({ success: true, added, updated, skipped, total_board_items: items.length, warnings })
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
