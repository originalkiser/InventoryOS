// TODO: [MONDAY] Requires VITE_MONDAY_API_KEY and VITE_MONDAY_BOARD_ID in .env
// monday.com GraphQL endpoint: https://api.monday.com/v2
// Column IDs must be confirmed and mapped in MONDAY_COLUMN_MAP below

import { supabase } from '@/lib/supabase'
import type { MondayItem, SyncResult, LocationSyncLog } from '@/types/integrations'

const MONDAY_API_URL = 'https://api.monday.com/v2'

const MONDAY_COLUMN_MAP = {
  location_id: '',        // TODO: [MONDAY] set monday.com column ID
  location_name: 'name',  // monday.com item name (built-in)
  order_date: '',         // TODO: [MONDAY] set monday.com column ID
  region: '',             // TODO: [MONDAY] set monday.com column ID
  district: '',           // TODO: [MONDAY] set monday.com column ID
  is_active: '',          // TODO: [MONDAY] set monday.com column ID (status column)
}

// TODO: [MONDAY] Paste confirmed column IDs into MONDAY_COLUMN_MAP before enabling
const GET_LOCATIONS_QUERY = `
  query GetLocations($boardId: ID!) {
    boards(ids: [$boardId]) {
      items_page(limit: 500) {
        items {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    }
  }
`

export async function getMondayBoardItems(boardId: string): Promise<MondayItem[]> {
  const apiKey = import.meta.env.VITE_MONDAY_API_KEY
  if (!apiKey) throw new Error('monday.com integration not yet configured. Set VITE_MONDAY_API_KEY in .env')

  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query: GET_LOCATIONS_QUERY, variables: { boardId } }),
  })
  if (!res.ok) throw new Error(`monday.com API error: HTTP ${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'monday.com GraphQL error')
  return json.data?.boards?.[0]?.items_page?.items ?? []
}

function mapItemToLocation(item: MondayItem) {
  const col = (id: string) => item.column_values.find((c) => c.id === id)?.text ?? ''
  return {
    location_id: MONDAY_COLUMN_MAP.location_id ? col(MONDAY_COLUMN_MAP.location_id) : item.id,
    location_name: item.name,
    order_date: MONDAY_COLUMN_MAP.order_date ? col(MONDAY_COLUMN_MAP.order_date) || null : null,
    region: MONDAY_COLUMN_MAP.region ? col(MONDAY_COLUMN_MAP.region) || null : null,
    district: MONDAY_COLUMN_MAP.district ? col(MONDAY_COLUMN_MAP.district) || null : null,
    is_active: true, // TODO: [MONDAY] map from status column via MONDAY_COLUMN_MAP.is_active
    monday_item_id: item.id,
    raw_monday_data: item,
    last_synced_at: new Date().toISOString(),
  }
}

export async function syncLocationsFromMonday(): Promise<SyncResult> {
  const boardId = import.meta.env.VITE_MONDAY_BOARD_ID
  if (!boardId) throw new Error('monday.com integration not yet configured. Set VITE_MONDAY_BOARD_ID in .env')

  const result: SyncResult = { added: 0, updated: 0, deactivated: 0, errors: [] }

  try {
    const items = await getMondayBoardItems(boardId)
    const { data: existing } = await (supabase as any).schema('core').from('locations').select('location_id')
    const existingIds = new Set(((existing ?? []) as { location_id: string }[]).map((r) => r.location_id))
    const incomingIds = new Set<string>()

    for (const item of items) {
      const loc = mapItemToLocation(item)
      if (!loc.location_id) { result.errors.push(`Item ${item.id}: no location_id mapped`); continue }
      incomingIds.add(loc.location_id)

      const isNew = !existingIds.has(loc.location_id)
      const { error } = await (supabase as any).schema('core').from('locations').upsert(loc, { onConflict: 'location_id' })
      if (error) result.errors.push(`${loc.location_id}: ${error.message}`)
      else if (isNew) result.added++
      else result.updated++
    }

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        await (supabase as any).schema('core').from('locations').update({ is_active: false }).eq('location_id', id)
        result.deactivated++
      }
    }

    await writeSyncLog(result, 'success', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await writeSyncLog(result, 'error', msg)
    throw err
  }

  return result
}

async function writeSyncLog(result: SyncResult, status: LocationSyncLog['status'], error_message: string | null) {
  await (supabase as any).schema('core').from('location_sync_log').insert({
    synced_at: new Date().toISOString(),
    records_updated: result.updated,
    records_added: result.added,
    records_deactivated: result.deactivated,
    status,
    error_message,
  })
}

export async function getLastSyncLog(): Promise<LocationSyncLog | null> {
  const { data } = await (supabase as any)
    .from('locations_sync_log')
    .select('*')
    .order('synced_at', { ascending: false })
    .limit(1)
  return ((data ?? []) as LocationSyncLog[])[0] ?? null
}

export async function getSyncHistory(limit = 10): Promise<LocationSyncLog[]> {
  const { data } = await (supabase as any)
    .from('locations_sync_log')
    .select('*')
    .order('synced_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as LocationSyncLog[]
}
