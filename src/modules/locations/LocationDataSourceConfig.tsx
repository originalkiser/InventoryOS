import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { ConnectionStatusChip } from '@/components/shared/ConnectionStatusChip'
import { CONNECTION_KEYS } from '@/lib/dataConnections'
import { syncLocationsFromMonday, getMondayBoardPreview } from '@/services/mondayService'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import type { ColumnMapping } from '@/types'
import toast from 'react-hot-toast'

// ─── Types ────────────────────────────────────────────────────────────────────

type ExtSourceType =
  | 'manual' | 'monday' | 'azure_datalake' | 'onedrive'
  | 'powerbi_datalake' | 'power_automate' | 'generic_api' | 'azure_blob'

interface RefreshSchedule {
  mode: 'manual' | 'scheduled'
  times: string[]
}

interface DataSource {
  id: string
  company_id: string | null
  name: string | null
  source_type: ExtSourceType
  connection_config: Record<string, any>
  field_mappings: ColumnMapping[]
  refresh_schedule: RefreshSchedule
  write_mode: 'replace_source_data' | 'append'
  active: boolean
  last_synced_at: string | null
  last_sync_count: number | null
  last_tested_at: string | null
  last_test_status: string | null
  last_test_error: string | null
  // Legacy flat columns preserved for mondayService compat
  monday_board_id: string | null
  monday_status_filter: string | null
  azure_container_path: string | null
  sync_schedule: string
}

interface SourcePreview {
  columns: string[]
  rows: Record<string, string>[]
  meta: Record<string, string>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<ExtSourceType, string> = {
  manual: 'Manual / Upload',
  monday: 'Monday.com',
  azure_datalake: 'Azure Data Lake',
  onedrive: 'OneDrive',
  powerbi_datalake: 'Power BI Data Lake',
  power_automate: 'Power Automate',
  generic_api: 'Generic API',
  azure_blob: 'Azure Blob Storage',
}

const LOCATION_TARGET_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true as const },
  { name: 'name',          label: 'Location Name', required: true as const },
  { name: 'region',        label: 'Region' },
  { name: 'market',        label: 'Market' },
  { name: 'area_manager',  label: 'Area Manager' },
  { name: 'owner',         label: 'Owner' },
  { name: 'district',      label: 'District' },
  { name: 'regional_director', label: 'Regional Director' },
]

const BLANK_SOURCE: Omit<DataSource, 'id'> = {
  company_id: null,
  name: null,
  source_type: 'monday',
  connection_config: {},
  field_mappings: [],
  refresh_schedule: { mode: 'manual', times: [] },
  write_mode: 'replace_source_data',
  active: true,
  last_synced_at: null,
  last_sync_count: null,
  last_tested_at: null,
  last_test_status: null,
  last_test_error: null,
  monday_board_id: null,
  monday_status_filter: 'active',
  azure_container_path: null,
  sync_schedule: 'manual',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeRow(row: any): DataSource {
  // Seed connection_config from legacy flat columns if empty
  const cfg =
    row.connection_config && Object.keys(row.connection_config).length > 0
      ? row.connection_config
      : row.source_type === 'monday' && row.monday_board_id
        ? { board_id: row.monday_board_id, status_filter: row.monday_status_filter ?? 'active' }
        : (row.source_type === 'azure_datalake' || row.source_type === 'azure_blob') && row.azure_container_path
          ? { container_path: row.azure_container_path }
          : {}

  const rs = row.refresh_schedule
  const refresh_schedule: RefreshSchedule =
    rs && typeof rs === 'object'
      ? { mode: rs.mode ?? 'manual', times: Array.isArray(rs.times) ? rs.times : [] }
      : { mode: 'manual', times: [] }

  return {
    id: row.id,
    company_id: row.company_id ?? null,
    name: row.name ?? null,
    source_type: row.source_type ?? 'monday',
    connection_config: cfg,
    field_mappings: Array.isArray(row.field_mappings) ? row.field_mappings : [],
    refresh_schedule,
    write_mode: row.write_mode ?? 'replace_source_data',
    active: row.active ?? true,
    last_synced_at: row.last_synced_at ?? null,
    last_sync_count: row.last_sync_count ?? null,
    last_tested_at: row.last_tested_at ?? null,
    last_test_status: row.last_test_status ?? null,
    last_test_error: row.last_test_error ?? null,
    monday_board_id: row.monday_board_id ?? null,
    monday_status_filter: row.monday_status_filter ?? 'active',
    azure_container_path: row.azure_container_path ?? null,
    sync_schedule: row.sync_schedule ?? 'manual',
  }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

// ─── Shared UI atoms ──────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-[10px] font-heading text-inky/60 uppercase tracking-widest border-b border-navy/10 pb-1 mb-1">
      {title}
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs font-mono text-inky/70 w-44 shrink-0">{label}</label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function TxtInput({ value, onChange, placeholder, disabled, type = 'text' }: {
  value: string; onChange: (v: string) => void
  placeholder?: string; disabled?: boolean; type?: string
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} disabled={disabled}
      className="w-full text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none placeholder-inky/30 disabled:opacity-50"
    />
  )
}

function Btn({ onClick, disabled, loading, children, variant = 'default' }: {
  onClick?: () => void; disabled?: boolean; loading?: boolean
  children: React.ReactNode; variant?: 'default' | 'secondary'
}) {
  const base = 'text-xs font-mono px-3 py-1.5 rounded transition-colors disabled:opacity-40'
  const cls = variant === 'secondary'
    ? `${base} border border-navy/20 text-inky hover:text-navy hover:border-navy/40`
    : `${base} bg-navy text-cream hover:bg-inky`
  return (
    <button onClick={onClick} disabled={disabled || loading} className={cls}>
      {loading ? '…' : children}
    </button>
  )
}

// ─── Preview Table ─────────────────────────────────────────────────────────────

function PreviewTable({ preview }: { preview: SourcePreview }) {
  return (
    <div className="flex flex-col gap-2">
      {Object.keys(preview.meta).length > 0 && (
        <div className="flex flex-wrap gap-4 text-[10px] font-mono text-inky/60">
          {Object.entries(preview.meta).map(([k, v]) => (
            <span key={k}>{k}: <span className="text-navy">{v}</span></span>
          ))}
        </div>
      )}
      <div className="overflow-auto rounded border border-navy/20 max-h-52">
        <table className="text-[11px] font-mono w-full">
          <thead className="bg-navy text-inky sticky top-0">
            <tr>
              {preview.columns.map((c) => (
                <th key={c} className="px-2 py-1.5 text-left whitespace-nowrap font-normal">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => (
              <tr key={i} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                {preview.columns.map((c) => (
                  <td key={c} className="px-2 py-1 whitespace-nowrap text-navy max-w-[200px] truncate">{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Connection Config sub-forms ───────────────────────────────────────────────

function MondayConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-inky/60">Connection status:</span>
        <ConnectionStatusChip connectionKey={CONNECTION_KEYS.monday} />
      </div>
      <FieldRow label="Board ID">
        <TxtInput value={cfg.board_id ?? ''} onChange={(v) => onChange('board_id', v || null)} placeholder="e.g. 1234567890" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Status Filter">
        <select value={cfg.status_filter ?? 'active'} onChange={(e) => onChange('status_filter', e.target.value)}
          disabled={!isAdmin} className="text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none">
          <option value="active">Active only</option>
          <option value="all">All items</option>
        </select>
      </FieldRow>
    </div>
  )
}

function AzureConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-inky/60">Connection status:</span>
        <ConnectionStatusChip connectionKey={CONNECTION_KEYS.azureDatalake} />
      </div>
      <FieldRow label="Container Path">
        <TxtInput value={cfg.container_path ?? ''} onChange={(v) => onChange('container_path', v || null)} placeholder="e.g. locations/active.csv" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Account Name (opt.)">
        <TxtInput value={cfg.account_name ?? ''} onChange={(v) => onChange('account_name', v || null)} placeholder="mystorageaccount" disabled={!isAdmin} />
      </FieldRow>
    </div>
  )
}

function OneDriveConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded border border-sky/20 bg-sky/5 px-3 py-2 text-[10px] font-mono text-inky/70">
        ⚠ OneDrive integration requires a backend Edge Function. Save config here to enable future scheduled sync.
      </div>
      <FieldRow label="Site URL">
        <TxtInput value={cfg.site_url ?? ''} onChange={(v) => onChange('site_url', v || null)} placeholder="https://yourorg.sharepoint.com/sites/..." disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="File Path">
        <TxtInput value={cfg.file_path ?? ''} onChange={(v) => onChange('file_path', v || null)} placeholder="Documents/locations.xlsx" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Sheet / Tab">
        <TxtInput value={cfg.sheet_name ?? ''} onChange={(v) => onChange('sheet_name', v || null)} placeholder="Sheet1" disabled={!isAdmin} />
      </FieldRow>
    </div>
  )
}

function PowerBIConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded border border-sky/20 bg-sky/5 px-3 py-2 text-[10px] font-mono text-inky/70">
        ⚠ Power BI Data Lake integration requires a backend Edge Function. Save config here for future activation.
      </div>
      <FieldRow label="Workspace ID">
        <TxtInput value={cfg.workspace_id ?? ''} onChange={(v) => onChange('workspace_id', v || null)} placeholder="UUID" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Dataset ID">
        <TxtInput value={cfg.dataset_id ?? ''} onChange={(v) => onChange('dataset_id', v || null)} placeholder="UUID" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Table Name">
        <TxtInput value={cfg.table_name ?? ''} onChange={(v) => onChange('table_name', v || null)} placeholder="Locations" disabled={!isAdmin} />
      </FieldRow>
    </div>
  )
}

function PowerAutomateConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow label="Webhook URL">
        <TxtInput value={cfg.webhook_url ?? ''} onChange={(v) => onChange('webhook_url', v || null)}
          placeholder="https://prod-xx.westus.logic.azure.com/..." disabled={!isAdmin} />
      </FieldRow>
      <p className="text-[10px] font-mono text-inky/50 pl-[188px]">
        Test Connection sends a HEAD request. Full data pull requires a Power Automate flow configured to push to this app.
      </p>
    </div>
  )
}

function GenericAPIConfig({ cfg, onChange, isAdmin }: { cfg: Record<string, any>; onChange: (k: string, v: any) => void; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow label="URL">
        <TxtInput value={cfg.url ?? ''} onChange={(v) => onChange('url', v || null)} placeholder="https://api.example.com/locations" disabled={!isAdmin} />
      </FieldRow>
      <FieldRow label="Auth Type">
        <select value={cfg.auth_type ?? 'none'} onChange={(e) => onChange('auth_type', e.target.value)}
          disabled={!isAdmin} className="text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none">
          <option value="none">None</option>
          <option value="api_key">API Key (header)</option>
          <option value="bearer">Bearer Token</option>
        </select>
      </FieldRow>
      {cfg.auth_type && cfg.auth_type !== 'none' && (
        <FieldRow label={cfg.auth_type === 'api_key' ? 'API Key' : 'Token'}>
          <input type="password" value={cfg.auth_value ?? ''} onChange={(e) => onChange('auth_value', e.target.value || null)}
            placeholder="Store secrets in .env — do not commit" disabled={!isAdmin}
            className="w-full text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none" />
        </FieldRow>
      )}
    </div>
  )
}

// ─── Schedule Editor ──────────────────────────────────────────────────────────

function ScheduleEditor({ schedule, onChange, disabled }: {
  schedule: RefreshSchedule; onChange: (s: RefreshSchedule) => void; disabled?: boolean
}) {
  const [newTime, setNewTime] = useState('')
  function addTime() {
    if (!newTime || schedule.times.includes(newTime)) return
    onChange({ ...schedule, times: [...schedule.times, newTime].sort() })
    setNewTime('')
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-6">
        {(['manual', 'scheduled'] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" value={mode} checked={schedule.mode === mode} disabled={disabled}
              onChange={() => onChange({ ...schedule, mode })} className="accent-navy" />
            <span className="text-xs font-mono text-navy">
              {mode === 'manual' ? 'Manual only' : 'Scheduled'}
            </span>
          </label>
        ))}
      </div>
      {schedule.mode === 'scheduled' && (
        <div className="pl-4 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2 items-center">
            {schedule.times.length === 0 && (
              <span className="text-[10px] font-mono text-inky/40">No refresh times set</span>
            )}
            {schedule.times.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded border border-navy/20 bg-navy/5 px-2 py-1 text-xs font-mono text-navy">
                {t}
                {!disabled && (
                  <button onClick={() => onChange({ ...schedule, times: schedule.times.filter((x) => x !== t) })}
                    className="text-inky/50 hover:text-[#C0392B] leading-none">×</button>
                )}
              </span>
            ))}
          </div>
          {!disabled && (
            <div className="flex items-center gap-2">
              <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)}
                className="text-xs font-mono rounded border border-navy/20 bg-cream px-2 py-1 focus:border-sky focus:outline-none" />
              <Btn variant="secondary" onClick={addTime} disabled={!newTime}>+ Add time</Btn>
            </div>
          )}
          <p className="text-[10px] font-mono text-inky/50">
            Scheduled refresh runs via backend cron or Edge Function. Times are stored as local-time HH:mm.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Source Card (list view) ──────────────────────────────────────────────────

function SourceCard({ source, onEdit, onToggleActive, onSynced, isAdmin }: {
  source: DataSource
  onEdit: () => void
  onToggleActive: () => void
  onSynced: () => void
  isAdmin: boolean
}) {
  const [syncing, setSyncing] = useState(false)
  const schedSummary =
    source.refresh_schedule.mode === 'scheduled' && source.refresh_schedule.times.length > 0
      ? source.refresh_schedule.times.join(', ')
      : 'Manual only'

  async function handleSync() {
    setSyncing(true)
    try {
      const r = await syncLocationsFromMonday()
      toast.success(`Sync complete — ${r.added} added, ${r.updated} updated, ${r.deactivated} deactivated`)
      onSynced()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className={['border border-navy/20 rounded-lg p-4 flex flex-col gap-2', !source.active ? 'opacity-50' : ''].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-heading uppercase tracking-wide text-navy">
              {source.name || SOURCE_LABELS[source.source_type]}
            </span>
            <span className="text-[10px] font-mono text-inky/60 rounded bg-navy/5 px-1.5 py-0.5">
              {SOURCE_LABELS[source.source_type]}
            </span>
            {!source.active && (
              <span className="text-[10px] font-mono text-inky/40">disabled</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] font-mono text-inky/60 mt-1">
            <span>Schedule: <span className="text-navy">{schedSummary}</span></span>
            <span>Write: <span className="text-navy">{source.write_mode === 'replace_source_data' ? 'Replace' : 'Append'}</span></span>
            {source.field_mappings.length > 0 && (
              <span>Mapping: <span className="text-navy">{source.field_mappings.length} fields</span></span>
            )}
            {source.last_tested_at && (
              <span>
                Tested:{' '}
                <span className={source.last_test_status === 'ok' ? 'text-[#2ECC71]' : 'text-[#C0392B]'}>
                  {fmtDate(source.last_tested_at)} · {source.last_test_status}
                </span>
              </span>
            )}
            {source.last_synced_at && (
              <span>
                Synced: <span className="text-navy">
                  {fmtDate(source.last_synced_at)}{source.last_sync_count != null ? ` · ${source.last_sync_count} rows` : ''}
                </span>
              </span>
            )}
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5 shrink-0">
            {source.source_type === 'monday' && source.active && (
              <Btn variant="secondary" onClick={handleSync} loading={syncing}>
                {syncing ? 'Syncing…' : 'Sync Now'}
              </Btn>
            )}
            <Btn variant="secondary" onClick={onEdit}>Edit</Btn>
            <Btn variant="secondary" onClick={onToggleActive}>
              {source.active ? 'Disable' : 'Enable'}
            </Btn>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Source Editor ─────────────────────────────────────────────────────────────

function SourceEditor({ initial, userId, companyId, onSaved, onCancel, isAdmin }: {
  initial: DataSource
  userId: string | undefined
  companyId: string | undefined
  onSaved: () => void
  onCancel: () => void
  isAdmin: boolean
}) {
  const [draft, setDraft] = useState<DataSource>(initial)
  const [preview, setPreview] = useState<SourcePreview | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showMapper, setShowMapper] = useState(false)

  const setCfg = useCallback((k: string, v: any) => {
    setDraft((d) => ({ ...d, connection_config: { ...d.connection_config, [k]: v } }))
  }, [])

  async function testConnection() {
    setTesting(true)
    setPreview(null)
    const ts = new Date().toISOString()
    try {
      let p: SourcePreview
      if (draft.source_type === 'monday') {
        const boardId = draft.connection_config.board_id
        if (!boardId) throw new Error('Board ID is required')
        const result = await getMondayBoardPreview(boardId)
        p = {
          columns: result.columns.map((c) => c.title),
          rows: result.rows,
          meta: {
            Board: result.boardName,
            'Preview rows': String(result.previewCount),
            Columns: String(result.columns.length),
          },
        }
        toast.success(`Connected — ${result.previewCount} sample rows, ${result.columns.length} columns`)
      } else if (draft.source_type === 'generic_api' || draft.source_type === 'power_automate') {
        const url = draft.source_type === 'generic_api' ? draft.connection_config.url : draft.connection_config.webhook_url
        if (!url) throw new Error('URL is required')
        await fetch(url, { method: 'HEAD', mode: 'no-cors' })
        p = {
          columns: ['Note'],
          rows: [{ Note: 'Endpoint reachable. Full data preview requires a backend function.' }],
          meta: { URL: url, Status: 'reachable (no-cors HEAD)' },
        }
        toast.success('Endpoint reachable')
      } else {
        toast('Full connection test requires a backend function for this source type.', { icon: 'ℹ️' })
        setTesting(false)
        return
      }
      setPreview(p)
      setDraft((d) => ({ ...d, last_tested_at: ts, last_test_status: 'ok', last_test_error: null }))
      // Best-effort: persist test timestamp if source already saved
      if (draft.id) {
        ;(supabase as any).schema('core').from('location_data_source')
          .update({ last_tested_at: ts, last_test_status: 'ok', last_test_error: null })
          .eq('id', draft.id)
          .then(() => {})
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg)
      setDraft((d) => ({ ...d, last_tested_at: ts, last_test_status: 'error', last_test_error: msg }))
      if (draft.id) {
        ;(supabase as any).schema('core').from('location_data_source')
          .update({ last_tested_at: ts, last_test_status: 'error', last_test_error: msg })
          .eq('id', draft.id)
          .then(() => {})
      }
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    const sb = supabase as any
    const payload: Record<string, any> = {
      company_id: companyId ?? null,
      name: draft.name,
      source_type: draft.source_type,
      connection_config: draft.connection_config,
      field_mappings: draft.field_mappings,
      refresh_schedule: draft.refresh_schedule,
      write_mode: draft.write_mode,
      active: draft.active,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }
    // Preserve legacy flat columns for backward compat with mondayService
    if (draft.source_type === 'monday') {
      payload.monday_board_id = draft.connection_config.board_id ?? null
      payload.monday_status_filter = draft.connection_config.status_filter ?? 'active'
    }
    if (draft.source_type === 'azure_datalake' || draft.source_type === 'azure_blob') {
      payload.azure_container_path = draft.connection_config.container_path ?? null
    }

    try {
      if (draft.id) {
        const { error } = await sb.schema('core').from('location_data_source').update(payload).eq('id', draft.id)
        if (error) throw error
      } else {
        const { error } = await sb.schema('core').from('location_data_source').insert(payload)
        if (error) throw error
      }
      toast.success('Source saved')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save source')
    } finally {
      setSaving(false)
    }
  }

  // Derive ColumnMapper headers: prefer live preview, fall back to existing mapping sourceColumns
  const mapperHeaders: string[] =
    preview?.columns ??
    Array.from(
      new Set(
        draft.field_mappings
          .map((m) => m.sourceColumn)
          .filter((s) => s && s !== '__constant__' && s !== '__composite__'),
      ),
    )

  return (
    <div className="flex flex-col gap-6 py-2">

      {/* 1 — Source Info */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Source Info" />
        <FieldRow label="Source Name">
          <TxtInput value={draft.name ?? ''} onChange={(v) => setDraft((d) => ({ ...d, name: v || null }))}
            placeholder="e.g. Monday.com Locations" disabled={!isAdmin} />
        </FieldRow>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-mono text-inky/70">Source Type</span>
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
            {(Object.keys(SOURCE_LABELS) as ExtSourceType[]).map((val) => (
              <label key={val} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="src_type" value={val} checked={draft.source_type === val}
                  onChange={() => isAdmin && setDraft((d) => ({ ...d, source_type: val, connection_config: {} }))}
                  disabled={!isAdmin} className="accent-navy" />
                <span className="text-xs font-mono text-navy">{SOURCE_LABELS[val]}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* 2 — Connection Config */}
      {draft.source_type !== 'manual' && (
        <div className="flex flex-col gap-3">
          <SectionHeader title="Connection Config" />
          {draft.source_type === 'monday' && <MondayConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
          {(draft.source_type === 'azure_datalake' || draft.source_type === 'azure_blob') && <AzureConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
          {draft.source_type === 'onedrive' && <OneDriveConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
          {draft.source_type === 'powerbi_datalake' && <PowerBIConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
          {draft.source_type === 'power_automate' && <PowerAutomateConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
          {draft.source_type === 'generic_api' && <GenericAPIConfig cfg={draft.connection_config} onChange={setCfg} isAdmin={isAdmin} />}
        </div>
      )}

      {/* 3 — Test & Preview */}
      {draft.source_type !== 'manual' && (
        <div className="flex flex-col gap-3">
          <SectionHeader title="Test Connection" />
          <div className="flex items-center gap-3 flex-wrap">
            <Btn onClick={testConnection} loading={testing} disabled={!isAdmin}>
              {testing ? 'Testing…' : 'Test Connection'}
            </Btn>
            {draft.last_tested_at && (
              <span className={[
                'text-[10px] font-mono',
                draft.last_test_status === 'ok' ? 'text-[#2ECC71]' : 'text-[#C0392B]',
              ].join(' ')}>
                {draft.last_test_status === 'ok' ? '✓' : '✗'} Last tested {fmtDate(draft.last_tested_at)}
              </span>
            )}
          </div>
          {draft.last_test_error && (
            <p className="text-[10px] font-mono text-[#C0392B]">{draft.last_test_error}</p>
          )}
          {preview && <PreviewTable preview={preview} />}
        </div>
      )}

      {/* 4 — Field Mapping */}
      {draft.source_type !== 'manual' && (
        <div className="flex flex-col gap-3">
          <SectionHeader title="Field Mapping" />
          {!showMapper ? (
            <div className="flex items-center gap-3">
              {draft.field_mappings.length > 0 ? (
                <span className="text-xs font-mono text-inky/70">
                  {draft.field_mappings.length} field{draft.field_mappings.length !== 1 ? 's' : ''} mapped
                </span>
              ) : !preview ? (
                <span className="text-xs font-mono text-inky/50">
                  Run Test Connection to auto-populate columns, or configure manually.
                </span>
              ) : null}
              <button onClick={() => setShowMapper(true)}
                className="text-xs font-mono text-inky underline hover:text-navy">
                {draft.field_mappings.length > 0 ? 'Edit mapping' : 'Configure mapping'}
              </button>
            </div>
          ) : (
            <div className="border border-navy/20 rounded-lg">
              <ColumnMapper
                headers={mapperHeaders}
                requiredFields={LOCATION_TARGET_FIELDS}
                previewRows={preview?.rows.slice(0, 5)}
                initialMappings={draft.field_mappings.length > 0 ? draft.field_mappings : undefined}
                onConfirm={(mappings) => {
                  setDraft((d) => ({ ...d, field_mappings: mappings }))
                  setShowMapper(false)
                  toast.success(`${mappings.length} field mappings saved`)
                }}
                onCancel={() => setShowMapper(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* 5 — Refresh Schedule */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Refresh Schedule" />
        <ScheduleEditor
          schedule={draft.refresh_schedule}
          onChange={(s) => setDraft((d) => ({ ...d, refresh_schedule: s }))}
          disabled={!isAdmin}
        />
      </div>

      {/* 6 — Write Mode */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Write Mode" />
        <div className="flex flex-col gap-2">
          {([
            ['replace_source_data', 'Replace previous source data', 'Removes rows from this source before writing new data. Only affects rows owned by this source.'],
            ['append', 'Append to existing data', 'Adds new rows on each refresh without removing prior rows from this source.'],
          ] as [string, string, string][]).map(([val, name, desc]) => (
            <label key={val} className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="write_mode" value={val}
                checked={draft.write_mode === val}
                onChange={() => isAdmin && setDraft((d) => ({ ...d, write_mode: val as any }))}
                disabled={!isAdmin} className="mt-0.5 accent-navy" />
              <div>
                <div className="text-xs font-mono text-navy">{name}</div>
                <div className="text-[10px] font-mono text-inky/50">{desc}</div>
              </div>
            </label>
          ))}
          {draft.write_mode === 'replace_source_data' && (
            <div className="rounded border border-sky/20 bg-sky/5 px-3 py-2 text-[10px] font-mono text-inky/70">
              ⚠ Destructive replace requires row-level source tracking on the target table. Without it, replace behaves as append. A backend sync function must enforce this — no data will be deleted from Test Connection alone.
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 pt-2 border-t border-navy/10">
        <Btn onClick={handleSave} loading={saving} disabled={!isAdmin}>
          {draft.id ? 'Save Changes' : 'Save Source'}
        </Btn>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function LocationDataSourceConfig() {
  const { profile, user } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const [sources, setSources] = useState<DataSource[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<DataSource | null>(null)

  useEffect(() => {
    if (!profile?.company_id) return
    load()
  }, [profile?.company_id])

  async function load() {
    const { data } = await (supabase as any).schema('core').from('location_data_source')
      .select('*')
      .order('updated_at')
    setSources((data ?? []).map(normalizeRow))
    setLoading(false)
  }

  function startNew() {
    setEditing({ id: '', ...BLANK_SOURCE, company_id: profile?.company_id ?? null })
  }

  async function toggleActive(source: DataSource) {
    const { error } = await (supabase as any).schema('core').from('location_data_source')
      .update({ active: !source.active, updated_at: new Date().toISOString() })
      .eq('id', source.id)
    if (error) { toast.error('Failed to update'); return }
    load()
  }

  if (loading) {
    return <div className="text-xs font-mono text-inky/40 animate-pulse py-4">Loading…</div>
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <div className="text-[10px] font-heading text-inky/60 uppercase tracking-widest">
          {editing.id ? 'Edit Source' : 'Add Source'}
        </div>
        <SourceEditor
          initial={editing}
          userId={user?.id}
          companyId={profile?.company_id ?? undefined}
          onSaved={() => { setEditing(null); load() }}
          onCancel={() => setEditing(null)}
          isAdmin={isAdmin}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-heading text-inky/60 uppercase tracking-widest">
          Location Data Sources
        </div>
        {isAdmin && (
          <button onClick={startNew}
            className="text-xs font-mono px-3 py-1.5 rounded border border-navy/20 text-inky hover:text-navy hover:border-navy/40 transition-colors">
            + Add Source
          </button>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="text-xs font-mono text-inky/40 py-6 text-center">
          No sources configured. {isAdmin ? 'Click "+ Add Source" to get started.' : 'Contact an admin to configure a data source.'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {sources.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              onEdit={() => setEditing(s)}
              onToggleActive={() => toggleActive(s)}
              onSynced={load}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      )}
    </div>
  )
}
