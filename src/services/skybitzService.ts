// Client for the SkyBitz tank telemetry sync — a server-side Supabase Edge
// Function (skybitz-tank-sync), authenticated via Supabase secrets
// (SKYBITZ_SFTP_URL / SKYBITZ_SFTP_USERNAME / SKYBITZ_SFTP_PASSWORD /
// SKYBITZ_SYNC_SECRET). Interactive calls (this file) are authorized by the
// logged-in user's own session, which supabase.functions.invoke() attaches
// automatically — the shared-secret path is only for the unattended daily
// pg_cron run.

import { supabase } from '@/lib/supabase'

export interface SkybitzSyncResult {
  rows_in_file: number
  updated: number
  unchanged: number
  inserted: number
  skipped_no_rtuid: number
}

export async function runSkybitzTankSync(): Promise<SkybitzSyncResult> {
  const { data, error } = await supabase.functions.invoke('skybitz-tank-sync', { body: {} })
  if (error) throw new Error(error.message)
  if (data?.error) {
    throw new Error(
      data.error === 'credentials_not_configured'
        ? 'SkyBitz SFTP credentials not configured — add SKYBITZ_SFTP_URL, SKYBITZ_SFTP_USERNAME, and SKYBITZ_SFTP_PASSWORD to Supabase secrets.'
        : data.error
    )
  }
  return {
    rows_in_file: data.rows_in_file ?? 0,
    updated: data.updated ?? 0,
    unchanged: data.unchanged ?? 0,
    inserted: data.inserted ?? 0,
    skipped_no_rtuid: data.skipped_no_rtuid ?? 0,
  }
}

export interface SkybitzLookupResult {
  file_modified_at: string | null
  matched: Record<string, string | null>[]
}

// Read-only — downloads the live SkyBitz file and returns the raw row(s)
// for the given serial(s), no DB writes. For checking what SkyBitz's own
// feed currently says about a specific monitor (e.g. has it already been
// relabeled to a new shop on their end) without waiting for the next
// scheduled sync.
export async function lookupSkybitzMonitor(serials: string[]): Promise<SkybitzLookupResult> {
  const { data, error } = await supabase.functions.invoke('skybitz-tank-sync', { body: { mode: 'lookup', serials } })
  if (error) throw new Error(error.message)
  if (data?.error) {
    throw new Error(
      data.error === 'credentials_not_configured'
        ? 'SkyBitz SFTP credentials not configured — add SKYBITZ_SFTP_URL, SKYBITZ_SFTP_USERNAME, and SKYBITZ_SFTP_PASSWORD to Supabase secrets.'
        : data.error
    )
  }
  return { file_modified_at: data.file_modified_at ?? null, matched: data.matched ?? [] }
}
