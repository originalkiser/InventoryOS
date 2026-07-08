// Droptop API proxy: generates AES-256-ECB signed requests server-side
// so the private key never touches the browser.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
//
// POST body: { endpoint, operationId?, params?, method? }
// Returns: { data } on success or { error } on failure (always HTTP 200).

import * as aesjs from 'https://esm.sh/aes-js@3.1.2'

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

// AES-256 key: accept 64-char hex (32 bytes) or raw string (UTF-8, padded to 32).
function parseKey(key: string): number[] {
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    const bytes: number[] = []
    for (let i = 0; i < 32; i++) bytes.push(parseInt(key.slice(i * 2, i * 2 + 2), 16))
    return bytes
  }
  const raw = new TextEncoder().encode(key)
  const bytes = new Array(32).fill(0)
  for (let i = 0; i < Math.min(raw.length, 32); i++) bytes[i] = raw[i]
  return bytes
}

// sig = base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey))
export function buildSig(publicKey: string, method: string, privateKey: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = Array.from(new TextEncoder().encode(message))
  const padLen = 16 - (msgBytes.length % 16)
  const padded = [...msgBytes, ...new Array(padLen).fill(padLen)]
  const keyBytes = parseKey(privateKey)
  const ecb = new (aesjs as any).ModeOfOperation.ecb(keyBytes)
  const encrypted: number[] = Array.from(ecb.encrypt(padded))
  return btoa(String.fromCharCode(...encrypted))
}

export async function callDroptop(
  endpoint: string,
  method: string,
  params: Record<string, string>,
  publicKey: string,
  privateKey: string,
): Promise<unknown> {
  const sig = buildSig(publicKey, method, privateKey)
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
