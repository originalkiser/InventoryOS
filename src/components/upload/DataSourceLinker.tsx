import { useState } from 'react'
import { Button, Input, Select, Modal } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { parseFile } from '@/lib/fileParser'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import type { ColumnMapping } from '@/types'
import type { ImportMode } from '@/modules/config/useConfigTab'

type SourceType = 'api' | 'google_sheets' | 'onedrive' | 'sharepoint'

const SOURCE_OPTIONS = [
  { value: 'api', label: 'API Endpoint' },
  { value: 'google_sheets', label: 'Google Sheets' },
  { value: 'onedrive', label: 'OneDrive' },
  { value: 'sharepoint', label: 'SharePoint' },
]

const REFRESH_OPTIONS = [
  { value: '', label: 'Manual only' },
  { value: '15', label: 'Every 15 min' },
  { value: '30', label: 'Every 30 min' },
  { value: '60', label: 'Every hour' },
  { value: '120', label: 'Every 2 hours' },
  { value: 'custom', label: 'Custom interval…' },
  { value: 'scheduled', label: 'Scheduled time…' },
]

const PRESET_VALUES = new Set(['', '15', '30', '60', '120'])

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
]

interface RequiredField { name: string; label: string; required?: boolean }

export interface ExistingDataSource {
  id: string
  source_type: SourceType
  url: string
  refresh_interval_minutes: number | null
  last_synced_at: string | null
  schedule_cron?: string | null
}

interface DataSourceLinkerProps {
  configType: string
  existingLink?: ExistingDataSource | null
  requiredFields?: RequiredField[]
  onImport?: (rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) => void | Promise<void>
  onSaved?: () => void
}

function parseCron(cron: string): { time: string; days: number[] } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseInt(parts[0])
  const hour = parseInt(parts[1])
  if (isNaN(minute) || isNaN(hour)) return null
  const daysStr = parts[4]
  const days = daysStr === '*'
    ? [0, 1, 2, 3, 4, 5, 6]
    : daysStr.split(',').map(Number).filter((d) => !isNaN(d))
  return {
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    days,
  }
}

function buildCron(time: string, days: number[]): string {
  const [h, m] = time.split(':').map(Number)
  const sorted = [...days].sort((a, b) => a - b)
  const daysStr = sorted.length === 7 ? '*' : sorted.join(',')
  return `${isNaN(m) ? 0 : m} ${isNaN(h) ? 7 : h} * * ${daysStr}`
}

export function DataSourceLinker({ configType, existingLink, requiredFields, onImport, onSaved }: DataSourceLinkerProps) {
  const { profile } = useAuthStore()

  const existingMinutes = existingLink?.refresh_interval_minutes?.toString() ?? ''
  const isCustomExisting = !!existingMinutes && !PRESET_VALUES.has(existingMinutes)
  const parsedCron = existingLink?.schedule_cron ? parseCron(existingLink.schedule_cron) : null

  const [sourceType, setSourceType] = useState<SourceType>(existingLink?.source_type ?? 'api')
  const [url, setUrl] = useState(existingLink?.url ?? '')
  const [refreshInterval, setRefreshInterval] = useState(
    parsedCron ? 'scheduled' : (isCustomExisting ? 'custom' : existingMinutes)
  )
  const [customMinutes, setCustomMinutes] = useState(isCustomExisting ? existingMinutes : '')
  const [scheduleTime, setScheduleTime] = useState(parsedCron?.time ?? '07:30')
  const [scheduleDays, setScheduleDays] = useState<number[]>(parsedCron?.days ?? [1, 2, 3, 4, 5])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Fetch state — separate from save so errors persist visibly
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetchedRows, setFetchedRows] = useState<Record<string, string>[]>([])
  const [fetchedHeaders, setFetchedHeaders] = useState<string[]>([])

  const [mapOpen, setMapOpen] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importing, setImporting] = useState(false)

  const canMap = !!(requiredFields?.length && onImport)
  // Prefer typed value; fall back to the saved URL from DB
  const effectiveUrl = url.trim() || existingLink?.url || ''
  const isAuthRequired = sourceType === 'onedrive' || sourceType === 'sharepoint'

  function toggleDay(day: number) {
    setScheduleDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    )
  }

  async function doFetch(targetUrl: string) {
    setFetching(true)
    setFetchError(null)
    try {
      // Always route through Edge Function — avoids CORS on any source type.
      // useGraphApi=true adds Microsoft auth for OneDrive/SharePoint sharing URLs.
      const { data, error } = await supabase.functions.invoke('fetch-sharepoint-file', {
        body: { url: targetUrl, useGraphApi: isAuthRequired },
      })
      if (error) throw new Error(error.message)
      if (data?.error === 'credentials_not_configured') {
        throw new Error('credentials_not_configured')
      }
      if (data?.error) throw new Error(data.error)

      let file: File
      if (data?.isBase64 && data?.filename) {
        // Binary file (xlsx) returned as base64 — decode and reconstruct
        const binaryStr = atob(data.content)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        file = new File([bytes], data.filename)
      } else {
        const text: string = data?.content ?? ''
        if (!text.trim()) throw new Error('Response was empty — check the URL or source configuration')
        file = new File([text], 'live_data.csv', { type: 'text/csv' })
      }

      const result = await parseFile(file)
      if (!result.headers.length) throw new Error('No columns found in fetched data')
      setFetchedHeaders(result.headers)
      setFetchedRows(result.rows)
      setMapOpen(true)
    } catch (err: any) {
      const msg: string = err?.message ?? 'Unknown error'
      setFetchError(msg)
    } finally {
      setFetching(false)
    }
  }

  async function saveSource() {
    if (!url.trim() || !profile?.company_id) return
    setSaving(true)

    const minutesVal = refreshInterval === 'custom'
      ? (parseInt(customMinutes) || null)
      : (refreshInterval && refreshInterval !== 'scheduled' ? parseInt(refreshInterval) : null)

    const payload = {
      company_id: profile.company_id,
      config_type: configType,
      source_type: sourceType,
      url: url.trim(),
      refresh_interval_minutes: minutesVal,
    }
    const sb = supabase as any
    let saveError = false
    if (existingLink?.id) {
      const { error } = await sb.schema('inventory').from('data_source_links').update(payload).eq('id', existingLink.id)
      if (error) saveError = true
    } else {
      const { error } = await sb.schema('inventory').from('data_source_links').insert(payload)
      if (error) saveError = true
    }

    if (saveError) {
      toast.error('Failed to save data source')
      setSaving(false)
      return
    }

    toast.success('Data source saved')
    setSaved(true)
    onSaved?.()

    // best-effort: save schedule_cron (column may not exist until migration is applied)
    const cronVal = refreshInterval === 'scheduled' ? buildCron(scheduleTime, scheduleDays) : null
    sb.schema('inventory').from('data_source_links')
      .update({ schedule_cron: cronVal })
      .eq('company_id', profile.company_id)
      .eq('config_type', configType)
      .then(() => {})

    setSaving(false)
  }

  async function handleMapConfirm(mappings: ColumnMapping[]) {
    if (!onImport) return
    if (importMode === 'replace') {
      if (!window.confirm('Replace all: this deletes all existing rows and replaces with the fetched data. Continue?')) return
    }
    setImporting(true)
    await onImport(fetchedRows, mappings, importMode)
    setImporting(false)
    setMapOpen(false)
  }

  const cronPreview = refreshInterval === 'scheduled' && scheduleDays.length > 0
    ? (() => {
        const dayLabels = [...scheduleDays].sort((a, b) => a - b).map((d) => DAYS_OF_WEEK[d].label)
        return `Runs at ${scheduleTime} on ${dayLabels.join(', ')}`
      })()
    : null

  const isSaved = !!(existingLink?.id || saved)

  return (
    <>
      <div className="flex flex-col gap-4 p-4 border border-navy/30 rounded-lg bg-cream">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Live Data Source</span>
          {existingLink?.last_synced_at && (
            <span className="text-xs font-mono text-inky/70">
              Last synced: {format(new Date(existingLink.last_synced_at), 'MMM d, h:mm a')}
            </span>
          )}
        </div>

        {/* Config fields */}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Source Type"
            options={SOURCE_OPTIONS}
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as SourceType)}
          />
          <div className="flex flex-col gap-1.5">
            <Select
              label="Refresh Interval"
              options={REFRESH_OPTIONS}
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(e.target.value)}
            />
            {refreshInterval === 'custom' && (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="1"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  placeholder="Minutes"
                  className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
                />
                <span className="text-xs font-mono text-inky shrink-0">min</span>
              </div>
            )}
          </div>
        </div>

        {/* Scheduled time picker */}
        {refreshInterval === 'scheduled' && (
          <div className="flex flex-col gap-2 p-3 rounded border border-navy/20 bg-navy/5">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-inky shrink-0">Time</span>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-mono text-inky shrink-0">Days</span>
                {DAYS_OF_WEEK.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    className={[
                      'px-2 py-0.5 rounded text-xs font-mono border transition-colors',
                      scheduleDays.includes(d.value)
                        ? 'bg-sky/30 border-sky text-navy font-bold'
                        : 'bg-cream border-navy/20 text-inky hover:border-navy/40',
                    ].join(' ')}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            {cronPreview && <span className="text-xs font-mono text-inky/70">{cronPreview}</span>}
            {scheduleDays.length === 0 && (
              <span className="text-xs font-mono text-red-500">Select at least one day</span>
            )}
          </div>
        )}

        <Input
          label="URL / Link"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setSaved(false) }}
          placeholder="https://..."
        />

        {/* Save row */}
        <div className="flex gap-2 justify-end flex-wrap">
          <Button
            size="sm"
            loading={saving}
            onClick={saveSource}
            disabled={!url.trim() || (refreshInterval === 'scheduled' && scheduleDays.length === 0)}
          >
            {isSaved ? 'Update Source' : 'Save Source'}
          </Button>
        </div>

        {/* Fetch & Map section — always shown when canMap (ProductUsageTab and similar) */}
        {canMap && (
          <div className="border-t border-navy/20 pt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-mono text-inky uppercase tracking-wide">Column Mapping</span>
              {effectiveUrl && (
                <Button size="sm" loading={fetching} onClick={() => doFetch(effectiveUrl)}>
                  {fetching ? 'Fetching data…' : 'Fetch & Map Columns'}
                </Button>
              )}
            </div>

            {/* No URL yet */}
            {!effectiveUrl && (
              <p className="text-xs font-mono text-inky/60">Enter a URL above and save the source to enable fetching.</p>
            )}

            {/* Fetch loading indicator */}
            {fetching && (
              <div className="rounded bg-navy/5 border border-navy/10 px-3 py-2">
                <p className="text-xs font-mono text-inky animate-pulse">Connecting to data source…</p>
              </div>
            )}

            {/* Fetch error — persistent */}
            {fetchError && !fetching && (() => {
              const isCredsError = fetchError.startsWith('credentials_not_configured')
              return (
                <div className={isCredsError
                  ? 'rounded border border-navy/20 bg-navy/5 px-3 py-2 flex flex-col gap-1'
                  : 'rounded border border-red-200 bg-red-50 px-3 py-2 flex flex-col gap-1'
                }>
                  <span className={`text-xs font-mono font-bold ${isCredsError ? 'text-navy' : 'text-red-600'}`}>
                    {isCredsError ? 'Microsoft credentials not configured' : 'Fetch failed'}
                  </span>
                  <span className={`text-xs font-mono ${isCredsError ? 'text-inky' : 'text-red-500'}`}>
                    {isCredsError
                      ? 'A developer must add AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET to Supabase secrets and deploy the fetch-sharepoint-file Edge Function.'
                      : fetchError}
                  </span>
                </div>
              )
            })()}

            {/* Success preview (rows ready, mapper closed) */}
            {fetchedRows.length > 0 && !mapOpen && !fetching && !fetchError && (
              <div className="rounded bg-sky/10 border border-sky/30 px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-navy">
                  {fetchedRows.length.toLocaleString()} rows fetched · {fetchedHeaders.length} columns
                </span>
                <button
                  onClick={() => setMapOpen(true)}
                  className="text-xs font-mono text-inky underline hover:text-navy"
                >
                  Reopen mapper
                </button>
              </div>
            )}

            <p className="text-xs font-mono text-inky/60">
              {isAuthRequired
                ? 'Fetches via Microsoft Graph API (server-side) and opens a column-matching dialog.'
                : 'Fetches from the saved URL and opens a column-matching dialog to map source fields to this table.'}
            </p>
          </div>
        )}
      </div>

      {/* Column mapper modal */}
      <Modal open={mapOpen} onClose={() => setMapOpen(false)} title="Map Columns from Live Source" size="lg">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-inky uppercase tracking-wide">Import Mode</span>
            <div className="flex rounded border border-navy/30 overflow-hidden">
              <button
                onClick={() => setImportMode('merge')}
                className={['px-3 py-1 text-xs font-mono', importMode === 'merge' ? 'bg-sky/20 text-navy font-bold' : 'text-inky hover:text-navy'].join(' ')}
              >
                Update changes only
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={['px-3 py-1 text-xs font-mono', importMode === 'replace' ? 'bg-red-500/15 text-red-400' : 'text-inky hover:text-navy'].join(' ')}
              >
                Replace all
              </button>
            </div>
            <span className="text-xs font-mono text-inky/60 ml-auto">
              {fetchedRows.length.toLocaleString()} rows · {fetchedHeaders.length} columns
            </span>
          </div>

          <ColumnMapper
            headers={fetchedHeaders}
            requiredFields={requiredFields ?? []}
            rememberKey={`live_source.${configType}`}
            previewRows={fetchedRows.slice(0, 5)}
            onConfirm={handleMapConfirm}
            onCancel={() => setMapOpen(false)}
          />
          {importing && <p className="text-xs font-mono text-inky">Importing…</p>}
        </div>
      </Modal>
    </>
  )
}
