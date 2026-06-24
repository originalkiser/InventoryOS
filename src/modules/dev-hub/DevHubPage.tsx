import { useEffect, useRef, useState } from 'react'
import { getAllConnections, saveConnectionConfig, saveConnectionTestResult, testConnection, CONNECTION_KEYS, type DataConnection } from '@/lib/dataConnections'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import toast from 'react-hot-toast'

function statusDot(conn: DataConnection) {
  if (!conn.is_configured) return { color: 'bg-inky/30', label: 'NOT CONFIGURED' }
  if (conn.connection_type === 'readonly_status') return { color: 'bg-sky', label: 'READONLY' }
  if (conn.last_test_status === 'success') return { color: 'bg-green-500', label: 'CONFIGURED' }
  if (conn.last_test_status === 'failed') return { color: 'bg-amber-400', label: 'NEEDS ATTENTION' }
  return { color: 'bg-amber-400', label: 'NOT TESTED' }
}

function ConfigField({ label, value, onChange, type = 'text', readOnly = false }: {
  label: string
  value: string
  onChange?: (v: string) => void
  type?: string
  readOnly?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] font-mono text-inky/60 dark:text-[#C4DAE6]/50 w-36 shrink-0">{label}</label>
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        className="flex-1 text-xs font-mono rounded border border-navy/20 dark:border-[#C4DAE6]/20 bg-cream dark:bg-[#002745] text-navy dark:text-[#C4DAE6] px-2 py-1 focus:border-sky focus:outline-none read-only:opacity-50"
      />
    </div>
  )
}

function ConnectionCard({ conn, isAdmin, onRefresh }: {
  conn: DataConnection
  isAdmin: boolean
  onRefresh: () => void
}) {
  const { color, label } = statusDot(conn)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(conn.config).map(([k, v]) => [k, v == null ? '' : String(v)]))
  )
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  function setField(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const coerced: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(draft)) {
        coerced[k] = v === '' ? null : v
      }
      const isConfigured = Object.values(coerced).some((v) => v !== null)
      await saveConnectionConfig(conn.connection_key, coerced, isConfigured)
      toast.success('Connection config saved')
      setEditing(false)
      onRefresh()
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const result = await testConnection(conn.connection_key)
      await saveConnectionTestResult(conn.connection_key, result.success, result.message)
      if (result.success) {
        toast.success(`Test passed: ${result.message}`)
      } else {
        toast.error(`Test failed: ${result.message}`)
      }
      onRefresh()
    } catch {
      toast.error('Test invocation failed')
    } finally {
      setTesting(false)
    }
  }

  const configKeys = Object.keys(conn.config)

  return (
    <div className="border border-navy/20 dark:border-[#4F7489]/40 rounded-lg p-4 flex flex-col gap-3 bg-cream dark:bg-[#0D3555]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />
          <div>
            <div className="text-sm font-heading text-navy dark:text-[#C4DAE6] uppercase tracking-wide">
              {conn.connection_name}
            </div>
            {conn.last_test_status === 'failed' && conn.last_test_message && (
              <div className="text-[10px] font-mono text-red-600 dark:text-red-400 mt-0.5">{conn.last_test_message}</div>
            )}
            {conn.last_tested_at && (
              <div className="text-[10px] font-mono text-inky/50 dark:text-[#C4DAE6]/40 mt-0.5">
                Last tested: {new Date(conn.last_tested_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            )}
          </div>
        </div>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${
          label === 'CONFIGURED'      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' :
          label === 'NEEDS ATTENTION' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' :
          label === 'READONLY'        ? 'bg-sky/20 dark:bg-sky/10 text-navy dark:text-sky' :
                                        'bg-navy/10 dark:bg-[#C4DAE6]/10 text-inky dark:text-[#C4DAE6]/60'
        }`}>
          {label}
        </span>
      </div>

      {/* Edit form */}
      {editing && configKeys.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-navy/10 dark:border-[#C4DAE6]/10">
          {configKeys.map((k) => (
            <ConfigField
              key={k}
              label={k.replace(/_/g, ' ')}
              value={draft[k] ?? ''}
              onChange={(v) => setField(k, v)}
            />
          ))}
          {conn.vault_secret_names.length > 0 && (
            <p className="text-[10px] font-mono text-inky/50 dark:text-[#C4DAE6]/40 mt-1">
              Secrets ({conn.vault_secret_names.join(', ')}) are managed in Supabase Vault — not editable here.
            </p>
          )}
        </div>
      )}

      {conn.connection_type === 'readonly_status' && !editing && (
        <div className="text-[10px] font-mono text-inky/50 dark:text-[#C4DAE6]/40">
          Status is read-only — data is fetched server-side via Edge Function.
        </div>
      )}

      {/* Actions */}
      {isAdmin && (
        <div className="flex items-center gap-2 pt-1">
          {conn.connection_type !== 'readonly_status' && (
            editing ? (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-xs font-mono px-3 py-1 rounded bg-navy text-cream hover:bg-inky disabled:opacity-40 transition-colors"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="text-xs font-mono px-3 py-1 rounded border border-navy/30 dark:border-[#C4DAE6]/20 text-inky dark:text-[#C4DAE6]/70 hover:text-navy dark:hover:text-[#C4DAE6] transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="text-xs font-mono px-3 py-1 rounded border border-navy/30 dark:border-[#C4DAE6]/20 text-inky dark:text-[#C4DAE6]/70 hover:text-navy dark:hover:text-[#C4DAE6] transition-colors"
              >
                {conn.is_configured ? 'Edit' : 'Configure'}
              </button>
            )
          )}
          {!editing && conn.connection_type !== 'readonly_status' && (
            <button
              onClick={handleTest}
              disabled={testing}
              className="text-xs font-mono px-3 py-1 rounded border border-navy/30 dark:border-[#C4DAE6]/20 text-inky dark:text-[#C4DAE6]/70 hover:text-navy dark:hover:text-[#C4DAE6] disabled:opacity-40 transition-colors"
            >
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
          )}
          {!editing && conn.connection_type === 'readonly_status' && (
            <button
              onClick={handleTest}
              disabled={testing}
              className="text-xs font-mono px-3 py-1 rounded border border-navy/30 dark:border-[#C4DAE6]/20 text-inky dark:text-[#C4DAE6]/70 hover:text-navy dark:hover:text-[#C4DAE6] disabled:opacity-40 transition-colors"
            >
              {testing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function DevHubPage() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const [connections, setConnections] = useState<DataConnection[]>([])
  const [loading, setLoading] = useState(true)
  const hourlyRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load() {
    setLoading(true)
    const data = await getAllConnections()
    setConnections(data)
    setLoading(false)
  }

  async function runSupabaseStatusCheck() {
    const result = await testConnection(CONNECTION_KEYS.supabaseStatus)
    await saveConnectionTestResult(CONNECTION_KEYS.supabaseStatus, result.success, result.message)
    const fresh = await getAllConnections()
    setConnections(fresh)
  }

  useEffect(() => {
    load()
  }, [])

  // Hourly Supabase project status check (runs immediately on load, then every hour)
  useEffect(() => {
    runSupabaseStatusCheck()
    hourlyRef.current = setInterval(runSupabaseStatusCheck, 3_600_000)
    return () => { if (hourlyRef.current) clearInterval(hourlyRef.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy dark:text-[#C4DAE6] tracking-wide uppercase">Developer Hub</h1>
        <p className="text-xs text-inky dark:text-[#C4DAE6]/60 mt-0.5">External integrations, connection config, and platform diagnostics</p>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-heading text-navy dark:text-[#C4DAE6] uppercase tracking-widest">Data Connections</h2>
          {!isAdmin && (
            <span className="text-[10px] font-mono text-inky/50 dark:text-[#C4DAE6]/40">View-only — admin/developer access required to configure</span>
          )}
        </div>

        {loading ? (
          <div className="text-xs font-mono text-inky/40 dark:text-[#C4DAE6]/30 animate-pulse py-8 text-center">Loading connections…</div>
        ) : connections.length === 0 ? (
          <div className="text-xs font-mono text-inky/40 dark:text-[#C4DAE6]/30 py-8 text-center">No connections found. Run migration 20260624000800 to seed them.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {connections.map((conn) => (
              <ConnectionCard key={conn.id} conn={conn} isAdmin={isAdmin} onRefresh={load} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
