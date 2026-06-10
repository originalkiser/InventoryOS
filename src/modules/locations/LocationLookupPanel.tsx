import { useEffect, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Badge } from '@/components/ui'
import type { Location } from '@/types'

const AVAILABLE_FIELDS: { key: keyof Location; label: string }[] = [
  { key: 'location_code', label: 'Code' },
  { key: 'name', label: 'Name' },
  { key: 'region', label: 'Region' },
  { key: 'active', label: 'Active' },
  { key: 'metadata', label: 'Metadata' },
]

const col = createColumnHelper<Location>()

interface LocationLookupPanelProps {
  onClose: () => void
}

export function LocationLookupPanel({ onClose }: LocationLookupPanelProps) {
  const { profile } = useAuthStore()
  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [visibleFields, setVisibleFields] = useState<Set<string>>(
    new Set(['location_code', 'name', 'region', 'active'])
  )

  useEffect(() => {
    if (!profile?.company_id) return
    setLoading(true)
    supabase
      .from('locations')
      .select('*')
      .eq('company_id', profile.company_id)
      .then(({ data }) => {
        setLocations(data ?? [])
        setLoading(false)
      })
  }, [profile?.company_id])

  const columns = [
    ...(visibleFields.has('location_code') ? [col.accessor('location_code', { header: 'Code' })] : []),
    ...(visibleFields.has('name') ? [col.accessor('name', { header: 'Name' })] : []),
    ...(visibleFields.has('region') ? [col.accessor('region', { header: 'Region', cell: (i) => i.getValue() ?? '—' })] : []),
    ...(visibleFields.has('active') ? [col.accessor('active', { header: 'Active', cell: (i) => (
      <Badge color={i.getValue() ? 'green' : 'gray'}>{i.getValue() ? 'Active' : 'Inactive'}</Badge>
    ) })] : []),
  ]

  const { table, globalFilter, setGlobalFilter } = useTable(locations, columns)

  function toggleField(key: string) {
    setVisibleFields((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] z-40 flex flex-col bg-[#161820] border-l border-[#2a2d3e] shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2d3e]">
        <span className="text-xs font-mono font-semibold text-[#ffb300] uppercase tracking-wide">
          Location Lookup
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className={['p-1.5 rounded transition-colors', settingsOpen ? 'text-[#ffb300]' : 'text-gray-500 hover:text-white'].join(' ')}
            title="Configure columns"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
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

      {/* Field settings */}
      {settingsOpen && (
        <div className="px-4 py-3 border-b border-[#2a2d3e] bg-[#0f1117]">
          <p className="text-xs text-gray-500 font-mono mb-2">Visible columns:</p>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleFields.has(f.key)}
                  onChange={() => toggleField(f.key)}
                  className="accent-[#ffb300]"
                />
                <span className="text-xs font-mono text-gray-300">{f.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename="locations.csv"
          exportData={locations}
          loading={loading}
        />

        {/* Pill callouts placeholder */}
        <div className="mt-4">
          <p className="text-xs text-gray-600 font-mono mb-2">Location pills</p>
          <div className="flex flex-wrap gap-2">
            <button className="px-2 py-1 border border-dashed border-[#2a2d3e] rounded text-xs text-gray-600 hover:border-[#ffb300]/40 hover:text-[#ffb300] transition-colors font-mono">
              + Add pill
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
