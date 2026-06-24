import { supabase } from '@/lib/supabase'

export interface DataConnection {
  id: string
  connection_key: string
  connection_name: string
  connection_type: 'oauth' | 'api_key' | 'connection_string' | 'readonly_status'
  is_configured: boolean
  config: Record<string, unknown>
  vault_secret_names: string[]
  last_tested_at: string | null
  last_test_status: 'success' | 'failed' | 'untested' | null
  last_test_message: string | null
  updated_at: string
}

export const CONNECTION_KEYS = {
  azureOAuth:     'azure_oauth',
  azureDatalake:  'azure_datalake',
  monday:         'monday',
  outlook:        'outlook',
  supabaseStatus: 'supabase_status',
} as const

export async function getConnectionConfig(key: string): Promise<DataConnection | null> {
  const { data } = await (supabase as any)
    .schema('platform')
    .from('data_connections')
    .select('*')
    .eq('connection_key', key)
    .maybeSingle()
  return data ?? null
}

export async function getAllConnections(): Promise<DataConnection[]> {
  const { data } = await (supabase as any)
    .schema('platform')
    .from('data_connections')
    .select('*')
    .order('connection_name')
  return data ?? []
}

export async function isConnectionReady(key: string): Promise<boolean> {
  const conn = await getConnectionConfig(key)
  return !!(conn?.is_configured && conn?.last_test_status === 'success')
}

export async function saveConnectionConfig(
  key: string,
  config: Record<string, unknown>,
  isConfigured?: boolean,
): Promise<void> {
  const updates: Record<string, unknown> = { config, updated_at: new Date().toISOString() }
  if (isConfigured !== undefined) updates.is_configured = isConfigured
  await (supabase as any)
    .schema('platform')
    .from('data_connections')
    .update(updates)
    .eq('connection_key', key)
}

export async function testConnection(key: string): Promise<{ success: boolean; message: string }> {
  try {
    // supabase_status has its own dedicated edge function
    const fnName = key === 'supabase_status' ? 'supabase-project-status' : 'test-connection'
    const body = key === 'supabase_status' ? undefined : { connection_key: key }
    const { data, error } = await (supabase as any).functions.invoke(fnName, body ? { body } : undefined)
    if (error) return { success: false, message: error.message ?? String(error) }
    if (!data) return { success: false, message: 'No response from function' }
    // supabase-project-status returns { status: 'healthy', ... }
    if (data.status === 'healthy') return { success: true, message: `Supabase project is reachable (checked ${data.checked_at ?? 'now'})` }
    return data as { success: boolean; message: string }
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Unknown error' }
  }
}
