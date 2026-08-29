// Simplified place to run and schedule the app's server-side sync jobs
// (SkyBitz tank telemetry, Droptop on-hand, Droptop usage) without touching
// Supabase-side cron config. Automation is entirely driven by
// inventory.data_connection_schedules — a single fixed-cadence pg_cron job
// (data-connection-dispatcher) checks these rows and fires whatever's due;
// changing a connection's frequency or time is just a row update here.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Card, CardHeader, CardBody, Toggle, Badge, Select, SbLoader } from '@/components/ui'
import { runSkybitzTankSync } from '@/services/skybitzService'
import { runDroptopSync, runDroptopPurchaseOrderSync } from '@/services/droptopService'
import type { DataConnectionSchedule } from '@/types/integrations'
import { formatInTz } from '@/lib/tzFormat'
import toast from 'react-hot-toast'

// Exported so DataConnectionUpdatesSection.tsx's sync-log table can display
// timestamps in this same company-configured timezone rather than the
// viewer's own browser timezone.
export const TIMEZONE_KEY = 'data_connection_timezone'
export const DEFAULT_TIMEZONE = 'America/Chicago'
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain, no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
]

const CONNECTION_META: Record<string, { label: string; description: string }> = {
  skybitz_tanks: { label: 'SkyBitz Tank Monitors', description: 'Pulls tank telemetry (on-hand, level, battery) over SFTP.' },
  droptop_on_hand: { label: 'Droptop — On Hand', description: 'Pulls current on-hand quantities from Droptop into Product Usage.' },
  droptop_usage: { label: 'Droptop — Usage', description: 'Pulls sales/adjustment activity from Droptop and logs the daily sold/adjusted ledger.' },
  droptop_purchase_orders: { label: 'Droptop — Purchase Orders', description: 'Pulls open/recent POs and their line items — feeds the PO Status page and Orders v2\'s "already on order" check.' },
  automated_checks: { label: 'Automated Checks', description: 'Scans the movement feed for abnormal adjustments, sales with zero on-hand, and tank-vs-Droptop variance — flags into Exception Reporting. Run this after the Droptop pulls, not before.' },
}
const CONNECTION_ORDER = ['skybitz_tanks', 'droptop_on_hand', 'droptop_usage', 'droptop_purchase_orders', 'automated_checks']

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

function statusColor(status: string | null): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'success') return 'green'
  if (status === 'partial') return 'orange'
  if (status === 'error') return 'red'
  return 'gray'
}

export function DataConnectionsTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [timezone, setTimezone] = useAppSetting<string>(TIMEZONE_KEY, DEFAULT_TIMEZONE)
  const [rows, setRows] = useState<DataConnectionSchedule[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('data_connection_schedules')
      .select('*').eq('company_id', companyId)
    setRows((data ?? []) as DataConnectionSchedule[])
  }, [companyId])

  useEffect(() => { load() }, [load])

  async function saveRow(row: DataConnectionSchedule, patch: Partial<DataConnectionSchedule>) {
    setSaving(row.id)
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('data_connection_schedules')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    setSaving(null)
    if (error) { toast.error('Failed to save schedule'); return }
    setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, ...patch } : r)) ?? prev)
  }

  async function runNow(key: string) {
    if (!companyId) return
    setRunning(key)
    try {
      if (key === 'skybitz_tanks') {
        const r = await runSkybitzTankSync()
        toast.success(`SkyBitz: ${r.updated} updated, ${r.inserted} new, ${r.unchanged} unchanged`)
      } else if (key === 'droptop_on_hand') {
        const r = await runDroptopSync(companyId, { mode: 'inventory', daysBack: 1 })
        toast.success(`Droptop on-hand: ${r.operations_synced} shop(s), ${r.products_upserted} products`)
      } else if (key === 'droptop_usage') {
        const r = await runDroptopSync(companyId, { mode: 'usage', daysBack: 1, logDailyActivity: true })
        toast.success(`Droptop usage: ${r.operations_synced} shop(s), ${r.products_upserted} products`)
      } else if (key === 'droptop_purchase_orders') {
        const r = await runDroptopPurchaseOrderSync({ daysBack: 180 })
        toast.success(`Droptop POs: ${r.locations_synced} shop(s), ${r.pos_upserted} POs, ${r.items_written} line items`)
      } else if (key === 'automated_checks') {
        const { data, error } = await supabase.functions.invoke('run-automated-checks', { body: {} })
        if (error) throw new Error(error.message)
        if (data?.error) throw new Error(data.error)
        toast.success(`Automated Checks: ${data.created} new exception${data.created === 1 ? '' : 's'} flagged (${data.checked} anomal${data.checked === 1 ? 'y' : 'ies'} found)`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setRunning(null)
      load()
    }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  if (rows === null) return <div className="py-8"><SbLoader /></div>

  const ordered = [...rows].sort((a, b) => CONNECTION_ORDER.indexOf(a.connection_key) - CONNECTION_ORDER.indexOf(b.connection_key))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Data Connections</h2>
          <p className="text-xs text-inky mt-0.5">
            Run any sync now, or turn on automation and set how often (or what time of day) it runs — no Supabase-side
            cron editing needed.
          </p>
        </div>
        <div className="w-56">
          <Select
            label="Timezone for daily times"
            options={TIMEZONE_OPTIONS}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ordered.map((row) => {
          const meta = CONNECTION_META[row.connection_key] ?? { label: row.connection_key, description: '' }
          return (
            <Card key={row.id}>
              <CardHeader className="flex items-center justify-between">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">{meta.label}</span>
                <Badge color={statusColor(row.last_run_status)}>
                  {row.last_run_status ?? 'never run'}
                </Badge>
              </CardHeader>
              <CardBody className="flex flex-col gap-3">
                <p className="text-[11px] font-mono text-inky/60">{meta.description}</p>

                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Automate</span>
                  <Toggle
                    checked={row.enabled}
                    onChange={(v) => saveRow(row, { enabled: v })}
                    color="green" size="sm" label={row.enabled ? 'On' : 'Off'}
                  />
                </div>

                <div className={row.enabled ? '' : 'opacity-40 pointer-events-none'}>
                  <div className="flex gap-1 mb-2">
                    {(['interval', 'daily'] as const).map((m) => (
                      <button key={m} onClick={() => saveRow(row, { schedule_mode: m })}
                        className={['flex-1 px-2 py-1 rounded border text-xs font-mono transition-colors',
                          row.schedule_mode === m ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
                        {m === 'interval' ? 'Every N minutes' : `Daily at (${timezone.split('/').pop()?.replace('_', ' ')})`}
                      </button>
                    ))}
                  </div>
                  {row.schedule_mode === 'interval' ? (
                    <input
                      type="number" min={5}
                      defaultValue={row.interval_minutes ?? ''}
                      onBlur={(e) => { const v = Number(e.target.value); if (v > 0) saveRow(row, { interval_minutes: v }) }}
                      placeholder="e.g. 240"
                      className={`${fieldCls} w-full`}
                    />
                  ) : (
                    <input
                      type="time"
                      defaultValue={row.daily_time ?? ''}
                      onBlur={(e) => e.target.value && saveRow(row, { daily_time: e.target.value })}
                      className={`${fieldCls} w-full`}
                    />
                  )}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-navy/10">
                  <span className="text-[10px] font-mono text-inky/60">
                    {row.last_run_at ? `Last run ${formatInTz(row.last_run_at, timezone)}` : 'Never run'}
                    {saving === row.id && ' · saving…'}
                  </span>
                  <Button size="sm" loading={running === row.connection_key} onClick={() => runNow(row.connection_key)}>
                    Run Now
                  </Button>
                </div>
                {row.last_run_status === 'error' && row.last_run_message && (
                  <p className="text-[11px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-2 py-1">
                    {row.last_run_message}
                  </p>
                )}
              </CardBody>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
