// Read-only connectivity test for the SkyBitz SFTP feed — proves login +
// directory listing (and optionally previews one file's first lines) work
// from a Deno Edge Function before any real sync logic gets built on top of
// it. Never writes to tank_monitors or anything else.
//
// Requires Supabase secrets: SKYBITZ_SFTP_URL, SKYBITZ_SFTP_USERNAME,
// SKYBITZ_SFTP_PASSWORD (already set — see Config → Locations → Tank
// Monitors for where the real sync will eventually live).
//
// POST body: { path? }
//   path — if given, downloads that remote file and returns its first 20
//          lines as text instead of just listing the directory.
//
// SKYBITZ_SFTP_URL may be a bare host ("ftp.skybitz.com"), a host:port pair,
// or a full sftp:// URL with an optional path — this parses whichever form
// was saved into the secret.

import SftpClient from 'npm:ssh2-sftp-client@12'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const sftpUrl = Deno.env.get('SKYBITZ_SFTP_URL')
    const sftpUser = Deno.env.get('SKYBITZ_SFTP_USERNAME')
    const sftpPass = Deno.env.get('SKYBITZ_SFTP_PASSWORD')

    if (!sftpUrl || !sftpUser || !sftpPass) return ok({ error: 'credentials_not_configured' })

    // Verify caller — same pattern as droptop-sync-usage.
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser()
    if (whoErr || !who.user) return ok({ error: 'Not authenticated' })

    const body = await req.json().catch(() => ({}))
    const target = parseTarget(sftpUrl)
    const requestedPath: string | null = typeof body.path === 'string' ? body.path : null

    const sftp = new SftpClient()
    try {
      await sftp.connect({
        host: target.host,
        port: target.port,
        username: sftpUser,
        password: sftpPass,
        readyTimeout: 15000,
      })

      if (requestedPath) {
        const buf = await sftp.get(requestedPath) as Buffer
        const text = buf.toString('utf-8')
        const lines = text.split(/\r?\n/).slice(0, 20)
        return ok({ success: true, host: target.host, path: requestedPath, preview_lines: lines })
      }

      const listing = await sftp.list(target.path)
      const files = listing
        .map((f: any) => ({ name: f.name, type: f.type, size: f.size, modifyTime: f.modifyTime }))
        .sort((a: any, b: any) => (b.modifyTime ?? 0) - (a.modifyTime ?? 0))
        .slice(0, 50)
      return ok({ success: true, host: target.host, listed_path: target.path, file_count: listing.length, files })
    } finally {
      await sftp.end().catch(() => {})
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return ok({ error: msg })
  }
})
