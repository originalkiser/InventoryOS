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

type Status = 'open' | 'complete'

const RECOUNT_TYPE_OPTIONS: ComboboxOption[] = [
  { value: 'Oil Recount', label: 'Oil Recount' },
  { value: 'Partial Recount Products', label: 'Partial Recount Products' },
]

function deriveStatus(flags: boolean[]): Status {
  return flags[0] ? 'complete' : 'open'
}

const statusColor = (s: Status) => (s === 'complete' ? 'green' : 'magenta')

function fieldsOf(r: RecountRequest): Record<string, any> {
  return (r.recount_fields ?? {}) as Record<string, any>
}

interface RecountRow extends RecountRequest {
  location_label: string
  status: Status
  am_name: string
  recount_reason: string
  completed_date: string | null
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

  const rows: RecountRow[] = useMemo(() => requests.map((r) => {
    const flags = (r.completed_flags ?? []) as boolean[]
    const dates = (r.completed_dates ?? []) as (string | null)[]
    const f = fieldsOf(r)
    return {
      ...r,
      location_label: locationLabel(r.location_id, locations),
      status: deriveStatus(flags),
      am_name: f.am_name ?? '',
      recount_reason: f.recount_reason ?? '',
      completed_date: dates[0] ?? null,
    }
  }), [requests, locations])

  const filteredRows = rows.filter((r) =>
    (!typeFilter || r.recount_type === typeFilter) &&
    (!statusFilter || r.status === statusFilter)
  )

  const columns = useMemo(() => [
    col.accessor('location_label', { header: 'Location' }),
    col.accessor('recount_type', { header: 'Type', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('am_name', { header: 'AM', cell: (i) => i.getValue() || <span className="text-inky/50">—</span> }),
    col.accessor('recount_reason', { header: 'Reason', cell: (i) => i.getValue() || <span className="text-inky/50">—</span> }),
    col.accessor('requested_products', {
      header: 'Products',
      enableSorting: false,
      cell: (i) => {
        const p = (i.getValue() ?? []) as string[]
        return p.length
          ? <span className="text-xs truncate max-w-[200px] block">{p.join(', ')}</span>
          : <span className="text-inky/50">—</span>
      },
    }),
    col.accessor('request_date', {
      header: 'Requested',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—'),
    }),
    col.accessor('completed_date', {
      header: 'Completed',
      cell: (i) => {
        const d = i.getValue()
        return d ? format(new Date(d), 'MMM d, yyyy') : <span className="text-inky/50">Pending</span>
      },
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => <Badge color={statusColor(i.getValue())}>{i.getValue()}</Badge>,
    }),
    col.display({
      id: 'edit',
      header: '',
      cell: (i) => (
        <button onClick={() => setEditing(i.row.original)} className="text-xs font-mono text-inky hover:underline">
          Edit
        </button>
      ),
    }),
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(filteredRows, columns)

  const exportRows = useMemo(() => filteredRows.map((r) => ({
    location: r.location_label,
    recount_type: r.recount_type ?? '',
    am: r.am_name,
    rdo: (fieldsOf(r) as any).rdo_name ?? '',
    recount_reason: r.recount_reason,
    products: (r.requested_products ?? []).join(' | '),
    request_date: r.request_date ?? '',
    completed_date: r.completed_date ?? '',
    notes: (fieldsOf(r) as any).completion_notes ?? '',
    status: r.status,
  })), [filteredRows])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-52">
          <Select
            label="Filter — Type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { value: '', label: 'All types' },
              { value: 'Oil Recount', label: 'Oil Recount' },
              { value: 'Partial Recount Products', label: 'Partial Recount Products' },
            ]}
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
  companyId, countMonth, editorName, locations, existing, onClose, onSaved,
}: {
  companyId: string
  countMonth: string
  editorName: string
  locations: Location[]
  existing: RecountRequest | null
  onClose: () => void
  onSaved: () => void
}) {
  const f = existing ? fieldsOf(existing) : {}

  const [locationId, setLocationId] = useState(existing?.location_id ?? '')
  const [recountType, setRecountType] = useState(existing?.recount_type ?? '')
  const [amName, setAmName] = useState(f.am_name ?? '')
  const [rdoName, setRdoName] = useState(f.rdo_name ?? '')
  const [recountReason, setRecountReason] = useState(f.recount_reason ?? '')
  const [products, setProducts] = useState<string[]>(existing?.requested_products ?? [])
  const [requestDate, setRequestDate] = useState(existing?.request_date ?? format(new Date(), 'yyyy-MM-dd'))
  const [completed, setCompleted] = useState((existing?.completed_flags as boolean[] | null)?.[0] ?? false)
  const [completedDate, setCompletedDate] = useState(
    (existing?.completed_dates as (string | null)[] | null)?.[0] ?? ''
  )
  const [completionNotes, setCompletionNotes] = useState(f.completion_notes ?? '')
  const [saving, setSaving] = useState(false)

  const status: Status = completed ? 'complete' : 'open'
  const isPartial = recountType === 'Partial Recount Products'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function save() {
    if (!locationId) { toast.error('Location is required'); return }
    setSaving(true)
    const sb = supabase as any
    const recount_fields = {
      ...(existing?.recount_fields as Record<string, unknown> ?? {}),
      count_month: countMonth,
      source: (existing?.recount_fields as any)?.source ?? 'manual',
      updated_by_name: editorName,
      am_name: amName.trim() || null,
      rdo_name: rdoName.trim() || null,
      recount_reason: recountReason.trim() || null,
      completion_notes: completionNotes.trim() || null,
      flags: (existing?.recount_fields as any)?.flags ?? undefined,
    }
    const payload = {
      company_id: companyId,
      location_id: locationId,
      recount_type: recountType || null,
      requested_products: products,
      request_date: requestDate || null,
      completed_flags: [completed],
      completed_dates: [completedDate || null],
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
      <div className="relative w-full max-w-lg h-full bg-cream border-l border-navy/30 shadow-2xl overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy/30 sticky top-0 bg-navy z-10">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-mono font-semibold text-cream uppercase tracking-wide">
              {existing ? 'Edit Recount' : 'Add Recount'}
            </h2>
            <Badge color={statusColor(status)}>{status}</Badge>
          </div>
          <button onClick={onClose} className="text-cream/70 hover:text-cream">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          {/* Request details */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest border-b border-navy/10 pb-1">Recount Details</p>

            <Combobox
              label="Location *"
              options={locationOptions(locations)}
              value={locationId}
              onChange={(v) => setLocationId(v)}
              placeholder="Select location"
            />

            <Combobox
              label="Recount Type"
              options={RECOUNT_TYPE_OPTIONS}
              value={recountType}
              onChange={(v) => setRecountType(v)}
              placeholder="Oil Recount or Partial Recount Products"
              allowCreate
              onCreateOption={(label) => ({ value: label, label })}
            />

            <Input
              label="Recount Reason"
              value={recountReason}
              onChange={(e) => setRecountReason(e.target.value)}
              placeholder="e.g. Unexpected ending balance"
            />

            <Input label="Request Date" type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)} />
          </div>

          {/* Personnel */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest border-b border-navy/10 pb-1">Personnel</p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Area Manager"
                value={amName}
                onChange={(e) => setAmName(e.target.value)}
                placeholder="AM name"
              />
              <Input
                label="RDO"
                value={rdoName}
                onChange={(e) => setRdoName(e.target.value)}
                placeholder="RDO name"
              />
            </div>
          </div>

          {/* Products (shown for both types but required for Partial) */}
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest border-b border-navy/10 pb-1">
              {isPartial ? 'Products to Recount' : 'Products (optional)'}
            </p>
            <TagInput
              label={isPartial ? 'Product + Qty *' : 'Products'}
              value={products}
              onChange={setProducts}
              placeholder={isPartial ? 'e.g. DSL-0W20BB (430)' : 'Product code or name'}
            />
            {isPartial && (
              <p className="text-[10px] font-mono text-inky/50 leading-relaxed pl-2 border-l-2 border-[#00e5ff]/20">
                Include quantity in parentheses: <span className="text-inky/80">DSL-0W20BB (430)</span>. Press Enter after each product.
              </p>
            )}
          </div>

          {/* AM Completion */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest border-b border-navy/10 pb-1">AM Completion</p>
            <div className="flex items-center gap-3">
              <Toggle checked={completed} onChange={setCompleted} size="sm" color="green" label={completed ? 'Complete' : 'Open'} />
              {completed && (
                <div className="flex-1">
                  <Input
                    label="Date Completed"
                    type="date"
                    value={completedDate}
                    onChange={(e) => setCompletedDate(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono text-inky uppercase tracking-wide">AM Notes</label>
              <textarea
                value={completionNotes}
                onChange={(e) => setCompletionNotes(e.target.value)}
                placeholder="Notes from the area manager…"
                rows={3}
                className="w-full bg-cream border border-navy/30 rounded px-3 py-2 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-[#00e5ff] resize-none"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-navy/30 sticky bottom-0 bg-cream">
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
      {label && <label className="text-xs font-mono text-inky uppercase tracking-wide">{label}</label>}
      <div className="flex flex-wrap gap-1.5 p-2 bg-cream border border-navy/30 rounded focus-within:border-[#00e5ff]">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-[#00e5ff]/10 text-inky border border-[#00e5ff]/30 rounded">
            {tag}
            <button onClick={() => onChange(value.filter((t) => t !== tag))} className="hover:text-navy">×</button>
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
          className="flex-1 min-w-[8rem] bg-transparent text-sm font-mono text-navy placeholder-inky/50 focus:outline-none"
        />
      </div>
    </div>
  )
}
