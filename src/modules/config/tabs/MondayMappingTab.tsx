import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { Button, Modal, Input, Select, Badge } from '@/components/ui'
import toast from 'react-hot-toast'

type FieldKind = 'text' | 'mirror' | 'relation' | 'bool' | 'int' | 'numeric' | 'date' | 'phone'
type PgType = 'text' | 'boolean' | 'integer' | 'numeric' | 'date' | 'timestamptz'

interface MondayColumn {
  id: string
  title: string
  type: string
  mapped: boolean
  mappedTo: string | null
  source: 'static' | 'dynamic' | null
  suggestedFieldKind: FieldKind
  suggestedPgType: PgType
}

const PG_TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'boolean', label: 'True / False' },
  { value: 'integer', label: 'Whole Number' },
  { value: 'numeric', label: 'Number (decimal)' },
  { value: 'date', label: 'Date' },
  { value: 'timestamptz', label: 'Date & Time' },
]

const FIELD_KIND_OPTIONS = [
  { value: 'text', label: 'Text (plain)' },
  { value: 'mirror', label: 'Mirror column' },
  { value: 'relation', label: 'Connected board / people' },
  { value: 'bool', label: 'Yes / No' },
  { value: 'int', label: 'Whole number' },
  { value: 'numeric', label: 'Number (decimal)' },
  { value: 'date', label: 'Date' },
  { value: 'phone', label: 'Phone number' },
]

// Best-effort default so the admin usually just confirms rather than types
// a name from scratch — always editable before submitting.
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const safe = /^[0-9]/.test(base) ? `col_${base}` : base
  return (safe || 'new_column').slice(0, 63)
}

export function MondayMappingTab() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const [columns, setColumns] = useState<MondayColumn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showMapped, setShowMapped] = useState(false)
  const [target, setTarget] = useState<MondayColumn | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.functions.invoke('monday-sync-locations', { body: { mode: 'list_columns' } })
    if (error) setError(error.message)
    else if (data?.error) setError(data.error)
    else setColumns(data?.columns ?? [])
    setLoading(false)
  }

  const filtered = columns.filter((c) => {
    if (!showMapped && c.mapped) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  })
  const unmappedCount = columns.filter((c) => !c.mapped).length
  const existingCoreColumns = columns.filter((c) => c.mapped && c.mappedTo).map((c) => c.mappedTo as string)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Monday.com Column Mapping</h2>
        <p className="text-xs text-inky mt-0.5">
          Every column on the "Open Stores List" Monday.com board, and whether it's wired into SB Net's Locations
          sync. Adding a column here creates it on core.locations and makes it live for future syncs — no code
          deploy needed.
        </p>
      </div>

      {!isAdmin && (
        <div className="px-4 py-3 bg-sky/20 border border-sky/60 rounded-lg text-xs font-body text-navy">
          <strong className="font-heading uppercase tracking-wide">Read-only.</strong>{' '}
          Only admins can add a new mapped column.
        </div>
      )}

      {error ? (
        <div className="px-4 py-3 bg-[#C0392B]/10 border border-[#C0392B]/40 rounded-lg text-xs font-body text-[#C0392B]">
          Failed to load Monday.com columns: {error}
        </div>
      ) : loading ? (
        <p className="text-xs text-inky/60 italic">Loading columns from Monday.com…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or column id..."
              className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-1.5 text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none min-w-[220px]"
            />
            <label className="flex items-center gap-1.5 text-xs font-mono text-inky cursor-pointer">
              <input type="checkbox" checked={showMapped} onChange={(e) => setShowMapped(e.target.checked)} />
              Show mapped columns too
            </label>
            <span className="text-xs font-mono text-inky/60 ml-auto">
              {unmappedCount} of {columns.length} not yet mapped
            </span>
          </div>

          <div className="rounded border border-navy/20 divide-y divide-navy/10">
            {filtered.length === 0 ? (
              <p className="text-xs text-inky/60 italic px-4 py-3">
                {showMapped ? 'No columns match.' : 'Nothing unmapped — every board column is wired up.'}
              </p>
            ) : (
              filtered.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-body text-navy truncate">{c.title}</div>
                    <div className="text-[10px] font-mono text-inky/60 truncate">{c.id} · {c.type}</div>
                  </div>
                  {c.mapped ? (
                    <Badge color="green">Mapped → {c.mappedTo}</Badge>
                  ) : (
                    <Button size="sm" onClick={() => setTarget(c)} disabled={!isAdmin}>+ Add</Button>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {target && (
        <AddColumnModal
          column={target}
          existingCoreColumns={existingCoreColumns}
          onClose={() => setTarget(null)}
          onAdded={() => { setTarget(null); load() }}
        />
      )}
    </div>
  )
}

function AddColumnModal({ column, existingCoreColumns, onClose, onAdded }: {
  column: MondayColumn
  existingCoreColumns: string[]
  onClose: () => void
  onAdded: () => void
}) {
  const [columnName, setColumnName] = useState(slugify(column.title))
  const [pgType, setPgType] = useState<PgType>(column.suggestedPgType)
  const [fieldKind, setFieldKind] = useState<FieldKind>(column.suggestedFieldKind)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const nameValid = /^[a-z][a-z0-9_]{0,62}$/.test(columnName)
  const nameTaken = existingCoreColumns.includes(columnName)

  async function submit() {
    if (!nameValid || nameTaken) return
    setSaving(true)
    setFormError(null)
    const { error } = await (supabase as any).rpc('add_monday_mapped_column', {
      p_column_name: columnName,
      p_pg_type: pgType,
      p_monday_column_id: column.id,
      p_monday_column_title: column.title,
      p_monday_column_type: column.type,
      p_field_kind: fieldKind,
    })
    if (error) {
      setFormError(error.message)
      setSaving(false)
      return
    }
    toast.success(`Added "${columnName}" — live on the next Monday.com sync`)
    onAdded()
  }

  return (
    <Modal open onClose={onClose} title="Add Mapped Column" size="md">
      <div className="flex flex-col gap-4">
        <div className="text-xs font-mono text-inky/70">
          Monday.com: <span className="text-navy">{column.title}</span> ({column.id} · {column.type})
        </div>

        <Input
          label="SB Net column name"
          value={columnName}
          onChange={(e) => setColumnName(e.target.value.toLowerCase())}
          error={
            !nameValid
              ? 'Lowercase letters, numbers, underscores only — must start with a letter'
              : nameTaken
                ? 'A column with this name is already mapped'
                : undefined
          }
          hint="Creates core.locations.<name> — visible everywhere else in the app that reads location columns."
        />

        <Select
          label="Column type"
          value={pgType}
          onChange={(e) => setPgType(e.target.value as PgType)}
          options={PG_TYPE_OPTIONS}
        />

        <Select
          label="How to read this Monday.com column"
          value={fieldKind}
          onChange={(e) => setFieldKind(e.target.value as FieldKind)}
          options={FIELD_KIND_OPTIONS}
        />

        {formError && <p className="text-xs text-[#C0392B] font-body">{formError}</p>}

        <p className="text-[10px] font-mono text-inky/60">
          This adds a real, permanent column to core.locations immediately. It can't be removed from this screen —
          contact an engineer if you need to undo it.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} loading={saving} disabled={!nameValid || nameTaken}>Add Column</Button>
        </div>
      </div>
    </Modal>
  )
}
