// Edge Function: admin/developer-triggered password reset that doesn't rely
// on the user having email access to click a reset link. Generates a
// temporary password server-side, sets it directly via the service-role
// Admin API, and flags the user's profile so the app forces them through
// Set New Password (src/pages/ResetPassword.tsx) on their next login.
//
// Mirrors invite-user's own admin-verification pattern.
//
// Deploy:  supabase functions deploy admin-password-reset
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically into deployed functions — no manual secrets needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // 1) Identify the caller from their JWT and require an admin/developer role.
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser()
    if (whoErr || !who.user) return json({ error: 'Not authenticated' })

    const { data: me, error: meErr } = await (caller as any)
      .schema('platform').from('user_profiles').select('company_id, role').eq('id', who.user.id).single()
    if (meErr || !me) return json({ error: 'Your profile was not found' })
    if (me.role !== 'admin' && me.role !== 'administrator' && me.role !== 'developer') {
      return json({ error: 'Only admins or developers can reset another user\'s password' })
    }

    // 2) Validate the payload — target user must be in the caller's own company.
    const body = await req.json().catch(() => ({}))
    const targetUserId = String(body.userId ?? '').trim()
    if (!targetUserId) return json({ error: 'userId is required' })

    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: target, error: targetErr } = await (admin as any)
      .schema('platform').from('user_profiles').select('id, email, company_id').eq('id', targetUserId).single()
    if (targetErr || !target) return json({ error: 'User not found' })
    if (target.company_id !== me.company_id) return json({ error: 'That user is not in your workspace' })

    // 3) Set a new temp password via the service-role Admin API, and flag the
    // profile so the app forces Set New Password on their next login.
    const tempPassword = generatePassword()
    const { error: updateErr } = await admin.auth.admin.updateUserById(targetUserId, { password: tempPassword })
    if (updateErr) return json({ error: updateErr.message })

    const { error: flagErr } = await (admin as any)
      .schema('platform').from('user_profiles').update({ must_reset_password: true }).eq('id', targetUserId)
    if (flagErr) {
      // The password WAS changed — don't claim failure, but be explicit that
      // the forced-reset flag didn't take (likely the migration isn't applied yet).
      return json({ tempPassword: tempPassword, email: target.email, warning: `Password was reset, but the forced-reset flag failed to save: ${flagErr.message}` })
    }

    return json({ tempPassword, email: target.email })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})
