import { useEffect, useMemo, useState, useCallback } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Select, Input, Combobox, Toggle } from '@/components/ui'
import { locationLabel, locationOptions } from './countsShared'
import type { Location, RecountRequest } from '@/types'
import type { ComboboxOption } from '@/components/ui'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const SLOTS = 10

type Status = 'open' | 'in_progress' | 'complete'

function deriveStatus(flags: boolean[], dates: (string | null)[]): Status {
  const populated = flags.map((f, i) => f || !!dates[i])
  if (!populated.some(Boolean)) return 'open'
  const allPopulatedYes = populated.every((p, i) => !p || flags[i])
  return allPopulatedYes ? 'complete' : 'in_progress'
}

const statusColor = (s: Status) => (s === 'complete' ? 'green' : s === 'in_progress' ? 'amber' : 'magenta')

interface RecountRow extends RecountRequest {
  location_label: string
  status: Status
  completed_count: number
  populated_count: number
}

const col = createColumnHelper<RecountRow>()

export function RecountsTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const myName = profile?.full_name ?? 'Someone'
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [requests, setRequests] = useState<RecountRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<RecountRequest | 'new' | null>(null)

  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const loadRequests = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const { data, error } = await sb
      .from('recount_requests')
      .select('*')
      .eq('company_id', companyId)
      .filter('recount_fields->>count_month', 'eq', countMonth)
      .order('created_at', { ascending: false })
    if (error) toast.error('Failed to load recounts')
    else setRequests((data ?? []) as RecountRequest[])
    setLoading(false)
  }, [companyId, countMonth])

  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      const { data } = await (supabase as any).from('locations').select('*').eq('company_id', companyId).order('location_code')
      setLocations((data ?? []) as Location[])
    })()
  }, [companyId])

  useEffect(() => { loadRequests() }, [loadRequests])

  // Realtime — toast on edits by others, reload on any change
  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('recounts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recount_requests', filter: `company_id=eq.${companyId}` },
        (payload) => {
          const row: any = payload.new ?? payload.old
          const editor = row?.recount_fields?.updated_by_name
          if (editor && editor !== myName) {
            toast(`Recount for ${locationLabel(row.location_id, locations)} updated by ${editor}`, { icon: '🔁' })
          }
          loadRequests()
        })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, loadRequests, locations, myName])

  // Distinct recount types for the filter + combobox
  const typeOptions: ComboboxOption[] = useMemo(() => {
    const set = new Set<string>()
    for (const r of requests) if (r.recount_type) set.add(r.recount_type)
    return Array.from(set).sort().map((t) => ({ value: t, label: t }))
  }, [requests])

  const rows: RecountRow[] = useMemo(() => requests.map((r) => {
    const flags = (r.completed_flags ?? []) as boolean[]
    const dates = (r.completed_dates ?? []) as (string | null)[]
    const populated = flags.map((f, i) => f || !!dates[i])
    return {
      ...r,
      location_label: locationLabel(r.location_id, locations),
      status: deriveStatus(flags, dates),
      completed_count: flags.filter(Boolean).length,
      populated_count: populated.filter(Boolean).length,
    }
  }), [requests, locations])

  const filteredRows = rows.filter((r) =>
    (!typeFilter || r.recount_type === typeFilter) &&
    (!statusFilter || r.status === statusFilter)
  )

  const columns = useMemo(() => [
    col.accessor('location_label', { header: 'Location' }),
    col.accessor('recount_type', { header: 'Type', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('requested_products', {
      header: 'Products',
      enableSorting: false,
      cell: (i) => {
        const p = (i.getValue() ?? []) as string[]
        return p.length ? p.join(', ') : <span className="text-gray-600">—</span>
      },
    }),
    col.accessor('request_date', {
      header: 'Requested',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—'),
    }),
    col.accessor('completed_count', {
      header: 'Completed',
      cell: (i) => <span className="text-gray-300">{i.row.original.completed_count} / {i.row.original.populated_count || 0}</span>,
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => <Badge color={statusColor(i.getValue())}>{i.getValue().replace('_', ' ')}</Badge>,
    }),
    col.display({
      id: 'edit',
      header: '',
      cell: (i) => (
        <button onClick={() => setEditing(i.row.original)} className="text-xs font-mono text-[#00e5ff] hover:underline">
          Edit
        </button>
      ),
    }),
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(filteredRows, columns)

  const exportRows = useMemo(() => filteredRows.map((r) => ({
    location: r.location_label,
    recount_type: r.recount_type ?? '',
    products: (r.requested_products ?? []).join(' | '),
    request_date: r.request_date ?? '',
    status: r.status,
    completed: `${r.completed_count}/${r.populated_count}`,
  })), [filteredRows])

  if (!companyId) return <div className="text-xs font-mono text-gray-500 py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-44">
          <Select
            label="Filter — Type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[{ value: '', label: 'All types' }, ...typeOptions.map((t) => ({ value: t.value, label: t.label }))]}
          />
        </div>
        <div className="w-40">
          <Select
            label="Filter — Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'open', label: 'Open' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'complete', label: 'Complete' },
            ]}
          />
        </div>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={`recounts_${countMonth}.csv`}
        exportData={exportRows}
        loading={loading}
        actions={<Button size="sm" onClick={() => setEditing('new')}>+ Add Recount</Button>}
      />

      {editing && (
        <RecountSlideOver
          companyId={companyId}
          countMonth={countMonth}
          editorName={myName}
          locations={locations}
          typeOptions={typeOptions}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadRequests() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slide-over editor
// ---------------------------------------------------------------------------
function RecountSlideOver({
  companyId, countMonth, editorName, locations, typeOptions, existing, onClose, onSaved,
}: {
  companyId: string
  countMonth: string
  editorName: string
  locations: Location[]
  typeOptions: ComboboxOption[]
  existing: RecountRequest | null
  onClose: () => void
  onSaved: () => void
}) {
  const [locationId, setLocationId] = useState(existing?.location_id ?? '')
  const [recountType, setRecountType] = useState(existing?.recount_type ?? '')
  const [products, setProducts] = useState<string[]>(existing?.requested_products ?? [])
  const [requestDate, setRequestDate] = useState(existing?.request_date ?? format(new Date(), 'yyyy-MM-dd'))
  const [flags, setFlags] = useState<boolean[]>(padArr(existing?.completed_flags as boolean[] | null, false))
  const [dates, setDates] = useState<(string | null)[]>(padArr(existing?.completed_dates as (string | null)[] | null, null))
  const [saving, setSaving] = useState(false)

  const [types, setTypes] = useState<ComboboxOption[]>(typeOptions)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const status = deriveStatus(flags, dates)

  function setFlag(i: number, v: boolean) {
    setFlags((prev) => prev.map((f, idx) => (idx === i ? v : f)))
  }
  function setDate(i: number, v: string) {
    setDates((prev) => prev.map((d, idx) => (idx === i ? (v || null) : d)))
  }

  async function save() {
    if (!locationId) { toast.error('Location is required'); return }
    setSaving(true)
    const sb = supabase as any
    const recount_fields = {
      ...(existing?.recount_fields as Record<string, unknown> ?? {}),
      count_month: countMonth,
      source: (existing?.recount_fields as any)?.source ?? 'manual',
      updated_by_name: editorName,
    }
    const payload = {
      company_id: companyId,
      location_id: locationId,
      recount_type: recountType || null,
      requested_products: products,
      request_date: requestDate || null,
      completed_flags: flags,
      completed_dates: dates,
      recount_status: status,
      recount_fields,
      updated_at: new Date().toISOString(),
    }
    const { error } = existing
      ? await sb.from('recount_requests').update(payload).eq('id', existing.id)
      : await sb.from('recount_requests').insert(payload)
    setSaving(false)
    if (error) toast.error(error.message)
    else { toast.success(existing ? 'Recount updated' : 'Recount added'); onSaved() }
  }

  async function remove() {
    if (!existing) return
    if (!confirm('Delete this recount request?')) return
    const { error } = await (supabase as any).from('recount_requests').delete().eq('id', existing.id)
    if (error) toast.error(error.message)
    else { toast.success('Recount deleted'); onSaved() }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="relative w-full max-w-lg h-full bg-[#161820] border-l border-[#2a2d3e] shadow-2xl overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2d3e] sticky top-0 bg-[#161820] z-10">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
              {existing ? 'Edit Recount' : 'Add Recount'}
            </h2>
            <Badge color={statusColor(status)}>{status.replace('_', ' ')}</Badge>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 flex flex-col gap-4">
          <Combobox
            label="Location *"
            options={locationOptions(locations)}
            value={locationId}
            onChange={(v) => setLocationId(v)}
            placeholder="Select location"
          />

          <Combobox
            label="Recount Type"
            options={types}
            value={recountType}
            onChange={(v) => setRecountType(v)}
            placeholder="Select or type a new type"
            allowCreate
            onCreateOption={(label) => {
              const opt = { value: label, label }
              setTypes((prev) => [...prev, opt])
              return opt
            }}
          />

          <TagInput label="Products Requested" value={products} onChange={setProducts} placeholder="Type a product and press Enter" />

          <Input label="Request Date" type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)} />

          <div className="flex flex-col gap-2">
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Completion Slots</span>
            <p className="text-xs font-mono text-gray-600">Status becomes <span className="text-[#39ff14]">complete</span> when every filled slot is marked Yes.</p>
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: SLOTS }).map((_, i) => (
                <div key={i} className="grid grid-cols-[1.5rem_auto_1fr] items-center gap-2">
                  <span className="text-xs font-mono text-gray-600">{i + 1}</span>
                  <Toggle checked={flags[i]} onChange={(v) => setFlag(i, v)} size="sm" color="green" label={flags[i] ? 'Yes' : 'No'} />
                  <input
                    type="date"
                    value={dates[i] ?? ''}
                    onChange={(e) => setDate(i, e.target.value)}
                    className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-[#00e5ff]"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-[#2a2d3e] sticky bottom-0 bg-[#161820]">
          <div>
            {existing && (
              <button onClick={remove} className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-500/30 rounded px-3 py-1.5 hover:bg-red-500/10">
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={save}>{existing ? 'Save Changes' : 'Add Recount'}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function padArr<T>(arr: T[] | null | undefined, fill: T): T[] {
  const base = arr ? [...arr] : []
  while (base.length < SLOTS) base.push(fill)
  return base.slice(0, SLOTS)
}

// ---------------------------------------------------------------------------
// Tag input
// ---------------------------------------------------------------------------
function TagInput({
  label, value, onChange, placeholder,
}: {
  label?: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const t = draft.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">{label}</label>}
      <div className="flex flex-wrap gap-1.5 p-2 bg-[#0f1117] border border-[#2a2d3e] rounded focus-within:border-[#00e5ff]">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-[#00e5ff]/10 text-[#00e5ff] border border-[#00e5ff]/30 rounded">
            {tag}
            <button onClick={() => onChange(value.filter((t) => t !== tag))} className="hover:text-white">×</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={commit}
          placeholder={value.length ? '' : placeholder}
          className="flex-1 min-w-[8rem] bg-transparent text-sm font-mono text-white placeholder-gray-600 focus:outline-none"
        />
      </div>
    </div>
  )
}
