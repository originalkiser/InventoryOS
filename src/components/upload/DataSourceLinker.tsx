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
  { value: 'custom', label: 'Custom…' },
]

const PRESET_VALUES = new Set(['', '15', '30', '60', '120'])

interface RequiredField { name: string; label: string; required?: boolean }

export interface ExistingDataSource {
  id: string
  source_type: SourceType
  url: string
  refresh_interval_minutes: number | null
  last_synced_at: string | null
}

interface DataSourceLinkerProps {
  configType: string
  existingLink?: ExistingDataSource | null
  requiredFields?: RequiredField[]
  onImport?: (rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) => void | Promise<void>
  onSaved?: () => void
}

export function DataSourceLinker({ configType, existingLink, requiredFields, onImport, onSaved }: DataSourceLinkerProps) {
  const { profile } = useAuthStore()

  const existingMinutes = existingLink?.refresh_interval_minutes?.toString() ?? ''
  const isCustomExisting = !!existingMinutes && !PRESET_VALUES.has(existingMinutes)

  const [sourceType, setSourceType] = useState<SourceType>(existingLink?.source_type ?? 'api')
  const [url, setUrl] = useState(existingLink?.url ?? '')
  const [refreshInterval, setRefreshInterval] = useState(isCustomExisting ? 'custom' : existingMinutes)
  const [customMinutes, setCustomMinutes] = useState(isCustomExisting ? existingMinutes : '')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const [mapOpen, setMapOpen] = useState(false)
  const [fetchedRows, setFetchedRows] = useState<Record<string, string>[]>([])
  const [fetchedHeaders, setFetchedHeaders] = useState<string[]>([])
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importing, setImporting] = useState(false)

  const canMap = !!(requiredFields?.length && onImport)

  async function testConnection() {
    if (!url.trim()) return
    setTesting(true)
    try {
      const res = await fetch(url, { method: 'HEAD', mode: 'no-cors' })
      toast.success('Connection reachable')
      void res
    } catch {
      toast.error('Could not reach URL — check CORS or credentials')
    } finally {
      setTesting(false)
    }
  }

  async function fetchAndOpenMapper(targetUrl: string) {
    setSaving(true)
    try {
      const response = await fetch(targetUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const blob = new Blob([text], { type: 'text/csv' })
      const file = new File([blob], 'live_data.csv', { type: 'text/csv' })
      const result = await parseFile(file)
      setFetchedHeaders(result.headers)
      setFetchedRows(result.rows)
      setMapOpen(true)
    } catch {
      toast.error('Could not fetch data from URL — check CORS settings on the source')
    } finally {
      setSaving(false)
    }
  }

  async function saveAndFetch() {
    if (!url.trim() || !profile?.company_id) return
    setSaving(true)

    const minutesVal = refreshInterval === 'custom'
      ? (parseInt(customMinutes) || null)
      : (refreshInterval ? parseInt(refreshInterval) : null)

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
    onSaved?.()
    setSaving(false)

    if (canMap) {
      await fetchAndOpenMapper(url.trim())
    }
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

  return (
    <>
      <div className="flex flex-col gap-4 p-4 border border-navy/30 rounded-lg bg-cream">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Live Data Source</span>
          {existingLink?.last_synced_at && (
            <span className="text-xs font-mono text-inky/70">
              Last synced: {format(new Date(existingLink.last_synced_at), 'MMM d, h:mm a')}
            </span>
          )}
        </div>

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

        <Input
          label="URL / Link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />

        <div className="flex gap-2 justify-end flex-wrap">
          <Button variant="secondary" size="sm" loading={testing} onClick={testConnection}>
            Test Connection
          </Button>
          {existingLink?.url && canMap && (
            <Button variant="secondary" size="sm" loading={saving} onClick={() => fetchAndOpenMapper(existingLink.url)}>
              Fetch & Map
            </Button>
          )}
          <Button size="sm" loading={saving} onClick={saveAndFetch}>
            {canMap ? 'Save & Fetch' : 'Save Source'}
          </Button>
        </div>
      </div>

      <Modal open={mapOpen} onClose={() => setMapOpen(false)} title="Map Columns from Live Source" size="lg">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
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
