// Edge Function: step 2 of the login screen's two-step flow (see
// src/pages/Login.tsx) — called right after supabase.auth.signInWithPassword()
// resolves, with whether it succeeded. Runs unauthenticated (the caller may
// not have a valid session, that's the whole point of a failed attempt), so
// this has to use the service role rather than a client-side update under RLS.
//
// A success resets the counter. A failure increments it; on the 5th
// consecutive failure it sets locked_at AND bans the account via the Admin
// API (ban_duration far in the future — Supabase has no literal "forever",
// so this is the accepted convention for "until an admin explicitly lifts
// it") so a locked account can't sign in even by calling
// supabase.auth.signInWithPassword() directly, bypassing this app's own
// login screen entirely.
//
// Deploy:  supabase functions deploy record-login-attempt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

const MAX_ATTEMPTS = 5
// Supabase's Admin API has no literal "permanent" ban — a long duration is
// the documented convention for "until explicitly unbanned."
const LOCK_BAN_DURATION = '876000h'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim()
    const success = body.success === true
    if (!email) return json({ error: 'email is required' })

    const { data: profile } = await (admin as any)
      .schema('platform').from('user_profiles')
      .select('id, failed_login_attempts, locked_at')
      .ilike('email', email)
      .is('deleted_at', null)
      .maybeSingle()

    // Nothing to record against — don't reveal whether the email exists here
    // either way (check-login-email already handled that decision).
    if (!profile) return json({ ok: true })

    // Already locked — a stray attempt (e.g. a request that slipped past the
    // login screen's own gate) shouldn't reset or re-extend anything.
    if (profile.locked_at) return json({ locked: true, attemptsRemaining: 0 })

    if (success) {
      await (admin as any).schema('platform').from('user_profiles')
        .update({ failed_login_attempts: 0 }).eq('id', profile.id)
      return json({ ok: true })
    }

    const nextCount = (profile.failed_login_attempts ?? 0) + 1
    const locked = nextCount >= MAX_ATTEMPTS
    await (admin as any).schema('platform').from('user_profiles')
      .update({ failed_login_attempts: nextCount, locked_at: locked ? new Date().toISOString() : null })
      .eq('id', profile.id)

    if (locked) {
      await admin.auth.admin.updateUserById(profile.id, { ban_duration: LOCK_BAN_DURATION })
    }

    return json({ locked, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - nextCount) })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})
