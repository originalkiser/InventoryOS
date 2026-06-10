import { useState } from 'react'
import { Button, Input, Select } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'
import { format } from 'date-fns'

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
]

interface DataSourceLinkerProps {
  configType: string
  existingLink?: {
    id: string
    source_type: SourceType
    url: string
    refresh_interval_minutes: number | null
    last_synced_at: string | null
  } | null
  onSaved?: () => void
}

export function DataSourceLinker({ configType, existingLink, onSaved }: DataSourceLinkerProps) {
  const { profile } = useAuthStore()
  const [sourceType, setSourceType] = useState<SourceType>(existingLink?.source_type ?? 'api')
  const [url, setUrl] = useState(existingLink?.url ?? '')
  const [refreshInterval, setRefreshInterval] = useState(
    existingLink?.refresh_interval_minutes?.toString() ?? ''
  )
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

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

  async function save() {
    if (!url.trim() || !profile?.company_id) return
    setSaving(true)
    try {
      const payload = {
        company_id: profile.company_id,
        config_type: configType,
        source_type: sourceType,
        url: url.trim(),
        refresh_interval_minutes: refreshInterval ? parseInt(refreshInterval) : null,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      if (existingLink?.id) {
        await sb.from('data_source_links').update(payload).eq('id', existingLink.id)
      } else {
        await sb.from('data_source_links').insert(payload)
      }
      toast.success('Data source saved')
      onSaved?.()
    } catch {
      toast.error('Failed to save data source')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 border border-[#2a2d3e] rounded-lg bg-[#0f1117]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Live Data Source</span>
        {existingLink?.last_synced_at && (
          <span className="text-xs font-mono text-gray-600">
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
        <Select
          label="Refresh Interval"
          options={REFRESH_OPTIONS}
          value={refreshInterval}
          onChange={(e) => setRefreshInterval(e.target.value)}
        />
      </div>

      <Input
        label="URL / Link"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://..."
      />

      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" loading={testing} onClick={testConnection}>
          Test Connection
        </Button>
        <Button size="sm" loading={saving} onClick={save}>
          Save Source
        </Button>
      </div>
    </div>
  )
}
