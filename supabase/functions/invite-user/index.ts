// Edge Function: admin-only user creation with NO confirmation email.
//
// The client-side invite used auth.signUp(), which sends a confirmation email
// and is rate-limited by Supabase's built-in mailer ("email rate limit
// exceeded"). This function uses the service-role admin API to create an
// already-confirmed user (email_confirm: true) — no email is ever sent — and
// inserts the matching profile row. The service-role key stays server-side.
//
// Deploy:  supabase functions deploy invite-user
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // 1) Identify the caller from their JWT and require an admin role.
    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser()
    if (whoErr || !who.user) return json({ error: 'Not authenticated' })

    const { data: me, error: meErr } = await caller
      .from('profiles').select('company_id, role, email').eq('id', who.user.id).single()
    if (meErr || !me) return json({ error: 'Your profile was not found' })
    if (me.role !== 'admin') return json({ error: 'Only admins can invite users' })

    // 2) Validate the payload.
    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim().toLowerCase()
    const fullName = String(body.full_name ?? '').trim()
    const role = body.role === 'admin' ? 'admin' : 'user'
    const password = String(body.password ?? '')
    if (!email || !fullName || !password) return json({ error: 'Name, email, and password are required' })

    // Invite-only to the inviter's email domain (e.g. @sboilchange.com).
    const adminDomain = String(me.email ?? '').split('@')[1]?.toLowerCase()
    const newDomain = email.split('@')[1]?.toLowerCase()
    if (adminDomain && newDomain && adminDomain !== newDomain) {
      return json({ error: `Email must be on the @${adminDomain} domain` })
    }

    // 3) Create a confirmed auth user (no email) + the profile, via service role.
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (createErr || !created.user) return json({ error: createErr?.message ?? 'Could not create the user' })

    const { error: profErr } = await admin.from('profiles').insert({
      id: created.user.id,
      company_id: me.company_id,
      full_name: fullName,
      email,
      role,
    })
    if (profErr) {
      // Roll back the auth user so a retry isn't blocked by a duplicate email.
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: profErr.message })
    }

    return json({ id: created.user.id })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})
