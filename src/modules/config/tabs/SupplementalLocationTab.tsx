import { useMemo, useState } from 'react'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { Button, Select } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { ParseResult } from '@/lib/fileParser'
import { format } from 'date-fns'

interface Supplemental {
  id: string
  company_id: string
  location_id: string | null
  data: Record<string, string> | null
  updated_at: string
  last_change_source: string | null
}

// Slug a header into a stable data key. "RD Distributor" → "rd_distributor".
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function SupplementalLocationTab() {
  const { data, loading, importRows, remove, clearAll } = useConfigTab<Supplemental>('location_supplemental', 'core')
  const loc = useLocations()

  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [locCol, setLocCol] = useState('')
  const [importing, setImporting] = useState(false)

  // Union of data keys across all rows → dynamic table columns.
  const dataKeys = useMemo(() => {
    const s = new Set<string>()
    for (const r of data) for (const k of Object.keys(r.data ?? {})) s.add(k)
    return [...s].sort()
  }, [data])

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: Supplemental) => loc.labelOf(r.location_id), cell: (i: any) => loc.labelOf((i.row.original as Supplemental).location_id) },
    ...dataKeys.map((k) => ({
      id: `d_${k}`, header: titleCase(k),
      accessorFn: (r: Supplemental) => (r.data as any)?.[k] ?? '',
      cell: (i: any) => i.getValue() || '—',
    })),
    col('updated_at', 'Last Updated'),
    {
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => <button onClick={() => { if (confirm('Delete this supplemental row?')) remove((i.row.original as Supplemental).id) }} className="text-xs font-mono text-inky hover:underline">Delete</button>,
    },
  ], [dataKeys, loc, remove])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  async function doImport(mode: ImportMode) {
    if (!parsed || !locCol) return
    setImporting(true)
    const otherCols = parsed.headers.filter((h) => h !== locCol)
    // Merge into existing rows so a partial upload doesn't wipe other columns.
    const existingByLoc = new Map<string, Supplemental>()
    for (const r of data) if (r.location_id) existingByLoc.set(r.location_id, r)
    const payload = parsed.rows.map((row) => {
      const location_id = loc.resolveId(row[locCol] ?? '')
      const incoming: Record<string, string> = {}
      for (const h of otherCols) { const v = (row[h] ?? '').trim(); if (v) incoming[slug(h)] = v }
      const existing = location_id ? existingByLoc.get(location_id) : undefined
      return { location_id, data: { ...(existing?.data ?? {}), ...incoming } } as Partial<Supplemental>
    }).filter((r) => r.location_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => r.location_id ?? '' })
    setParsed(null); setLocCol(''); setImporting(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Supplemental Location Data</h2>
        <p className="text-xs text-inky mt-0.5">
          Upload extra columns keyed to a location (e.g. RD Distributor) without touching the main location list. Pick which
          column identifies the shop; every other column is stored and feeds the location lookups.
        </p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="supplemental_location_data.csv" exportData={data} loading={loading}
        actions={<ClearTableButton clearAll={clearAll} />}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload Supplemental File</h3>
        {!parsed ? (
          <FileUploadZone onParsed={(r) => { setParsed(r); setLocCol(r.headers[0] ?? '') }} label="Drop a CSV / Excel with a location column + any extra columns" />
        ) : (
          <div className="flex flex-col gap-3 border border-navy/30 rounded-lg p-4 bg-cream">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-inky uppercase tracking-wide">Location column</span>
              <div className="w-56">
                <Select options={parsed.headers.map((h) => ({ value: h, label: h }))} value={locCol} onChange={(e) => setLocCol(e.target.value)} />
              </div>
              <span className="text-[11px] font-mono text-inky/60">{parsed.headers.filter((h) => h !== locCol).length} data columns · {parsed.rows.length} rows</span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" loading={importing} onClick={() => doImport('merge')} disabled={!locCol}>Import (update)</Button>
              <Button size="sm" variant="secondary" onClick={() => setParsed(null)} disabled={importing}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  function col(field: keyof Supplemental, header: string) {
    return {
      id: field as string, header,
      accessorFn: (r: Supplemental) => r[field] as any,
      cell: (i: any) => {
        const r = i.row.original as Supplemental
        const s = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—'
      },
    }
  }
}
