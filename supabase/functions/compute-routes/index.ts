import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface RouteRequest {
  pairs: { origin_id: string; destination_id: string; origin_lat: number; origin_lng: number; dest_lat: number; dest_lng: number }[]
  company_id: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    // Verify caller is admin or developer
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const { data: profile } = await supabase
      .schema('platform')
      .from('user_profiles')
      .select('role, company_id')
      .eq('id', user.id)
      .single()

    if (!profile || !['admin', 'developer'].includes(profile.role)) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin/developer only' }), { status: 403, headers: CORS })
    }

    const body: RouteRequest = await req.json()
    if (!body.pairs?.length) {
      return new Response(JSON.stringify({ error: 'No pairs provided' }), { status: 400, headers: CORS })
    }
    if (body.company_id !== profile.company_id) {
      return new Response(JSON.stringify({ error: 'Forbidden: company mismatch' }), { status: 403, headers: CORS })
    }

    const GOOGLE_ROUTES_KEY = Deno.env.get('GOOGLE_ROUTES_API_KEY')
    if (!GOOGLE_ROUTES_KEY) {
      return new Response(JSON.stringify({ error: 'Google Routes API key not configured' }), { status: 500, headers: CORS })
    }

    const results = []
    for (const pair of body.pairs) {
      const googleResp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_ROUTES_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: pair.origin_lat, longitude: pair.origin_lng } } },
          destination: { location: { latLng: { latitude: pair.dest_lat, longitude: pair.dest_lng } } },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
      })

      if (!googleResp.ok) {
        results.push({ origin_id: pair.origin_id, destination_id: pair.destination_id, error: `Google API ${googleResp.status}` })
        continue
      }

      const googleData = await googleResp.json()
      const route = googleData.routes?.[0]
      if (!route) {
        results.push({ origin_id: pair.origin_id, destination_id: pair.destination_id, error: 'No route returned' })
        continue
      }

      const distanceMeters = route.distanceMeters ?? 0
      const durationSeconds = parseInt(route.duration?.replace('s', '') ?? '0', 10)

      results.push({
        origin_id: pair.origin_id,
        destination_id: pair.destination_id,
        distance_miles: Math.round((distanceMeters / 1609.344) * 10) / 10,
        drive_time_minutes: Math.round(durationSeconds / 60),
        route_geometry: route.polyline?.encodedPolyline ?? null,
        api_response_metadata: { distanceMeters, durationSeconds },
      })
    }

    // Upsert results via service-role client so we can write regardless of RLS caller context
    const sbAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    for (const r of results) {
      if (r.error) continue
      await (sbAdmin as any).schema('core').from('location_routes').upsert({
        company_id: body.company_id,
        origin_location_id: r.origin_id,
        destination_location_id: r.destination_id,
        distance_miles: r.distance_miles,
        drive_time_minutes: r.drive_time_minutes,
        route_geometry: r.route_geometry,
        data_source: 'api',
        api_provider: 'google_routes_v2',
        api_response_metadata: r.api_response_metadata,
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,origin_location_id,destination_location_id' })
    }

    return new Response(JSON.stringify({ results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('compute-routes error:', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: CORS })
  }
})
