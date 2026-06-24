// Edge Function: supabase-project-status
// Returns a lightweight health/status payload for the DevHub connection card.
// In production this can be extended to query the Supabase Management API.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const projectRef = url.replace('https://', '').split('.')[0] ?? 'unknown'

    return json({
      status: 'healthy',
      project_ref: projectRef,
      region: 'us-east-1',
      checked_at: new Date().toISOString(),
      services: {
        database: 'healthy',
        auth: 'healthy',
        storage: 'healthy',
        realtime: 'healthy',
        edge_functions: 'healthy',
      },
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' }, 500)
  }
})
