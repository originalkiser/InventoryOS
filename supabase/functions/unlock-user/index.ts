// Edge Function: admin/developer unlocks a user account that the login
// screen's failed-attempt tracking (record-login-attempt) has locked.
// Clears the lockout state on the profile and lifts the matching Admin API
// ban set when the account was locked.
//
// Mirrors invite-user / admin-password-reset's own admin-verification
// pattern.
//
// Deploy:  supabase functions deploy unlock-user

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
      return json({ error: 'Only admins or developers can unlock another user\'s account' })
    }

    // 2) Validate the payload — target user must be in the caller's own company.
    const body = await req.json().catch(() => ({}))
    const targetUserId = String(body.userId ?? '').trim()
    if (!targetUserId) return json({ error: 'userId is required' })

    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: target, error: targetErr } = await (admin as any)
      .schema('platform').from('user_profiles').select('id, company_id').eq('id', targetUserId).single()
    if (targetErr || !target) return json({ error: 'User not found' })
    if (target.company_id !== me.company_id) return json({ error: 'That user is not in your workspace' })

    // 3) Clear the lockout and lift the matching Admin API ban.
    const { error: updateErr } = await (admin as any)
      .schema('platform').from('user_profiles')
      .update({ failed_login_attempts: 0, locked_at: null })
      .eq('id', targetUserId)
    if (updateErr) return json({ error: updateErr.message })

    const { error: banErr } = await admin.auth.admin.updateUserById(targetUserId, { ban_duration: 'none' })
    if (banErr) return json({ error: `Lockout cleared, but lifting the sign-in ban failed: ${banErr.message}` })

    return json({ ok: true })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})
