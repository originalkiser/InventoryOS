import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useCustomFields } from '@/hooks/useCustomFields'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Badge } from '@/components/ui'
import type { Location } from '@/types'

const COLS_KEY = 'locationLookup.columns'
const PIN_KEY = 'locationLookup.open'

// Base columns always available; custom columns come from config.
const BASE_FIELDS: { key: string; label: string }[] = [
  { key: 'location_code', label: 'Code' },
  { key: 'name', label: 'Name' },
  { key: 'region', label: 'Region' },
  { key: 'active', label: 'Active' },
]
const DEFAULT_VISIBLE = ['location_code', 'name', 'region', 'active']

const col = createColumnHelper<Location>()

interface LocationLookupPanelProps {
  onClose: () => void
  pinned?: boolean
  onTogglePin?: () => void
}

export function LocationLookupPanel({ onClose, pinned, onTogglePin }: LocationLookupPanelProps) {
  const { profile } = useAuthStore()
  const { active: customFields } = useCustomFields('locations')
  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [visibleFields, setVisibleFields] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null')
      if (Array.isArray(saved)) return new Set(saved)
    } catch { /* ignore */ }
    return new Set(DEFAULT_VISIBLE)
  })

  useEffect(() => {
    if (!profile?.company_id) return
    setLoading(true)
    supabase.from('locations').select('*').eq('company_id', profile.company_id).order('location_code')
      .then(({ data }) => { setLocations((data ?? []) as Location[]); setLoading(false) })
  }, [profile?.company_id])

  // Persist column choices
  useEffect(() => {
    localStorage.setItem(COLS_KEY, JSON.stringify(Array.from(visibleFields)))
  }, [visibleFields])

  const availableFields = useMemo(
    () => [...BASE_FIELDS, ...customFields.map((f) => ({ key: f.field_key, label: f.label }))],
    [customFields]
  )

  const columns = useMemo(() => {
    const cols: any[] = []
    if (visibleFields.has('location_code')) cols.push(col.accessor('location_code', { header: 'Code' }))
    if (visibleFields.has('name')) cols.push(col.accessor('name', { header: 'Name' }))
    if (visibleFields.has('region')) cols.push(col.accessor('region', { header: 'Region', cell: (i) => i.getValue() ?? '—' }))
    if (visibleFields.has('active')) cols.push(col.accessor('active', { header: 'Active', cell: (i) => <Badge color={i.getValue() ? 'green' : 'gray'}>{i.getValue() ? 'Active' : 'Inactive'}</Badge> }))
    for (const f of customFields) {
      if (!visibleFields.has(f.field_key)) continue
      cols.push({ id: `cf_${f.field_key}`, header: f.label, accessorFn: (r: Location) => (r.metadata as any)?.[f.field_key] ?? '', cell: (i: any) => i.getValue() || '—' })
    }
    return cols
  }, [visibleFields, customFields])

  const { table, globalFilter, setGlobalFilter } = useTable(locations, columns)

  function toggleField(key: string) {
    setVisibleFields((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] z-40 flex flex-col bg-[#161820] border-l border-[#2a2d3e] shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2d3e]">
        <span className="text-xs font-mono font-semibold text-[#ffb300] uppercase tracking-wide">Location Lookup</span>
        <div className="flex items-center gap-2">
          {onTogglePin && (
            <button onClick={onTogglePin} title={pinned ? 'Unpin (close on navigation)' : 'Pin (stay open)'}
              className={['p-1.5 rounded transition-colors', pinned ? 'text-[#ffb300]' : 'text-gray-500 hover:text-white'].join(' ')}>
              <svg className="w-4 h-4" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5l5 5m-5-5l9-1-1 9m-3-3l-5 5" />
              </svg>
            </button>
          )}
          <button onClick={() => setSettingsOpen((v) => !v)}
            className={['p-1.5 rounded transition-colors', settingsOpen ? 'text-[#ffb300]' : 'text-gray-500 hover:text-white'].join(' ')}
            title="Configure columns">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors p-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="px-4 py-3 border-b border-[#2a2d3e] bg-[#0f1117]">
          <p className="text-xs text-gray-500 font-mono mb-2">Visible columns (from your Location config):</p>
          <div className="flex flex-wrap gap-2">
            {availableFields.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={visibleFields.has(f.key)} onChange={() => toggleField(f.key)} className="accent-[#ffb300]" />
                <span className="text-xs font-mono text-gray-300">{f.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
          exportFilename="locations.csv" exportData={locations} loading={loading} />
      </div>
    </div>
  )
}

export { PIN_KEY }
