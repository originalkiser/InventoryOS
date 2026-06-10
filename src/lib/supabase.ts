import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string) || ''
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''

// True when the app is built without Supabase secrets (e.g. missing GitHub Actions secrets)
export const SUPABASE_MISSING = !supabaseUrl || !supabaseAnonKey

// Use fallback strings so createClient doesn't throw — network calls will fail
// but we'll show a config error screen before any of that happens.
export const supabase = createClient<Database>(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  { auth: { persistSession: true, autoRefreshToken: true } }
)
