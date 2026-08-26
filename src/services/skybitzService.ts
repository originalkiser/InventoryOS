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
