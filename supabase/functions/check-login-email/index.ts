// Edge Function: step 1 of the login screen's two-step flow (see
// src/pages/Login.tsx). Called with just an email, before any password is
// entered or the caller has any session — so this MUST run unauthenticated,
// via the service role, rather than as a client-side query under RLS.
//
// Deliberately confirms whether an email belongs to a real SB Net account
// before the password field ever appears, so someone who lands on the login
// screen from a public menu-board share link (no account, no reason to be
// here) can't get anywhere near attempting a password. This does mean the
// endpoint doubles as an "is this a real company email" oracle — accepted
// tradeoff for an internal tool whose whole point is gating strangers off
// the login screen, not hiding which employees exist.
//
// Deploy:  supabase functions deploy check-login-email

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim()
    if (!email) return json({ error: 'email is required' })

    const { data: profile } = await (admin as any)
      .schema('platform').from('user_profiles')
      .select('locked_at')
      .ilike('email', email)
      .is('deleted_at', null)
      .maybeSingle()

    if (!profile) return json({ exists: false })
    return json({ exists: true, locked: profile.locked_at != null })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})
