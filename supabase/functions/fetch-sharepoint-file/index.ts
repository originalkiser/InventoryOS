// Server-side fetch proxy + optional Microsoft Graph auth for OneDrive/SharePoint.
//
// When useGraphApi is false (default): fetches the URL directly from Deno —
// no CORS restrictions, works for any public URL including OneDrive direct-download links.
//
// When useGraphApi is true: uses Microsoft client credentials OAuth to authenticate
// with Graph API, then downloads via the /shares/{encodedUrl}/driveItem/content endpoint.
// Requires these Supabase secrets (Project Settings → Edge Functions → Secrets):
//   AZURE_TENANT_ID      — Azure Portal > Azure Active Directory > Tenant ID
//   AZURE_CLIENT_ID      — App Registration > Overview > Application (client) ID
//   AZURE_CLIENT_SECRET  — App Registration > Certificates & secrets > New client secret
// And these app permissions on the Azure App Registration (application, not delegated):
//   Microsoft Graph > Files.Read.All

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function encodeShareUrl(shareUrl: string): string {
  const b64 = btoa(shareUrl).replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-')
  return `u!${b64}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json().catch(() => ({}))
    const url: string = body.url ?? ''
    const useGraphApi: boolean = body.useGraphApi ?? false

    if (!url) return json({ error: 'url is required' }, 400)

    if (!useGraphApi) {
      // Simple proxy — fetch the URL server-side (no CORS restrictions in Deno)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) return json({ error: `Fetch failed (${res.status} ${res.statusText})` }, res.status < 500 ? res.status : 502)
      const content = await res.text()
      return json({ content })
    }

    // Graph API path — requires Azure credentials
    const tenantId = Deno.env.get('AZURE_TENANT_ID')
    const clientId = Deno.env.get('AZURE_CLIENT_ID')
    const clientSecret = Deno.env.get('AZURE_CLIENT_SECRET')

    if (!tenantId || !clientId || !clientSecret) {
      return json({
        error: 'credentials_not_configured',
        detail: 'Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET as Supabase secrets.',
      }, 500)
    }

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      },
    )
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.error_description ?? tokenData.error ?? 'unknown'
      return json({ error: `Microsoft authentication failed: ${msg}` }, 502)
    }

    const encoded = encodeShareUrl(url)
    const graphUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`

    const fileRes = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      redirect: 'follow',
    })

    if (!fileRes.ok) {
      const errText = await fileRes.text()
      return json({ error: `Graph API error (${fileRes.status}): ${errText}` }, fileRes.status < 500 ? fileRes.status : 502)
    }

    const content = await fileRes.text()
    return json({ content })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return json({ error: msg }, 500)
  }
})
