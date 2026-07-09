// Droptop API proxy: generates AES-256-ECB signed requests server-side
// so the private key never touches the browser.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
//
// POST body: { endpoint, operationId?, params?, method? }
// Returns: { data } on success or { error } on failure (always HTTP 200).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// sig = base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey))
// ECB implemented via AES-CBC with a zeroed IV applied per 16-byte block.

function parseKey(key: string): Uint8Array {
  const k = key.trim()
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(k.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(k)) {
    const raw = atob(k)
    const bytes = new Uint8Array(32)
    for (let i = 0; i < Math.min(raw.length, 32); i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  }
  const raw = new TextEncoder().encode(k)
  const bytes = new Uint8Array(32)
  bytes.set(raw.slice(0, 32))
  return bytes
}

export async function buildSig(publicKey: string, method: string, privateKey: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey.trim()}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = new TextEncoder().encode(message)
  const padLen = 16 - (msgBytes.length % 16)
  const padded = new Uint8Array(msgBytes.length + padLen)
  padded.set(msgBytes)
  padded.fill(padLen, msgBytes.length)
  const cryptoKey = await crypto.subtle.importKey(
    'raw', parseKey(privateKey), { name: 'AES-CBC' }, false, ['encrypt'],
  )
  const zeroIV = new Uint8Array(16)
  const encrypted = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, padded.slice(i, i + 16))
    encrypted.set(new Uint8Array(enc).slice(0, 16), i)
  }
  return btoa(String.fromCharCode(...encrypted))
}

export async function callDroptop(
  endpoint: string,
  method: string,
  params: Record<string, string>,
  publicKey: string,
  privateKey: string,
): Promise<unknown> {
  const sig = await buildSig(publicKey, method, privateKey)
  const qs = new URLSearchParams({ sig, ...params })
  const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': publicKey, 'Content-Type': 'application/json' },
    redirect: 'follow',
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
  return JSON.parse(text)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const publicKey = Deno.env.get('DROPTOP_PUBLIC_KEY')
    const privateKey = Deno.env.get('DROPTOP_PRIVATE_KEY')
    if (!publicKey || !privateKey) return ok({ error: 'credentials_not_configured' })

    const body = await req.json().catch(() => ({}))
    const endpoint: string = body.endpoint ?? ''
    const operationId: string = body.operationId ?? ''
    const params: Record<string, string> = body.params ?? {}
    const method: string = (body.method ?? 'GET').toUpperCase()

    if (!endpoint) return ok({ error: 'endpoint is required' })
    if (operationId) params.operation_ids = operationId

    const data = await callDroptop(endpoint, method, params, publicKey, privateKey)
    return ok({ data })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : 'Unexpected error' })
  }
})
