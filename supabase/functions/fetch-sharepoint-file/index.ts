// Server-side fetch proxy + optional Microsoft Graph auth for OneDrive/SharePoint.
//
// Always returns HTTP 200 with { content } on success or { error } on failure,
// so the Supabase JS client always delivers the response body to the caller.
//
// useGraphApi=false (default): plain proxy — fetches URL from Deno, no CORS issues.
// useGraphApi=true: Microsoft client credentials OAuth → Graph API download.
//   Requires Supabase secrets: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//   Azure app permission: Microsoft Graph > Files.Read.All (application)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Always 200 — errors are in the JSON body so the Supabase client surfaces them
function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
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

    if (!url) return ok({ error: 'url is required' })

    if (!useGraphApi) {
      // Plain proxy — Deno fetches server-side (no browser CORS).
      // Send browser-like headers so SharePoint/OneDrive sharing links aren't rejected.
      let res: Response
      try {
        res = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        })
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        return ok({ error: `Could not reach URL: ${msg}` })
      }
      if (!res.ok) {
        return ok({ error: `Source returned ${res.status} ${res.statusText} — check the URL is correct and publicly accessible` })
      }
      const contentType = res.headers.get('content-type') ?? ''
      const isBinary = contentType.includes('spreadsheetml') ||
        contentType.includes('excel') ||
        contentType.includes('octet-stream') ||
        contentType.includes('zip')
      if (isBinary) {
        const buffer = await res.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        const b64 = btoa(binary)
        // Determine filename extension from content-type
        const filename = contentType.includes('spreadsheetml') ? 'live_data.xlsx' : 'live_data.bin'
        return ok({ content: b64, isBase64: true, filename })
      }
      const content = await res.text()
      return ok({ content })
    }

    // Graph API path — requires Azure credentials
    const tenantId = Deno.env.get('AZURE_TENANT_ID')
    const clientId = Deno.env.get('AZURE_CLIENT_ID')
    const clientSecret = Deno.env.get('AZURE_CLIENT_SECRET')

    if (!tenantId || !clientId || !clientSecret) {
      return ok({ error: 'credentials_not_configured' })
    }

    let tokenData: any
    try {
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
      tokenData = await tokenRes.json()
      if (!tokenRes.ok || !tokenData.access_token) {
        const msg = tokenData.error_description ?? tokenData.error ?? 'unknown'
        return ok({ error: `Microsoft authentication failed: ${msg}` })
      }
    } catch (tokenErr: unknown) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr)
      return ok({ error: `Token request failed: ${msg}` })
    }

    const encoded = encodeShareUrl(url)
    const graphUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`

    let fileRes: Response
    try {
      fileRes = await fetch(graphUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        redirect: 'follow',
      })
    } catch (fileErr: unknown) {
      const msg = fileErr instanceof Error ? fileErr.message : String(fileErr)
      return ok({ error: `Graph API fetch failed: ${msg}` })
    }

    if (!fileRes.ok) {
      const errText = await fileRes.text()
      return ok({ error: `Graph API error (${fileRes.status}): ${errText}` })
    }

    const content = await fileRes.text()
    return ok({ content })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return ok({ error: msg })
  }
})
