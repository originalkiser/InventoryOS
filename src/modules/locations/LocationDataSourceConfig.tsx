import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { ConnectionStatusChip } from '@/components/shared/ConnectionStatusChip'
import { CONNECTION_KEYS } from '@/lib/dataConnections'
import { syncLocationsFromMonday } from '@/services/mondayService'
import toast from 'react-hot-toast'

type SourceType = 'manual' | 'monday' | 'azure_datalake'
type SyncSchedule = 'manual' | '15min' | '1hour' | 'daily'

interface DataSourceRow {
  id: string
  source_type: SourceType
  monday_board_id: string | null
  monday_name_column: string | null
  monday_code_column: string | null
  monday_region_column: string | null
  monday_market_column: string | null
  monday_status_filter: string | null
  azure_container_path: string | null
  sync_schedule: SyncSchedule
  last_synced_at: string | null
  last_sync_count: number | null
}

const DEFAULT: Omit<DataSourceRow, 'id'> = {
  source_type: 'manual',
  monday_board_id: null,
  monday_name_column: null,
  monday_code_column: null,
  monday_region_column: null,
  monday_market_column: null,
  monday_status_filter: 'active',
  azure_container_path: null,
  sync_schedule: 'manual',
  last_synced_at: null,
  last_sync_count: null,
}

function Field({ label, value, onChange, placeholder }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs font-mono text-inky/70 w-44 shrink-0">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none placeholder-inky/30"
      />
    </div>
  )
}

export function LocationDataSourceConfig() {
  const { profile, user } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const [row, setRow] = useState<DataSourceRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    ;(supabase as any).schema('core').from('location_data_source')
      .select('*')
      .limit(1)
      .maybeSingle()
      .then(({ data }: any) => {
        setRow(data ?? { id: '', ...DEFAULT })
      })
  }, [])

  function set<K extends keyof DataSourceRow>(key: K, value: DataSourceRow[K]) {
    setRow((r) => r ? { ...r, [key]: value } : r)
  }

  async function save() {
    if (!row) return
    setSaving(true)
    try {
      if (row.id) {
        await (supabase as any).schema('core').from('location_data_source')
          .update({ ...row, updated_by: user?.id, updated_at: new Date().toISOString() })
          .eq('id', row.id)
      } else {
        const { data } = await (supabase as any).schema('core').from('location_data_source')
          .insert({ ...row, updated_by: user?.id, updated_at: new Date().toISOString() })
          .select().single()
        if (data) setRow(data)
      }
      toast.success('Data source config saved')
    } catch {
      toast.error('Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const result = await syncLocationsFromMonday()
      toast.success(`Sync complete — ${result.added} added, ${result.updated} updated, ${result.deactivated} deactivated`)
      setRow((r) => r ? { ...r, last_synced_at: new Date().toISOString(), last_sync_count: result.added + result.updated } : r)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  if (!row) return <div className="text-xs font-mono text-inky/40 animate-pulse py-4">Loading…</div>

  const sourceType = row.source_type

  return (
    <div className="flex flex-col gap-6 py-2">
      <div>
        <div className="text-[10px] font-heading text-inky/60 uppercase tracking-widest mb-3">Location Data Source</div>

        {/* Source type selector */}
        <div className="flex flex-col gap-2">
          {([
            ['manual', 'Manual / Upload', 'Manage locations manually or via file upload'],
            ['monday', 'Monday.com', 'Sync from a Monday.com board (requires Data Connection)'],
            ['azure_datalake', 'Azure Data Lake', 'Pull from configured Data Lake path (requires Data Connection)'],
          ] as [SourceType, string, string][]).map(([val, name, desc]) => (
            <label key={val} className="flex items-start gap-3 cursor-pointer group">
              <input
                type="radio"
                name="source_type"
                value={val}
                checked={sourceType === val}
                onChange={() => isAdmin && set('source_type', val)}
                disabled={!isAdmin}
                className="mt-0.5 accent-navy"
              />
              <div>
                <div className="text-xs font-mono text-navy group-hover:text-inky">{name}</div>
                <div className="text-[10px] font-mono text-inky/50">{desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Monday.com config */}
      {sourceType === 'monday' && (
        <div className="flex flex-col gap-4 pt-2 border-t border-navy/10">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-inky/60">Connection status:</span>
            <ConnectionStatusChip connectionKey={CONNECTION_KEYS.monday} />
          </div>
          <div className="flex flex-col gap-2.5">
            <Field
              label="Board ID"
              value={row.monday_board_id ?? ''}
              onChange={(v) => set('monday_board_id', v || null)}
              placeholder="e.g. 1234567890"
            />
            <Field
              label="Location Name Column"
              value={row.monday_name_column ?? ''}
              onChange={(v) => set('monday_name_column', v || null)}
              placeholder="Column title in Monday.com"
            />
            <Field
              label="Location Code Column"
              value={row.monday_code_column ?? ''}
              onChange={(v) => set('monday_code_column', v || null)}
              placeholder="Column title in Monday.com"
            />
            <Field
              label="Region Column (optional)"
              value={row.monday_region_column ?? ''}
              onChange={(v) => set('monday_region_column', v || null)}
              placeholder="Column title in Monday.com"
            />
            <Field
              label="Market Column (optional)"
              value={row.monday_market_column ?? ''}
              onChange={(v) => set('monday_market_column', v || null)}
              placeholder="Column title in Monday.com"
            />
            <div className="flex items-center gap-3">
              <label className="text-xs font-mono text-inky/70 w-44 shrink-0">Status Filter</label>
              <select
                value={row.monday_status_filter ?? 'active'}
                onChange={(e) => set('monday_status_filter', e.target.value)}
                disabled={!isAdmin}
                className="text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none"
              >
                <option value="active">Active only</option>
                <option value="all">All</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-mono text-inky/70 w-44 shrink-0">Sync Schedule</label>
              <select
                value={row.sync_schedule}
                onChange={(e) => set('sync_schedule', e.target.value as SyncSchedule)}
                disabled={!isAdmin}
                className="text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none"
              >
                <option value="manual">Manual only</option>
                <option value="15min">Every 15 min</option>
                <option value="1hour">Every hour</option>
                <option value="daily">Daily</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            {isAdmin && (
              <button
                onClick={syncNow}
                disabled={syncing}
                className="text-xs font-mono px-3 py-1.5 rounded bg-navy text-cream hover:bg-inky disabled:opacity-40 transition-colors"
              >
                {syncing ? 'Syncing…' : 'Sync Now'}
              </button>
            )}
            {row.last_synced_at && (
              <span className="text-[10px] font-mono text-inky/50">
                Last synced: {new Date(row.last_synced_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                {row.last_sync_count != null && ` · ${row.last_sync_count} locations`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Azure config */}
      {sourceType === 'azure_datalake' && (
        <div className="flex flex-col gap-4 pt-2 border-t border-navy/10">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-inky/60">Connection status:</span>
            <ConnectionStatusChip connectionKey={CONNECTION_KEYS.azureDatalake} />
          </div>
          <Field
            label="Container Path"
            value={row.azure_container_path ?? ''}
            onChange={(v) => set('azure_container_path', v || null)}
            placeholder="e.g. locations/active.csv"
          />
        </div>
      )}

      {/* Save */}
      {isAdmin && (
        <div className="pt-2">
          <button
            onClick={save}
            disabled={saving}
            className="text-xs font-mono px-4 py-1.5 rounded bg-navy text-cream hover:bg-inky disabled:opacity-40 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Data Source Config'}
          </button>
        </div>
      )}
    </div>
  )
}
