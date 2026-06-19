// TODO: [ARCHIVE] Deploy this Supabase Edge Function and schedule it daily via pg_cron or Supabase cron
// pg_cron example: select cron.schedule('archive-old-orders', '0 2 * * *', 'select net.http_post(...)');
// Marks orders as archived when they are past their 60-day retention window

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('placed_orders')
    .update({ is_archived: true, archived_at: now, status: 'archived' })
    .eq('is_archived', false)
    .lt('expires_at', now)
    .select('id')

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ archived: data?.length ?? 0, ran_at: now }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
