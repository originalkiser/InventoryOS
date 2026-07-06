import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { HexColorPicker } from 'react-colorful'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { loadFormWithFields, saveFormFields } from '@/hooks/useForms'
import { RichTextEditor, RichTextDisplay } from '@/components/shared/RichTextEditor'
import { BRAND_ASSETS, type BrandAssetKey } from '@/lib/formBrandAssets'
import { resolveThemeColors, DEFAULT_THEME, PRESET_COLORS, type FormTheme, type FormColors } from '@/lib/resolveThemeColors'
import {
  downloadFormImportTemplate, parseFormImportFile, importRowToField, type ImportPreviewRow,
} from '@/lib/formImportTemplate'
import type {
  FormDefinition, FormField, FieldType, FieldOption, FieldCondition, ConditionRule,
  DraftField, FormDepartmentShare, SubmissionAccessRule,
} from '@/types/forms'
import toast from 'react-hot-toast'

const sb = supabase as any

// ── Module-level clipboard (persists within tab session, cleared on refresh) ──
let fieldClipboard: DraftField | null = null

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELD_TYPES: { type: FieldType; label: string; icon: string; desc: string }[] = [
  { type: 'text_block',      label: 'Text Block',       icon: 'T',  desc: 'Static heading or instructions' },
  { type: 'short_answer',    label: 'Short Answer',     icon: '—',  desc: 'Single line text' },
  { type: 'long_answer',     label: 'Long Answer',      icon: '≡',  desc: 'Multi-line textarea' },
  { type: 'multiple_choice', label: 'Multiple Choice',  icon: '◉',  desc: 'Single select radio' },
  { type: 'multi_select',    label: 'Multi-Select',     icon: '☑',  desc: 'Multiple select checkboxes' },
  { type: 'dropdown',        label: 'Dropdown',         icon: '▾',  desc: 'Select from list' },
  { type: 'file_upload',     label: 'File Upload',      icon: '📎', desc: 'Drag-and-drop file zone' },
  { type: 'date',            label: 'Date',             icon: '📅', desc: 'Date picker' },
  { type: 'number',          label: 'Number',           icon: '#',  desc: 'Numeric input' },
  { type: 'calculation',     label: 'Calculation',      icon: 'Σ',  desc: 'Auto-computed score total' },
]

const DEPARTMENTS = ['All', 'Inventory', 'Operations', 'Finance', 'Accounting', 'Marketing', 'HR']

const VISIBILITY_OPTS: { value: FormDefinition['visibility']; label: string; desc: string }[] = [
  { value: 'private',     label: 'Private',     desc: 'Only visible to me and admins' },
  { value: 'org',         label: 'My Org',      desc: 'All authenticated SB Net users' },
  { value: 'departments', label: 'Departments', desc: 'Selected departments only' },
  { value: 'public',      label: 'Public',      desc: 'Anyone with the link (no login required)' },
]

const FILE_TYPE_OPTIONS = [
  { value: 'image/*', label: 'Images' },
  { value: 'application/pdf', label: 'PDF' },
  { value: 'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  { value: 'text/csv', label: 'CSV' },
  { value: 'video/*', label: 'Video' },
]

const COLOR_TOKENS: { key: keyof FormColors; label: string; desc: string }[] = [
  { key: 'background',   label: 'Page Background',  desc: 'Outer page color' },
  { key: 'surface',      label: 'Card Background',   desc: 'Form card & input bg' },
  { key: 'primary',      label: 'Primary Color',     desc: 'Section headers, icons' },
  { key: 'accent',       label: 'Accent Color',      desc: 'Links, focus rings' },
  { key: 'text',         label: 'Body Text',         desc: 'General text color' },
  { key: 'label',        label: 'Field Labels',      desc: 'Question label text' },
  { key: 'input_bg',     label: 'Input Background',  desc: 'Text field fills' },
  { key: 'input_border', label: 'Input Border',      desc: 'Text field borders' },
  { key: 'button_bg',    label: 'Button Background', desc: 'Submit button bg' },
  { key: 'button_text',  label: 'Button Text',       desc: 'Submit button text' },
]

function newField(type: FieldType, order: number): DraftField {
  return {
    id: crypto.randomUUID(),
    field_type: type,
    label: type === 'text_block' ? 'Section Heading' : `New ${FIELD_TYPES.find((f) => f.type === type)?.label ?? 'Field'}`,
    placeholder: null,
    helper_text: null,
    is_required: false,
    sort_order: order,
    options: [],
    calculation_config: { source_fields: [], operation: 'sum', label: 'Total Score' },
    file_types_allowed: null,
    max_file_size_mb: 25,
    content: null,
  }
}

// ── Color Picker Swatch ───────────────────────────────────────────────────────

function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-7 h-7 rounded border border-navy/30 shadow-sm flex-shrink-0"
        style={{ background: value }} />
      {open && (
        <div className="absolute z-50 mt-1 left-0 bg-cream rounded border border-navy/30 shadow-xl p-2 flex flex-col gap-2" style={{ minWidth: 200 }}>
          <HexColorPicker color={value} onChange={onChange} />
          <input value={value}
            onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && onChange(e.target.value)}
            className="w-full rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none"
            placeholder="#000000" />
        </div>
      )}
    </div>
  )
}

// ── Field Option Builder ──────────────────────────────────────────────────────

function OptionBuilder({ options, onChange }: { options: FieldOption[]; onChange: (o: FieldOption[]) => void }) {
  const [newLabel, setNewLabel] = useState('')

  function add() {
    const t = newLabel.trim()
    if (!t) return
    onChange([...options, { id: crypto.randomUUID(), label: t, score: 0 }])
    setNewLabel('')
  }

  return (
    <div className="flex flex-col gap-2">
      {options.map((opt, i) => (
        <div key={opt.id} className="flex items-center gap-2">
          <input value={opt.label}
            onChange={(e) => onChange(options.map((o, j) => j === i ? { ...o, label: e.target.value } : o))}
            className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none"
            placeholder="Option label…" />
          <input type="number" value={opt.score}
            onChange={(e) => onChange(options.map((o, j) => j === i ? { ...o, score: Number(e.target.value) } : o))}
            className="w-16 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none"
            placeholder="Score" />
          <button onClick={() => onChange(options.filter((_, j) => j !== i))} className="text-inky/40 hover:text-red-500 text-xs">✕</button>
        </div>
      ))}
      <div className="flex gap-2">
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="New option…"
          className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none" />
        <button onClick={add} className="text-xs font-mono border border-navy/30 rounded px-2 py-1 text-inky hover:text-navy">Add</button>
      </div>
    </div>
  )
}

// ── Dropdown Location Seeder ──────────────────────────────────────────────────

function numericCode(code: string) {
  const n = parseInt(code.replace(/\D/g, ''), 10)
  return isNaN(n) ? Infinity : n
}

type LocData = {
  location_code: string
  region: string | null
  owner: string | null
  market: string | null
  area_manager: string | null
  regional_director: string | null
  location_type: string | null
}

type LocGroup = { key: string; label: string; codes: string[] }

function mostCommon(vals: (string | null)[]): string | null {
  const counts: Record<string, number> = {}
  for (const v of vals) if (v) counts[v] = (counts[v] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function LocationSeeder({ companyId, onSeed, onUndoSeed }: {
  companyId: string
  onSeed: (labels: string[]) => void
  onUndoSeed?: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [locs, setLocs] = useState<LocData[]>([])
  const [loadingLocs, setLoadingLocs] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set()) // group keys
  const [lastSeeded, setLastSeeded] = useState<string[] | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOut(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [open])

  async function load() {
    if (locs.length > 0) return
    setLoadingLocs(true)
    const { data } = await (sb as any).schema('core').from('locations')
      .select('name, region, metadata')
      .eq('company_id', companyId)
      .eq('active', true)
    const raw = (data ?? []) as any[]
    const mapped: LocData[] = raw.map((r) => ({
      location_code: r.name,
      region: r.region ?? null,
      owner: r.metadata?.owner ?? null,
      market: r.metadata?.market ?? null,
      area_manager: r.metadata?.area_manager ?? null,
      regional_director: r.metadata?.regional_director ?? null,
      location_type: r.metadata?.location_type ?? null,
    }))
    mapped.sort((a, b) => numericCode(a.location_code) - numericCode(b.location_code))
    setLocs(mapped)
    setLoadingLocs(false)
  }

  function toggle() {
    if (!open) load()
    setOpen((v) => !v)
  }

  // Build group lists
  const groups = useMemo<LocGroup[]>(() => {
    if (!locs.length) return []
    const result: LocGroup[] = []

    // All
    result.push({ key: '__all__', label: `All Locations (${locs.length})`, codes: locs.map(l => l.location_code) })

    // By Owner
    const owners = [...new Set(locs.map(l => l.owner).filter(Boolean) as string[])].sort()
    if (owners.length > 0) {
      for (const owner of owners) {
        const codes = locs.filter(l => l.owner === owner).map(l => l.location_code)
        result.push({ key: `owner:${owner}`, label: `${owner} (${codes.length})`, codes })
      }
    }

    // By Region (with director in parens)
    const regions = [...new Set(locs.map(l => l.region).filter(Boolean) as string[])].sort()
    if (regions.length > 0) {
      for (const region of regions) {
        const inRegion = locs.filter(l => l.region === region)
        const director = mostCommon(inRegion.map(l => l.regional_director))
        const label = director ? `${region} (${director}) (${inRegion.length})` : `${region} (${inRegion.length})`
        result.push({ key: `region:${region}`, label, codes: inRegion.map(l => l.location_code) })
      }
    }

    // By Market (with AM in parens)
    const markets = [...new Set(locs.map(l => l.market).filter(Boolean) as string[])].sort()
    if (markets.length > 0) {
      for (const market of markets) {
        const inMarket = locs.filter(l => l.market === market)
        const am = mostCommon(inMarket.map(l => l.area_manager))
        const label = am ? `${market} (${am}) (${inMarket.length})` : `${market} (${inMarket.length})`
        result.push({ key: `market:${market}`, label, codes: inMarket.map(l => l.location_code) })
      }
    }

    // By Type
    const types = [...new Set(locs.map(l => l.location_type).filter(Boolean) as string[])].sort()
    if (types.length > 0) {
      for (const type of types) {
        const codes = locs.filter(l => l.location_type === type).map(l => l.location_code)
        result.push({ key: `type:${type}`, label: `${type.charAt(0).toUpperCase() + type.slice(1)} (${codes.length})`, codes })
      }
    }

    return result
  }, [locs])

  const sectionOf = (key: string) => {
    if (key === '__all__') return 'all'
    if (key.startsWith('owner:')) return 'owner'
    if (key.startsWith('region:')) return 'region'
    if (key.startsWith('market:')) return 'market'
    if (key.startsWith('type:')) return 'type'
    return 'all'
  }

  const selectedCodes = useMemo(() => {
    const codes = new Set<string>()
    for (const key of selected) {
      const g = groups.find(g => g.key === key)
      if (g) g.codes.forEach(c => codes.add(c))
    }
    return codes
  }, [groups, selected])

  function toggleGroup(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleAdd() {
    const codes = Array.from(selectedCodes)
    if (!codes.length) return
    onSeed(codes)
    setLastSeeded(codes)
    setSelected(new Set())
    setOpen(false)
  }

  function handleUndo() {
    if (lastSeeded && onUndoSeed) {
      onUndoSeed(lastSeeded)
      setLastSeeded(null)
    }
  }

  const sections: { id: string; label: string; keys: string[] }[] = [
    { id: 'all',    label: '',              keys: ['__all__'] },
    { id: 'owner',  label: 'By Owner',      keys: groups.filter(g => sectionOf(g.key) === 'owner').map(g => g.key) },
    { id: 'region', label: 'By Region',     keys: groups.filter(g => sectionOf(g.key) === 'region').map(g => g.key) },
    { id: 'market', label: 'By Market',     keys: groups.filter(g => sectionOf(g.key) === 'market').map(g => g.key) },
    { id: 'type',   label: 'By Type',       keys: groups.filter(g => sectionOf(g.key) === 'type').map(g => g.key) },
  ].filter(s => s.keys.length > 0)

  return (
    <div className="relative flex items-center gap-2" ref={panelRef}>
      <button
        onClick={toggle}
        className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:text-navy hover:border-navy/40 transition-colors"
      >
        ↓ Seed from Locations
      </button>
      {lastSeeded && onUndoSeed && (
        <button
          onClick={handleUndo}
          className="text-xs font-mono text-inky/50 hover:text-navy underline transition-colors"
        >
          Undo last seed
        </button>
      )}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 bg-cream border border-navy/20 rounded shadow-lg min-w-[280px] max-w-[340px]">
          {loadingLocs ? (
            <p className="p-3 text-xs font-mono text-inky">Loading…</p>
          ) : locs.length === 0 ? (
            <p className="p-3 text-xs font-mono text-inky/60">No active locations found.</p>
          ) : (
            <>
              <div className="max-h-80 overflow-y-auto">
                {sections.map((section, si) => (
                  <div key={section.id}>
                    {si > 0 && <div className="mx-3 my-1 border-t border-navy/10" />}
                    {section.label && (
                      <div className="px-3 pb-0.5 pt-1 text-[10px] font-mono text-inky/50 uppercase tracking-wide">{section.label}</div>
                    )}
                    {section.keys.map(key => {
                      const g = groups.find(g => g.key === key)
                      if (!g) return null
                      const isChecked = selected.has(key)
                      return (
                        <label key={key} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-navy/5">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleGroup(key)}
                            className="accent-navy"
                          />
                          <span className="text-xs font-mono text-navy truncate" title={g.label}>{g.label}</span>
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-navy/10">
                <span className="text-[11px] font-mono text-inky/60">{selectedCodes.size} location{selectedCodes.size !== 1 ? 's' : ''} selected</span>
                <button
                  onClick={handleAdd}
                  disabled={selectedCodes.size === 0}
                  className="text-xs font-mono bg-navy text-cream rounded px-3 py-1 hover:bg-inky transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Add Selected
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Conditional Logic Modal ───────────────────────────────────────────────────

function ConditionalLogicModal({
  field, allFields, condition, onSave, onRemove, onClose,
}: {
  field: DraftField; allFields: DraftField[]; condition: FieldCondition | null
  onSave: (c: FieldCondition) => void; onRemove: () => void; onClose: () => void
}) {
  const [action, setAction] = useState<'show' | 'hide'>(condition?.action ?? 'show')
  const [logicOp, setLogicOp] = useState<'and' | 'or'>(condition?.logic_operator ?? 'and')
  const [rules, setRules] = useState<Partial<ConditionRule>[]>(
    condition?.rules ?? [{ id: crypto.randomUUID(), source_field_id: '', operator: 'equals', value: '' }]
  )

  const sourceFields = allFields.filter((f) => f.id !== field.id && f.field_type !== 'text_block' && f.field_type !== 'calculation')

  function addRule() {
    setRules((p) => [...p, { id: crypto.randomUUID(), source_field_id: '', operator: 'equals', value: '' }])
  }

  function updateRule(i: number, patch: Partial<ConditionRule>) {
    setRules((p) => p.map((r, j) => j === i ? { ...r, ...patch } : r))
  }

  function save() {
    const validRules = rules.filter((r) => r.source_field_id) as ConditionRule[]
    if (!validRules.length) { toast.error('Add at least one condition rule'); return }
    onSave({
      id: condition?.id ?? crypto.randomUUID(),
      form_id: field.form_id ?? '',
      target_field_id: field.id,
      action, logic_operator: logicOp, rules: validRules,
    })
    onClose()
  }

  const operatorsRequiringValue = ['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-cream rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Conditional Logic</h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy text-lg">✕</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-inky">This field should be</span>
          {(['show', 'hide'] as const).map((a) => (
            <button key={a} onClick={() => setAction(a)}
              className={['px-2 py-1 rounded border text-xs font-mono capitalize', action === a ? 'bg-navy text-cream border-navy' : 'border-navy/30 text-inky hover:border-navy/50'].join(' ')}>
              {a}n
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-inky">when</span>
          {(['and', 'or'] as const).map((op) => (
            <button key={op} onClick={() => setLogicOp(op)}
              className={['px-2 py-1 rounded border text-xs font-mono uppercase', logicOp === op ? 'bg-navy text-cream border-navy' : 'border-navy/30 text-inky hover:border-navy/50'].join(' ')}>
              {op}
            </button>
          ))}
          <span className="text-xs font-mono text-inky">of these are true:</span>
        </div>

        <div className="flex flex-col gap-2">
          {rules.map((rule, i) => {
            const srcField = sourceFields.find((f) => f.id === rule.source_field_id)
            const needsVal = operatorsRequiringValue.includes(rule.operator ?? '')
            return (
              <div key={rule.id ?? i} className="flex items-center gap-2 flex-wrap">
                <select value={rule.source_field_id ?? ''} onChange={(e) => updateRule(i, { source_field_id: e.target.value })}
                  className="flex-1 min-w-0 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="">Select field…</option>
                  {sourceFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <select value={rule.operator ?? 'equals'} onChange={(e) => updateRule(i, { operator: e.target.value as ConditionRule['operator'] })}
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="equals">equals</option>
                  <option value="not_equals">not equals</option>
                  <option value="contains">contains</option>
                  <option value="not_contains">not contains</option>
                  <option value="greater_than">greater than</option>
                  <option value="less_than">less than</option>
                  <option value="is_answered">is answered</option>
                  <option value="is_empty">is empty</option>
                </select>
                {needsVal && (
                  srcField && ['multiple_choice', 'dropdown'].includes(srcField.field_type) ? (
                    <select value={rule.value ?? ''} onChange={(e) => updateRule(i, { value: e.target.value })}
                      className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                      <option value="">Any…</option>
                      {srcField.options.map((o) => <option key={o.id} value={o.label}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input value={rule.value ?? ''} onChange={(e) => updateRule(i, { value: e.target.value })}
                      placeholder="Value…"
                      className="w-28 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none" />
                  )
                )}
                <button onClick={() => setRules((p) => p.filter((_, j) => j !== i))} className="text-inky/40 hover:text-red-500 text-xs flex-shrink-0">✕</button>
              </div>
            )
          })}
          <button onClick={addRule} className="text-xs font-mono text-inky hover:text-navy self-start">+ Add Condition</button>
        </div>

        <div className="flex justify-between pt-2 border-t border-navy/10">
          <button onClick={() => { onRemove(); onClose() }} className="text-xs font-mono text-red-500 hover:text-red-700">Remove All Logic</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
            <button onClick={save} className="text-xs font-mono bg-navy text-cream rounded px-3 py-1.5 hover:bg-inky">Save Logic</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Field Card ────────────────────────────────────────────────────────────────

function FieldCard({
  field, allFields, condition, clipboardFieldId,
  onUpdate, onDelete, onDuplicate, onCopy, onPasteAbove, onPasteBelow,
  onConditionSave, onConditionRemove,
}: {
  field: DraftField; allFields: DraftField[]; condition: FieldCondition | null
  clipboardFieldId: string | null
  onUpdate: (patch: Partial<DraftField>) => void
  onDelete: () => void
  onDuplicate: () => void
  onCopy: () => void
  onPasteAbove: (() => void) | null
  onPasteBelow: (() => void) | null
  onConditionSave: (c: FieldCondition) => void
  onConditionRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showLogic, setShowLogic] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id })
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition }

  const meta = FIELD_TYPES.find((f) => f.type === field.field_type)
  const hasOptions = ['multiple_choice', 'multi_select', 'dropdown'].includes(field.field_type)
  const isTextBlock = field.field_type === 'text_block'
  const isCalculation = field.field_type === 'calculation'
  const hasCondition = condition != null
  const isInClipboard = clipboardFieldId === field.id
  const hasClipboard = fieldClipboard != null

  useEffect(() => {
    if (!showMenu) return
    function onOut(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [showMenu])

  return (
    <>
      <div ref={setNodeRef} style={style}
        className={[
          'rounded border bg-cream shadow-sm transition-shadow',
          isDragging ? 'shadow-lg opacity-80 border-[#00e5ff]' : 'border-navy/20 hover:border-navy/40',
          hasCondition ? 'border-l-2 border-l-[#00e5ff]' : '',
          isInClipboard ? 'ring-2 ring-sky/60' : '',
        ].join(' ')}>

        {/* Card header */}
        <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer" onClick={() => setExpanded((e) => !e)}>
          <span {...attributes} {...listeners} className="cursor-grab text-inky/40 hover:text-navy text-sm select-none" onClick={(e) => e.stopPropagation()}>⋮⋮</span>
          <span className="text-sm text-inky/70 w-5 text-center flex-shrink-0">{meta?.icon}</span>
          <span className="flex-1 text-xs font-heading text-navy truncate">
            {field.label}
            {field.is_required && <span className="text-red-500 ml-0.5">*</span>}
          </span>
          {hasCondition && <span className="text-[10px] font-mono text-[#00e5ff] flex-shrink-0">Logic</span>}
          <span className="text-inky/40 text-xs">{expanded ? '▲' : '▼'}</span>

          {/* Kebab menu */}
          <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="text-inky/30 hover:text-navy text-base px-1 flex-shrink-0"
              title="More options">
              ⋯
            </button>
            {showMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-cream rounded border border-navy/20 shadow-xl min-w-[140px] py-1">
                <button onClick={() => { onDuplicate(); setShowMenu(false) }}
                  className="w-full text-left px-3 py-1.5 text-xs font-mono text-inky hover:bg-navy/5">
                  ⧉ Duplicate
                </button>
                <div className="my-1 border-t border-navy/10" />
                <button onClick={() => { onCopy(); setShowMenu(false) }}
                  className="w-full text-left px-3 py-1.5 text-xs font-mono text-inky hover:bg-navy/5">
                  Copy Field
                </button>
                <div className="my-1 border-t border-navy/10" />
                <button
                  onClick={() => { onPasteAbove?.(); setShowMenu(false) }}
                  disabled={!hasClipboard}
                  className="w-full text-left px-3 py-1.5 text-xs font-mono text-inky hover:bg-navy/5 disabled:opacity-30">
                  Paste Above
                </button>
                <button
                  onClick={() => { onPasteBelow?.(); setShowMenu(false) }}
                  disabled={!hasClipboard}
                  className="w-full text-left px-3 py-1.5 text-xs font-mono text-inky hover:bg-navy/5 disabled:opacity-30">
                  Paste Below
                </button>
                <div className="my-1 border-t border-navy/10" />
                <button onClick={() => { onDelete(); setShowMenu(false) }}
                  className="w-full text-left px-3 py-1.5 text-xs font-mono text-red-500 hover:bg-red-50">
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Expanded settings */}
        {expanded && (
          <div className="border-t border-navy/10 px-3 py-3 flex flex-col gap-3">
            {/* Required toggle — first control (per spec) */}
            {!isTextBlock && !isCalculation && (
              <label className="flex items-center gap-2 cursor-pointer pb-2 border-b border-navy/10">
                <input type="checkbox" checked={field.is_required} onChange={(e) => onUpdate({ is_required: e.target.checked })} className="accent-navy" />
                <span className="text-xs font-mono text-inky font-semibold">Required</span>
              </label>
            )}

            {/* Label */}
            {!isTextBlock && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Label</label>
                <input value={field.label} onChange={(e) => onUpdate({ label: e.target.value })}
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
              </div>
            )}

            {/* Text block content */}
            {isTextBlock && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Content</label>
                <RichTextEditor value={field.content ?? ''} onChange={(html) => onUpdate({ content: html, label: html.replace(/<[^>]+>/g, '').slice(0, 60) || 'Text Block' })} minHeight={80} />
              </div>
            )}

            {/* Placeholder */}
            {['short_answer', 'long_answer', 'number', 'date'].includes(field.field_type) && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Placeholder</label>
                <input value={field.placeholder ?? ''} onChange={(e) => onUpdate({ placeholder: e.target.value || null })}
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
              </div>
            )}

            {/* Helper text */}
            {!isTextBlock && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Helper Text</label>
                <input value={field.helper_text ?? ''} onChange={(e) => onUpdate({ helper_text: e.target.value || null })}
                  placeholder="Shown below the field to respondents…"
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none" />
              </div>
            )}

            {/* Options */}
            {hasOptions && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Options (label + score)</label>
                  {field.field_type === 'dropdown' && (
                    <LocationSeeder
                      companyId={useAuthStore.getState().profile?.company_id ?? ''}
                      onSeed={(codes) => {
                        const existing = new Set(field.options.map((o) => o.label))
                        const newOpts = codes
                          .filter((c) => !existing.has(c))
                          .map((c) => ({ id: crypto.randomUUID(), label: c, score: 0 }))
                        onUpdate({ options: [...field.options, ...newOpts] })
                      }}
                      onUndoSeed={(codes) => {
                        const codeSet = new Set(codes)
                        onUpdate({ options: field.options.filter((o) => !codeSet.has(o.label)) })
                      }}
                    />
                  )}
                </div>
                <OptionBuilder options={field.options} onChange={(o) => onUpdate({ options: o })} />
              </div>
            )}

            {/* File upload config */}
            {field.field_type === 'file_upload' && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Accepted File Types</label>
                  <div className="flex flex-wrap gap-2">
                    {FILE_TYPE_OPTIONS.map((ft) => {
                      const checked = (field.file_types_allowed ?? []).includes(ft.value)
                      return (
                        <label key={ft.value} className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={checked} className="accent-navy"
                            onChange={(e) => {
                              const curr = field.file_types_allowed ?? []
                              onUpdate({ file_types_allowed: e.target.checked ? [...curr, ft.value] : curr.filter((v) => v !== ft.value) })
                            }} />
                          <span className="text-xs font-mono text-inky">{ft.label}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Max Size (MB)</label>
                  <input type="number" value={field.max_file_size_mb} min={1} max={100}
                    onChange={(e) => onUpdate({ max_file_size_mb: Number(e.target.value) })}
                    className="w-20 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
                </div>
              </div>
            )}

            {/* Calculation config */}
            {isCalculation && (
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Score Sources</label>
                <p className="text-[10px] font-mono text-inky/60">Select which fields contribute to the score total.</p>
                <div className="flex flex-col gap-1">
                  {allFields.filter((f) => ['multiple_choice', 'multi_select', 'dropdown'].includes(f.field_type) && f.id !== field.id).map((f) => {
                    const srcIds = field.calculation_config?.source_fields ?? []
                    const checked = srcIds.includes(f.id)
                    return (
                      <label key={f.id} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={checked} className="accent-navy"
                          onChange={(e) => {
                            const next = e.target.checked ? [...srcIds, f.id] : srcIds.filter((id) => id !== f.id)
                            onUpdate({ calculation_config: { ...field.calculation_config, source_fields: next } })
                          }} />
                        <span className="text-xs font-mono text-inky">{f.label}</span>
                      </label>
                    )
                  })}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Display Label</label>
                  <input value={field.calculation_config?.label ?? 'Total Score'}
                    onChange={(e) => onUpdate({ calculation_config: { ...field.calculation_config, label: e.target.value } })}
                    className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
                </div>
              </div>
            )}

            {/* Conditional logic button */}
            {!isTextBlock && (
              <button onClick={() => setShowLogic(true)}
                className={['text-xs font-mono px-2 py-1 rounded border self-start transition-colors', hasCondition ? 'border-[#00e5ff] text-navy bg-[#00e5ff]/5' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
                {hasCondition ? '⚡ Edit Logic' : '+ Conditional Logic'}
              </button>
            )}
          </div>
        )}
      </div>

      {showLogic && (
        <ConditionalLogicModal
          field={field} allFields={allFields} condition={condition}
          onSave={onConditionSave} onRemove={onConditionRemove} onClose={() => setShowLogic(false)}
        />
      )}
    </>
  )
}

// ── Spreadsheet Import Modal ──────────────────────────────────────────────────

function ImportModal({ onImport, onClose }: {
  onImport: (rows: ImportPreviewRow[]) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<ImportPreviewRow[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedOpts, setExpandedOpts] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setLoading(true)
    try {
      const parsed = await parseFormImportFile(file)
      setRows(parsed)
    } catch {
      toast.error('Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  function toggleSelect(id: string, val: boolean) {
    setRows((p) => p.map((r) => r.id === id ? { ...r, selected: val } : r))
  }

  function selectAll() { setRows((p) => p.map((r) => r.isUnknownType ? r : { ...r, selected: true })) }
  function deselectAll() { setRows((p) => p.map((r) => ({ ...r, selected: false }))) }

  function removeDuplicates() {
    const seen = new Set<string>()
    setRows((p) => p.map((r) => {
      const key = `${r.label}__${r.rawType}`
      if (seen.has(key)) return { ...r, selected: false }
      seen.add(key)
      return r
    }))
  }

  function removeRow(id: string) {
    setRows((p) => p.filter((r) => r.id !== id))
  }

  const selectedCount = rows.filter((r) => r.selected && !r.isUnknownType).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-cream rounded-lg border border-navy/30 shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy/20 flex-shrink-0">
          <div>
            <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Import from Spreadsheet</h3>
            <p className="text-[10px] font-mono text-inky/60 mt-0.5">Upload XLSX or CSV to generate form fields</p>
          </div>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
          {rows.length === 0 ? (
            <div className="flex flex-col gap-4">
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-navy/20 rounded-lg px-6 py-10 flex flex-col items-center gap-3 cursor-pointer hover:border-navy/40 transition-colors">
                <span className="text-2xl">📊</span>
                <span className="text-sm font-mono text-inky">Click to upload XLSX or CSV</span>
                <span className="text-xs font-mono text-inky/50">Columns: Label, Description, Type, Options, Scores, Required</span>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
              <button
                onClick={downloadFormImportTemplate}
                className="self-start text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
                ↓ Download Import Template
              </button>
              {loading && <p className="text-xs font-mono text-inky animate-pulse">Parsing file…</p>}
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-inky">{rows.length} fields found</span>
                <button onClick={selectAll} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Select All</button>
                <button onClick={deselectAll} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Deselect All</button>
                <button onClick={removeDuplicates} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Remove Duplicates</button>
              </div>

              {/* Preview table */}
              <div className="flex flex-col gap-1">
                {rows.map((row) => (
                  <div key={row.id}
                    className={['rounded border px-3 py-2 flex items-start gap-2', row.isUnknownType ? 'border-amber-300 bg-amber-50/50' : row.selected ? 'border-navy/20 bg-cream' : 'border-navy/10 bg-navy/2 opacity-50'].join(' ')}>
                    <input type="checkbox" checked={row.selected && !row.isUnknownType} disabled={row.isUnknownType}
                      onChange={(e) => toggleSelect(row.id, e.target.checked)}
                      className="mt-0.5 accent-navy" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-heading text-navy">{row.label}</span>
                        <span className={['text-[10px] font-mono px-1.5 py-0.5 rounded', row.isUnknownType ? 'bg-amber-200 text-amber-900' : 'bg-navy/10 text-inky'].join(' ')}>
                          {row.isUnknownType ? `⚠ unknown: ${row.rawType}` : row.rawType}
                        </span>
                        {row.isRequired && <span className="text-[10px] font-mono text-red-600">Required</span>}
                        {row.options.length > 0 && (
                          <button
                            onClick={() => setExpandedOpts((p) => {
                              const n = new Set(p)
                              n.has(row.id) ? n.delete(row.id) : n.add(row.id)
                              return n
                            })}
                            className="text-[10px] font-mono text-[#00e5ff] underline">
                            {row.options.length} opts
                          </button>
                        )}
                      </div>
                      {row.description && <p className="text-[10px] font-mono text-inky/60 truncate mt-0.5">{row.description}</p>}
                      {expandedOpts.has(row.id) && (
                        <ul className="mt-1 flex flex-col gap-0.5 pl-2">
                          {row.options.map((o, i) => (
                            <li key={i} className="text-[10px] font-mono text-inky/70">• {o.label}{o.score !== 0 && ` (${o.score})`}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button onClick={() => removeRow(row.id)} className="text-inky/30 hover:text-red-500 text-xs flex-shrink-0">✕</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {rows.length > 0 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-navy/20 flex-shrink-0">
            <button onClick={onClose} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
            <button
              onClick={() => onImport(rows.filter((r) => r.selected && !r.isUnknownType))}
              disabled={selectedCount === 0}
              className="text-xs font-mono bg-navy text-cream rounded px-4 py-1.5 hover:bg-inky disabled:opacity-40">
              Generate Form from {selectedCount} Field{selectedCount !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Appearance Panel ──────────────────────────────────────────────────────────

function AppearancePanel({ theme, onChange }: { theme: FormTheme; onChange: (t: FormTheme) => void }) {
  const colors = resolveThemeColors(theme)
  const [logoMode, setLogoMode] = useState<'none' | 'library' | 'soon'>(theme.header_logo_key ? 'library' : 'none')

  function setPreset(preset: 'sb_dark' | 'sb_light' | 'custom') {
    onChange({ ...theme, preset, colors: preset === 'custom' ? colors : PRESET_COLORS[preset as 'sb_dark' | 'sb_light'] ?? colors })
  }

  function setColor(key: keyof FormColors, value: string) {
    onChange({ ...theme, preset: 'custom', colors: { ...colors, [key]: value } })
  }

  function setLogoKey(key: BrandAssetKey | null) { onChange({ ...theme, header_logo_key: key }) }

  const previewColors = resolveThemeColors(theme)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Header Image</span>
        <div className="flex gap-2">
          {(['none', 'library', 'soon'] as const).map((m) => (
            <button key={m} onClick={() => { setLogoMode(m); if (m === 'none') setLogoKey(null) }}
              className={['px-2 py-1 rounded border text-[10px] font-mono capitalize', logoMode === m ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
              {m === 'none' ? 'No Image' : m === 'library' ? 'SBOC Library' : 'Custom (Soon)'}
            </button>
          ))}
        </div>
        {logoMode === 'library' && (
          <div className="grid grid-cols-3 gap-2 mt-1">
            {BRAND_ASSETS.map((asset) => (
              <button key={asset.key} onClick={() => setLogoKey(asset.key as BrandAssetKey)}
                className={['rounded border p-1 text-left transition-colors', theme.header_logo_key === asset.key ? 'border-[#00e5ff] bg-[#00e5ff]/5' : 'border-navy/20 hover:border-navy/40'].join(' ')}>
                <img src={asset.preview} alt={asset.label} className="w-full h-10 object-contain rounded" />
                <span className="text-[9px] font-mono text-inky/60 block mt-0.5 truncate">{asset.label}</span>
              </button>
            ))}
          </div>
        )}
        {logoMode === 'soon' && (
          <p className="text-[10px] font-mono text-inky/50 italic">Custom image upload coming soon.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Color Theme</span>
        <div className="flex gap-2">
          {(['sb_dark', 'sb_light', 'custom'] as const).map((p) => (
            <button key={p} onClick={() => setPreset(p)}
              className={['px-2 py-1 rounded border text-[10px] font-mono', theme.preset === p ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
              {p === 'sb_dark' ? 'SB Dark' : p === 'sb_light' ? 'SB Light' : 'Custom'}
            </button>
          ))}
        </div>
        {theme.preset === 'custom' && (
          <div className="flex flex-col gap-2 mt-1">
            {COLOR_TOKENS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <ColorSwatch value={colors[key]} onChange={(v) => setColor(key, v)} />
                <span className="flex-1 text-xs font-mono text-inky">{label}</span>
                <span className="text-[10px] font-mono text-inky/50">{colors[key]}</span>
              </div>
            ))}
            <div className="flex gap-2 mt-1">
              <button onClick={() => setPreset('sb_dark')} className="text-[10px] font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">↺ Revert to SB Dark</button>
              <button onClick={() => setPreset('sb_light')} className="text-[10px] font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">↺ Revert to SB Light</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Live Preview</span>
        <div className="rounded border border-navy/20 overflow-hidden">
          <div className="px-4 py-3 flex flex-col gap-2" style={{ background: previewColors.background }}>
            {theme.header_logo_key && (
              <img src={BRAND_ASSETS.find((a) => a.key === theme.header_logo_key)?.preview} alt="" className="h-8 object-contain mx-auto" />
            )}
            <div className="text-sm font-bold" style={{ color: previewColors.text }}>Form Title</div>
            <div className="flex flex-col gap-1">
              <div className="text-[10px]" style={{ color: previewColors.label }}>Sample Field</div>
              <div className="rounded px-2 py-1 text-xs border" style={{ background: previewColors.input_bg, borderColor: previewColors.input_border, color: previewColors.text }}>
                Response goes here…
              </div>
            </div>
            <button className="self-start rounded px-3 py-1 text-xs font-bold" style={{ background: previewColors.button_bg, color: previewColors.button_text }}>Submit</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Submission Access Tab ─────────────────────────────────────────────────────

function SubmissionAccessTab({ formId, profile }: { formId: string | null; profile: any }) {
  const [rules, setRules] = useState<SubmissionAccessRule[]>([])
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [principalType, setPrincipalType] = useState<SubmissionAccessRule['principal_type']>('user')
  const [principalValue, setPrincipalValue] = useState('')
  const [canRead, setCanRead] = useState(true)
  const [canWrite, setCanWrite] = useState(false)
  const [saving, setSaving] = useState(false)
  const [profiles, setProfiles] = useState<{ id: string; full_name: string | null; email: string | null }[]>([])

  useEffect(() => {
    if (!formId || !profile?.company_id) return
    setLoading(true)
    Promise.all([
      sb.schema('forms').from('submission_access_rules').select('*').eq('form_id', formId).order('created_at'),
      sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', profile.company_id).order('full_name'),
    ]).then(([rRes, pRes]: any[]) => {
      setRules(rRes.data ?? [])
      setProfiles(pRes.data ?? [])
      setLoading(false)
    })
  }, [formId, profile?.company_id])

  async function addRule() {
    if (!formId || !profile?.id) return
    const pv = principalType === 'org' ? null : principalValue
    if (principalType !== 'org' && !pv) { toast.error('Select a value'); return }
    setSaving(true)
    const { data, error } = await sb.schema('forms').from('submission_access_rules')
      .insert({ form_id: formId, principal_type: principalType, principal_value: pv, can_read: canRead, can_write: canWrite, created_by: profile.id })
      .select().single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    setRules((p) => [...p, data])
    setAddOpen(false)
    setPrincipalValue('')
    toast.success('Rule added')
  }

  async function removeRule(id: string) {
    await sb.schema('forms').from('submission_access_rules').delete().eq('id', id)
    setRules((p) => p.filter((r) => r.id !== id))
  }

  function principalLabel(rule: SubmissionAccessRule): string {
    if (rule.principal_type === 'org') return 'All org users'
    if (rule.principal_type === 'user') {
      const p = profiles.find((p) => p.id === rule.principal_value)
      return p?.full_name ?? rule.principal_value ?? '?'
    }
    return rule.principal_value ?? ''
  }

  if (!formId) {
    return <p className="text-xs font-mono text-inky/60 p-3">Save the form first to manage submission access rules.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] font-mono text-inky/60">Control who can view and edit responses in the results table.</p>

      {loading ? (
        <p className="text-xs font-mono text-inky animate-pulse">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-2 rounded border border-navy/15 bg-cream px-3 py-2">
              <span className="text-sm">{rule.principal_type === 'org' ? '🏢' : rule.principal_type === 'user' ? '👤' : '👥'}</span>
              <span className="flex-1 text-xs font-mono text-navy truncate">{principalLabel(rule)}</span>
              <span className={['text-[10px] font-mono px-1 py-0.5 rounded', rule.can_read ? 'text-green-700 bg-green-50' : 'text-inky/40 bg-navy/5'].join(' ')}>R</span>
              <span className={['text-[10px] font-mono px-1 py-0.5 rounded', rule.can_write ? 'text-amber-700 bg-amber-50' : 'text-inky/40 bg-navy/5'].join(' ')}>W</span>
              <button onClick={() => removeRule(rule.id)} className="text-inky/30 hover:text-red-500 text-xs">✕</button>
            </div>
          ))}
        </div>
      )}

      {addOpen ? (
        <div className="flex flex-col gap-2 rounded border border-navy/20 p-3 bg-navy/2">
          <div className="flex gap-2">
            {(['user', 'department', 'role', 'org'] as const).map((t) => (
              <button key={t} onClick={() => { setPrincipalType(t); setPrincipalValue('') }}
                className={['px-2 py-1 rounded border text-[10px] font-mono capitalize', principalType === t ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
                {t}
              </button>
            ))}
          </div>

          {principalType === 'user' && (
            <select value={principalValue} onChange={(e) => setPrincipalValue(e.target.value)}
              className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
              <option value="">Select user…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}
            </select>
          )}
          {principalType === 'department' && (
            <select value={principalValue} onChange={(e) => setPrincipalValue(e.target.value)}
              className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
              <option value="">Select department…</option>
              {DEPARTMENTS.filter((d) => d !== 'All').map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {principalType === 'role' && (
            <select value={principalValue} onChange={(e) => setPrincipalValue(e.target.value)}
              className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
              <option value="">Select role…</option>
              {['administrator', 'developer', 'department_head', 'department_user'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}

          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={canRead} onChange={(e) => setCanRead(e.target.checked)} className="accent-navy" />
              <span className="text-xs font-mono text-inky">Read</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} className="accent-navy" />
              <span className="text-xs font-mono text-inky">Write</span>
            </label>
          </div>

          <div className="flex gap-2">
            <button onClick={() => setAddOpen(false)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Cancel</button>
            <button onClick={addRule} disabled={saving} className="text-xs font-mono bg-navy text-cream rounded px-2 py-1 hover:bg-inky disabled:opacity-40">
              {saving ? 'Adding…' : 'Add Rule'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddOpen(true)} className="self-start text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">
          + Add Rule
        </button>
      )}
    </div>
  )
}

// ── Main Builder ──────────────────────────────────────────────────────────────

export function FormBuilderPage() {
  const { formId } = useParams<{ formId?: string }>()
  const navigate = useNavigate()
  const { profile } = useAuthStore()

  const [formData, setFormData] = useState<Partial<FormDefinition>>({
    title: 'Untitled Form',
    description: '',
    department: 'All',
    category: null,
    visibility: 'private',
    is_accepting_responses: true,
    show_score_to_respondent: false,
    allow_multiple_submissions: false,
    requires_login: false,
    theme: DEFAULT_THEME,
  })
  const [fields, setFields] = useState<DraftField[]>([])
  const [conditions, setConditions] = useState<FieldCondition[]>([])
  const [deptShares, setDeptShares] = useState<string[]>([]) // department names
  const [leftTab, setLeftTab] = useState<'fields' | 'general' | 'appearance' | 'access'>('fields')
  const [saving, setSaving] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(formId ?? null)
  const [clipboardFieldId, setClipboardFieldId] = useState<string | null>(null)
  const [categories, setCategories] = useState<string[]>([]) // autocomplete

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    if (!formId) return
    loadFormWithFields(formId).then((res) => {
      if (!res) return
      setFormData(res.form)
      setFields(res.fields)
      setConditions(res.conditions)
      setSavedId(formId)
    })
    // Load dept shares
    sb.schema('forms').from('form_department_shares').select('department').eq('form_id', formId)
      .then(({ data }: any) => setDeptShares((data ?? []).map((r: any) => r.department)))
  }, [formId])

  useEffect(() => {
    if (!profile?.company_id) return
    sb.schema('forms').from('forms').select('category').eq('company_id', profile.company_id).not('category', 'is', null)
      .then(({ data }: any) => {
        const cats: string[] = Array.from(new Set<string>((data ?? []).map((r: any) => r.category as string).filter(Boolean)))
        setCategories(cats)
      })
  }, [profile?.company_id])

  function addField(type: FieldType) {
    setFields((prev) => [...prev, newField(type, prev.length)])
  }

  function updateField(id: string, patch: Partial<DraftField>) {
    setFields((prev) => prev.map((f) => f.id === id ? { ...f, ...patch } : f))
  }

  function deleteField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id))
    setConditions((prev) => prev.filter((c) => c.target_field_id !== id))
  }

  function duplicateField(id: string) {
    const idx = fields.findIndex((f) => f.id === id)
    if (idx === -1) return
    const original = fields[idx]
    const dup: DraftField = { ...original, id: crypto.randomUUID() }
    const next = [...fields]
    next.splice(idx + 1, 0, dup)
    setFields(next.map((f, i) => ({ ...f, sort_order: i })))
    toast.success('Field duplicated', { duration: 1500 })
  }

  function copyField(id: string) {
    const field = fields.find((f) => f.id === id)
    if (!field) return
    // Preserve a deep copy; strip form_id so it's a standalone draft
    fieldClipboard = { ...field, id: crypto.randomUUID(), options: field.options.map((o) => ({ ...o })) }
    setClipboardFieldId(id)
    toast.success('Field copied', { duration: 1500 })
  }

  function pasteField(relativeToId: string, position: 'above' | 'below') {
    if (!fieldClipboard) return
    const pasted: DraftField = { ...fieldClipboard, id: crypto.randomUUID() }
    const idx = fields.findIndex((f) => f.id === relativeToId)
    if (idx === -1) return
    const insertAt = position === 'above' ? idx : idx + 1
    const next = [...fields]
    next.splice(insertAt, 0, pasted)
    setFields(next.map((f, i) => ({ ...f, sort_order: i })))
    toast.success(`Field pasted ${position}`, { duration: 1500 })
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = fields.map((f) => f.id)
    setFields(arrayMove(fields, ids.indexOf(active.id as string), ids.indexOf(over.id as string)))
  }

  function conditionFor(fieldId: string): FieldCondition | null {
    return conditions.find((c) => c.target_field_id === fieldId) ?? null
  }

  function saveCondition(cond: FieldCondition) {
    setConditions((prev) => {
      const exists = prev.find((c) => c.target_field_id === cond.target_field_id)
      return exists ? prev.map((c) => c.target_field_id === cond.target_field_id ? cond : c) : [...prev, cond]
    })
  }

  function removeCondition(fieldId: string) {
    setConditions((prev) => prev.filter((c) => c.target_field_id !== fieldId))
  }

  async function saveDeptShares(formId: string, newShares: string[]) {
    // Delete all existing shares, re-insert
    await sb.schema('forms').from('form_department_shares').delete().eq('form_id', formId)
    if (newShares.length) {
      await sb.schema('forms').from('form_department_shares').insert(
        newShares.map((dept) => ({ form_id: formId, department: dept, created_by: profile?.id }))
      )
    }
  }

  const save = useCallback(async (publish?: boolean) => {
    if (!profile?.id) return
    setSaving(true)
    try {
      const payload: any = {
        ...formData,
        ...(publish != null ? { is_published: publish } : {}),
        updated_at: new Date().toISOString(),
      }
      let id = savedId
      if (id) {
        await sb.schema('forms').from('forms').update(payload).eq('id', id)
      } else {
        const { data, error } = await sb.schema('forms').from('forms')
          .insert({ ...payload, created_by: profile.id, company_id: profile.company_id })
          .select().single()
        if (error) { toast.error(error.message); return }
        id = data.id
        setSavedId(id)
        navigate(`/forms/${id}/edit`, { replace: true })
      }
      await saveFormFields(id!, fields as FormField[], conditions)
      if (formData.visibility === 'departments') {
        await saveDeptShares(id!, deptShares)
      }
      if (publish != null) {
        setFormData((f) => ({ ...f, is_published: publish }))
        toast.success(publish ? 'Form published' : 'Form unpublished')
      } else {
        toast.success('Form saved')
      }
    } finally {
      setSaving(false)
    }
  }, [profile, savedId, formData, fields, conditions, deptShares, navigate])

  function handleImport(rows: ImportPreviewRow[]) {
    const imported = rows.map((row, i) => importRowToField(row, fields.length + i))
    setFields((prev) => [...prev, ...imported])
    setImportOpen(false)
    setLeftTab('fields')
    toast.success(`${rows.length} field${rows.length !== 1 ? 's' : ''} imported`)
  }

  const shareUrl = savedId && formData.share_token
    ? `${window.location.origin}${import.meta.env.BASE_URL}f/${formData.share_token}`
    : null

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-navy/20 bg-cream flex-shrink-0 flex-wrap">
        <button onClick={() => navigate('/forms')} className="text-xs font-mono text-inky hover:text-navy">← Back</button>
        <input
          value={formData.title ?? ''}
          onChange={(e) => setFormData((f) => ({ ...f, title: e.target.value }))}
          className="flex-1 min-w-0 bg-transparent text-sm font-heading font-bold text-navy focus:outline-none border-b border-transparent focus:border-navy/30"
          placeholder="Form title…" />
        <button onClick={() => setImportOpen(true)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1.5 text-inky hover:border-navy/40">↑ Import</button>
        <button onClick={() => setPreviewOpen(true)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1.5 text-inky hover:border-navy/40">Preview</button>
        {savedId && (
          <>
            <button onClick={() => setShareOpen(true)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1.5 text-inky hover:border-navy/40">Share</button>
            <button onClick={() => navigate(`/forms/${savedId}/assignments`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1.5 text-inky hover:border-navy/40">Rules</button>
          </>
        )}
        <button onClick={() => save()} disabled={saving} className="text-xs font-mono border border-navy/30 rounded px-3 py-1.5 text-inky hover:border-navy disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => save(!formData.is_published)} disabled={saving}
          className={['text-xs font-mono rounded px-3 py-1.5 font-bold disabled:opacity-40', formData.is_published ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-navy text-cream hover:bg-inky'].join(' ')}>
          {formData.is_published ? 'Unpublish' : 'Publish'}
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel */}
        <div className="w-72 flex-shrink-0 border-r border-navy/20 bg-cream flex flex-col overflow-hidden">
          <div className="flex border-b border-navy/20">
            {(['fields', 'general', 'appearance', 'access'] as const).map((tab) => (
              <button key={tab} onClick={() => setLeftTab(tab)}
                className={['flex-1 py-2 text-[9px] font-mono uppercase tracking-wide capitalize transition-colors', leftTab === tab ? 'text-navy border-b-2 border-navy' : 'text-inky/60 hover:text-navy'].join(' ')}>
                {tab}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {leftTab === 'fields' && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-mono text-inky/60">Click to add a field to the canvas.</p>
                  <button onClick={downloadFormImportTemplate} title="Download import template"
                    className="text-[10px] font-mono text-inky/50 hover:text-navy underline">template</button>
                </div>
                {FIELD_TYPES.map((ft) => (
                  <button key={ft.type} onClick={() => addField(ft.type)}
                    className="flex items-center gap-3 px-3 py-2 rounded border border-navy/15 bg-cream hover:border-[#00e5ff]/60 hover:bg-[#00e5ff]/5 text-left transition-colors">
                    <span className="text-sm text-inky/70 w-5 text-center flex-shrink-0">{ft.icon}</span>
                    <div className="min-w-0">
                      <div className="text-xs font-heading text-navy">{ft.label}</div>
                      <div className="text-[9px] font-mono text-inky/50 truncate">{ft.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {leftTab === 'general' && (
              <div className="flex flex-col gap-3">
                {/* Category */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Category</label>
                  <input
                    value={formData.category ?? ''}
                    onChange={(e) => setFormData((f) => ({ ...f, category: e.target.value || null }))}
                    list="category-options"
                    placeholder="e.g. Compliance, Quality, HR…"
                    className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none" />
                  <datalist id="category-options">
                    {categories.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>

                {/* Department */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Department <span className="normal-case text-inky/40">(optional)</span></label>
                  <select value={formData.department ?? 'All'} onChange={(e) => setFormData((f) => ({ ...f, department: e.target.value }))}
                    className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                    {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>

                {/* Description */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Description</label>
                  <RichTextEditor value={formData.description ?? ''} onChange={(v) => setFormData((f) => ({ ...f, description: v }))} minHeight={80} />
                </div>

                {/* Visibility */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Form Visibility</label>
                  {VISIBILITY_OPTS.map((opt) => (
                    <label key={opt.value} className="flex items-start gap-2 cursor-pointer group">
                      <input type="radio" name="visibility" value={opt.value}
                        checked={formData.visibility === opt.value}
                        onChange={() => setFormData((f) => ({ ...f, visibility: opt.value }))}
                        className="mt-0.5 accent-navy" />
                      <div>
                        <div className="text-xs font-mono text-navy group-hover:text-inky">{opt.label}</div>
                        <div className="text-[9px] font-mono text-inky/50">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                  {formData.visibility === 'departments' && (
                    <div className="ml-4 mt-1 flex flex-col gap-1 border-l-2 border-navy/10 pl-3">
                      <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Share with departments:</span>
                      {DEPARTMENTS.filter((d) => d !== 'All').map((dept) => (
                        <label key={dept} className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={deptShares.includes(dept)} className="accent-navy"
                            onChange={(e) => setDeptShares((p) => e.target.checked ? [...p, dept] : p.filter((d) => d !== dept))} />
                          <span className="text-xs font-mono text-inky">{dept}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* Form options */}
                <div className="flex flex-col gap-2 pt-2 border-t border-navy/10">
                  {([
                    ['show_score_to_respondent', 'Show Score to Respondent'],
                    ['allow_multiple_submissions', 'Allow Multiple Submissions'],
                    ['requires_login', 'Requires Login'],
                    ['is_accepting_responses', 'Accepting Responses'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={!!(formData as any)[key]}
                        onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.checked }))}
                        className="accent-navy" />
                      <span className="text-xs font-mono text-inky">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {leftTab === 'appearance' && (
              <AppearancePanel
                theme={(formData.theme as FormTheme) ?? DEFAULT_THEME}
                onChange={(t) => setFormData((f) => ({ ...f, theme: t }))}
              />
            )}

            {leftTab === 'access' && (
              <SubmissionAccessTab formId={savedId} profile={profile} />
            )}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 overflow-y-auto p-6 bg-navy/5">
          {fields.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 rounded border-2 border-dashed border-navy/20">
              <p className="text-sm font-mono text-inky/50">Canvas is empty</p>
              <p className="text-xs font-mono text-inky/40">Add fields from the left panel or import from spreadsheet</p>
              <button onClick={() => setImportOpen(true)} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">↑ Import from Spreadsheet</button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-2 max-w-2xl mx-auto">
                  {fields.map((field) => (
                    <FieldCard
                      key={field.id}
                      field={field}
                      allFields={fields}
                      condition={conditionFor(field.id)}
                      clipboardFieldId={clipboardFieldId}
                      onUpdate={(patch) => updateField(field.id, patch)}
                      onDelete={() => deleteField(field.id)}
                      onDuplicate={() => duplicateField(field.id)}
                      onCopy={() => copyField(field.id)}
                      onPasteAbove={fieldClipboard ? () => pasteField(field.id, 'above') : null}
                      onPasteBelow={fieldClipboard ? () => pasteField(field.id, 'below') : null}
                      onConditionSave={saveCondition}
                      onConditionRemove={() => removeCondition(field.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* Share modal — updated with org/public clarity */}
      {shareOpen && shareUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-cream rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Share Form</h3>
              <button onClick={() => setShareOpen(false)} className="text-inky/50 hover:text-navy">✕</button>
            </div>

            {!formData.is_published && (
              <p className="text-xs font-mono text-amber-600 bg-amber-50 px-3 py-2 rounded border border-amber-200">
                This form is not yet published. Publish it first so respondents can access it.
              </p>
            )}

            {/* Link + badge */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm">{formData.requires_login ? '🔒' : '🌐'}</span>
                <span className="text-xs font-heading font-bold text-navy">
                  {formData.requires_login ? 'Org-Only Form Link' : 'Public Form Link'}
                </span>
              </div>
              <p className="text-[10px] font-mono text-inky/60">
                {formData.requires_login
                  ? 'Submitters must sign in with their SB Net account.'
                  : 'Anyone with this link can submit — no sign-in required.'}
              </p>
              <div className="flex gap-2">
                <input readOnly value={shareUrl} className="flex-1 rounded border border-navy/30 bg-navy/5 px-2 py-1.5 text-xs font-mono text-navy focus:outline-none" />
                <button onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success('Link copied') }}
                  className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
                  Copy
                </button>
              </div>
            </div>

            {/* Toggle auth requirement */}
            <div className="border-t border-navy/10 pt-3">
              <button
                onClick={async () => {
                  const next = !formData.requires_login
                  setFormData((f) => ({ ...f, requires_login: next }))
                  if (savedId) await sb.schema('forms').from('forms').update({ requires_login: next }).eq('id', savedId)
                  toast.success(next ? 'Now requires login' : 'Now public (no login required)')
                }}
                className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
                {formData.requires_login ? '🌐 Make Public' : '🔒 Require Sign-In'}
              </button>
            </div>

            {/* Department shares summary */}
            {formData.visibility === 'departments' && deptShares.length > 0 && (
              <div className="border-t border-navy/10 pt-3">
                <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Department Shares</p>
                <div className="flex flex-wrap gap-1">
                  {DEPARTMENTS.filter((d) => d !== 'All').map((d) => (
                    <span key={d}
                      className={['text-[10px] font-mono px-1.5 py-0.5 rounded border', deptShares.includes(d) ? 'border-[#00e5ff]/60 text-navy bg-[#00e5ff]/5' : 'border-navy/10 text-inky/40'].join(' ')}>
                      {d} {deptShares.includes(d) ? '✓' : '—'}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] font-mono text-inky/50 mt-1">Manage in Form Settings → General</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm overflow-y-auto py-8">
          <div className="w-full max-w-xl flex flex-col gap-0">
            <div className="flex justify-end mb-2">
              <button onClick={() => setPreviewOpen(false)} className="text-cream/80 hover:text-cream text-sm font-mono bg-navy/40 rounded px-3 py-1">✕ Close Preview</button>
            </div>
            <FormCanvas
              form={{ ...(formData as FormDefinition), id: '' }}
              fields={fields as FormField[]}
              conditions={conditions}
              previewMode
            />
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <ImportModal onImport={handleImport} onClose={() => setImportOpen(false)} />
      )}
    </div>
  )
}

// ── Inline form canvas (reused in preview + public view) ──────────────────────

export function FormCanvas({
  form, fields, conditions, previewMode = false,
  onSubmit, submittedBy, assignmentId,
}: {
  form: FormDefinition
  fields: FormField[]
  conditions: FieldCondition[]
  previewMode?: boolean
  onSubmit?: (data: any) => Promise<void>
  submittedBy?: string | null
  assignmentId?: string | null
}) {
  const [responses, setResponses] = useState<Record<string, any>>({})
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [anonName, setAnonName] = useState('')
  const [anonEmail, setAnonEmail] = useState('')
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})

  const colors = resolveThemeColors(form.theme)

  // Evaluate which fields are visible
  const visibleFieldIds = new Set<string>()
  for (const field of fields) {
    const cond = conditions.find((c) => c.target_field_id === field.id)
    if (!cond) { visibleFieldIds.add(field.id); continue }
    const results = cond.rules.map((rule) => {
      const src = responses[rule.source_field_id]
      switch (rule.operator) {
        case 'equals': return String(src ?? '') === rule.value
        case 'not_equals': return String(src ?? '') !== rule.value
        case 'contains': return String(src ?? '').includes(rule.value ?? '')
        case 'not_contains': return !String(src ?? '').includes(rule.value ?? '')
        case 'greater_than': return Number(src) > Number(rule.value)
        case 'less_than': return Number(src) < Number(rule.value)
        case 'is_answered': return src != null && src !== '' && !(Array.isArray(src) && src.length === 0)
        case 'is_empty': return src == null || src === '' || (Array.isArray(src) && src.length === 0)
        default: return false
      }
    })
    const condMet = cond.logic_operator === 'and' ? results.every(Boolean) : results.some(Boolean)
    if (cond.action === 'show' ? condMet : !condMet) visibleFieldIds.add(field.id)
  }

  const visibleFields = fields.filter((f) => visibleFieldIds.has(f.id))

  function setResp(fieldId: string, value: any) {
    setResponses((p) => ({ ...p, [fieldId]: value }))
    // Clear validation error on change
    if (validationErrors[fieldId]) {
      setValidationErrors((p) => { const n = { ...p }; delete n[fieldId]; return n })
    }
  }

  function calcScore(): { total: number; max: number } {
    let total = 0; let max = 0
    for (const field of visibleFields) {
      if (!['multiple_choice', 'multi_select', 'dropdown'].includes(field.field_type)) continue
      const opts = field.options
      if (!opts.length) continue
      max += Math.max(...opts.map((o) => o.score))
      const val = responses[field.id]
      if (field.field_type === 'multi_select' && Array.isArray(val)) {
        total += val.reduce((s, id) => s + (opts.find((o) => o.id === id)?.score ?? 0), 0)
      } else if (val) {
        total += opts.find((o) => o.id === val)?.score ?? 0
      }
    }
    return { total, max }
  }

  async function handleSubmit() {
    if (previewMode) { toast('Preview mode — not submitting'); return }

    // Validate required fields — inline errors instead of toast
    const errors: Record<string, string> = {}
    for (const field of visibleFields) {
      if (!field.is_required || field.field_type === 'text_block' || field.field_type === 'calculation') continue
      const val = responses[field.id]
      let empty = false
      if (field.field_type === 'multi_select') empty = !Array.isArray(val) || val.length === 0
      else if (field.field_type === 'file_upload') empty = !(files[field.id]?.length)
      else empty = val == null || val === ''
      if (empty) errors[field.id] = `"${field.label}" is required`
    }
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      // Scroll to first invalid field
      const firstId = Object.keys(errors)[0]
      document.getElementById(`form-field-${firstId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setValidationErrors({})

    if (!onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit({
        responses, files,
        anonName: anonName || null,
        anonEmail: anonEmail || null,
        ...calcScore(),
      })
      setSubmitted(true)
    } finally {
      setSubmitting(false)
    }
  }

  const { total, max } = calcScore()
  const cssVars = {
    '--form-bg': colors.background, '--form-surface': colors.surface,
    '--form-primary': colors.primary, '--form-accent': colors.accent,
    '--form-text': colors.text, '--form-label': colors.label,
    '--form-input-bg': colors.input_bg, '--form-input-border': colors.input_border,
    '--form-btn-bg': colors.button_bg, '--form-btn-text': colors.button_text,
  } as React.CSSProperties

  if (submitted) {
    return (
      <div className="form-root rounded-lg p-8 text-center flex flex-col gap-3" style={{ ...cssVars, background: colors.background }}>
        <div className="text-2xl">✓</div>
        <div className="text-lg font-bold" style={{ color: colors.text }}>Response Submitted</div>
        <div className="text-sm" style={{ color: colors.text, opacity: 0.7 }}>Thank you!</div>
        {form.show_score_to_respondent && max > 0 && (
          <div className="mt-2 text-sm font-bold" style={{ color: colors.accent }}>
            Your Score: {total} / {max}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="form-root rounded-lg overflow-hidden" style={{ ...cssVars, background: colors.background }}>
      {/* Header */}
      <div className="px-6 pt-6 pb-4" style={{ background: colors.background }}>
        {form.theme?.header_logo_key && (
          <img
            src={BRAND_ASSETS.find((a) => a.key === form.theme?.header_logo_key)?.path}
            alt="" className="h-16 object-contain mx-auto mb-4" style={{ maxHeight: 80 }} />
        )}
        {/* Org badge — shown on public form view */}
        {!previewMode && (
          <div className="flex justify-center mb-3">
            <span
              className="text-[10px] font-mono px-2 py-0.5 rounded-full border"
              style={{
                borderColor: colors.accent + '60',
                color: colors.accent,
                background: colors.accent + '15',
              }}>
              {form.requires_login ? '🔒 SB Net Members Only' : '🌐 Open Form — No Sign-In Required'}
            </span>
          </div>
        )}
        <h1 className="text-xl font-bold" style={{ color: colors.text }}>{form.title}</h1>
        {form.description && (
          <div className="mt-1 text-sm" style={{ color: colors.text, opacity: 0.8 }}>
            <RichTextDisplay html={form.description} />
          </div>
        )}
      </div>

      {/* Fields */}
      <div className="px-6 pb-6 flex flex-col gap-5">
        {/* Anon fields for public non-login forms */}
        {!submittedBy && !form.requires_login && (
          <div className="flex flex-col gap-3 pb-4 border-b" style={{ borderColor: colors.primary + '40' }}>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono" style={{ color: colors.label }}>Your Name (optional)</label>
              <input value={anonName} onChange={(e) => setAnonName(e.target.value)} placeholder="Name…"
                className="rounded border px-3 py-2 text-sm" style={{ background: colors.input_bg, borderColor: colors.input_border, color: colors.text }} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono" style={{ color: colors.label }}>Email (optional)</label>
              <input type="email" value={anonEmail} onChange={(e) => setAnonEmail(e.target.value)} placeholder="email@example.com"
                className="rounded border px-3 py-2 text-sm" style={{ background: colors.input_bg, borderColor: colors.input_border, color: colors.text }} />
            </div>
          </div>
        )}

        {visibleFields.map((field) => (
          <FieldRenderer
            key={field.id}
            field={field}
            value={responses[field.id] ?? null}
            fileList={files[field.id] ?? []}
            onChange={(v) => setResp(field.id, v)}
            onFiles={(fs) => setFiles((p) => ({ ...p, [field.id]: fs }))}
            colors={colors}
            scoreTotal={field.field_type === 'calculation' ? total : undefined}
            scoreMax={field.field_type === 'calculation' ? max : undefined}
            validationError={validationErrors[field.id] ?? null}
          />
        ))}

        {!previewMode && (
          <button
            onClick={handleSubmit}
            disabled={submitting || (!form.is_accepting_responses && !previewMode)}
            className="w-full rounded py-3 text-sm font-bold disabled:opacity-50 mt-2"
            style={{ background: colors.button_bg, color: colors.button_text }}>
            {submitting ? 'Submitting…' : !form.is_accepting_responses ? 'Submissions Closed' : 'Submit'}
          </button>
        )}
        {previewMode && (
          <button className="w-full rounded py-3 text-sm font-bold opacity-60 cursor-default mt-2"
            style={{ background: colors.button_bg, color: colors.button_text }}>
            Submit (Preview)
          </button>
        )}
      </div>
    </div>
  )
}

// ── Field Renderer ────────────────────────────────────────────────────────────

function FieldRenderer({
  field, value, fileList, onChange, onFiles, colors, scoreTotal, scoreMax, validationError,
}: {
  field: FormField
  value: any
  fileList: File[]
  onChange: (v: any) => void
  onFiles: (f: File[]) => void
  colors: FormColors
  scoreTotal?: number
  scoreMax?: number
  validationError?: string | null
}) {
  const inputClass = 'w-full rounded border px-3 py-2 text-sm focus:outline-none'
  const inputStyle = { background: colors.input_bg, borderColor: colors.input_border, color: colors.text }
  const errorInputStyle = { ...inputStyle, borderColor: '#ef4444' }
  const labelStyle = { color: colors.label }
  const textStyle = { color: colors.text }
  const hasError = !!validationError

  if (field.field_type === 'text_block') {
    return (
      <div className="py-1" style={textStyle}>
        <RichTextDisplay html={field.content ?? ''} />
      </div>
    )
  }

  if (field.field_type === 'calculation') {
    return (
      <div className="rounded px-4 py-3" style={{ background: colors.surface, borderLeft: `3px solid ${colors.accent}` }}>
        <div className="text-xs font-mono mb-1" style={labelStyle}>{field.calculation_config?.label ?? 'Total Score'}</div>
        <div className="text-2xl font-bold" style={{ color: colors.accent }}>
          {scoreTotal ?? 0} <span className="text-sm font-normal opacity-60">/ {scoreMax ?? 0}</span>
        </div>
      </div>
    )
  }

  return (
    <div id={`form-field-${field.id}`} className="flex flex-col gap-1.5">
      <label className="text-sm font-mono" style={labelStyle}>
        {field.label}{field.is_required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {field.helper_text && <p className="text-xs opacity-60" style={textStyle}>{field.helper_text}</p>}

      {field.field_type === 'short_answer' && (
        <input className={inputClass} style={hasError ? errorInputStyle : inputStyle}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? ''} />
      )}

      {field.field_type === 'long_answer' && (
        <textarea className={inputClass} style={hasError ? errorInputStyle : inputStyle}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          rows={4} placeholder={field.placeholder ?? ''} />
      )}

      {field.field_type === 'date' && (
        <input type="date" className={inputClass} style={hasError ? errorInputStyle : inputStyle}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      )}

      {field.field_type === 'number' && (
        <input type="number" className={inputClass} style={hasError ? errorInputStyle : inputStyle}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? ''} />
      )}

      {field.field_type === 'multiple_choice' && (
        <div className={['flex flex-col gap-2', hasError ? 'rounded border border-red-400 p-2' : ''].join(' ')}>
          {field.options.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name={field.id} checked={value === opt.id} onChange={() => onChange(opt.id)}
                style={{ accentColor: colors.accent }} />
              <span className="text-sm" style={textStyle}>{opt.label}</span>
            </label>
          ))}
        </div>
      )}

      {field.field_type === 'multi_select' && (
        <div className={['flex flex-col gap-2', hasError ? 'rounded border border-red-400 p-2' : ''].join(' ')}>
          {field.options.map((opt) => {
            const checked = Array.isArray(value) && value.includes(opt.id)
            return (
              <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={checked} style={{ accentColor: colors.accent }}
                  onChange={(e) => {
                    const curr: string[] = Array.isArray(value) ? value : []
                    onChange(e.target.checked ? [...curr, opt.id] : curr.filter((id) => id !== opt.id))
                  }} />
                <span className="text-sm" style={textStyle}>{opt.label}</span>
              </label>
            )
          })}
        </div>
      )}

      {field.field_type === 'dropdown' && (
        <select className={inputClass} style={hasError ? errorInputStyle : inputStyle}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {field.options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
        </select>
      )}

      {field.field_type === 'file_upload' && (
        <FileUploadZone
          accept={(field.file_types_allowed ?? []).join(',')}
          maxMb={field.max_file_size_mb}
          files={fileList}
          onChange={onFiles}
          colors={colors}
          hasError={hasError}
        />
      )}

      {/* Inline validation error */}
      {hasError && (
        <p className="text-xs font-mono text-red-500 mt-0.5">{validationError}</p>
      )}
    </div>
  )
}

function FileUploadZone({ accept, maxMb, files, onChange, colors, hasError = false }: {
  accept: string; maxMb: number; files: File[]; onChange: (f: File[]) => void; colors: FormColors; hasError?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function handleFiles(newFiles: FileList | null) {
    if (!newFiles) return
    const valid = Array.from(newFiles).filter((f) => {
      if (f.size > maxMb * 1024 * 1024) { toast.error(`${f.name} exceeds ${maxMb} MB`); return false }
      return true
    })
    onChange([...files, ...valid])
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        className="rounded border-2 border-dashed cursor-pointer px-4 py-6 text-center transition-colors"
        style={{ borderColor: hasError ? '#ef4444' : dragging ? colors.accent : colors.input_border, background: colors.input_bg }}>
        <p className="text-sm" style={{ color: colors.text, opacity: 0.7 }}>Drop files here or click to browse</p>
        <p className="text-xs mt-1" style={{ color: colors.text, opacity: 0.4 }}>Max {maxMb} MB per file</p>
        <input ref={inputRef} type="file" multiple accept={accept} className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      </div>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-xs" style={{ color: colors.text }}>
              <span className="truncate flex-1">{f.name}</span>
              <span style={{ opacity: 0.5 }}>({(f.size / 1024).toFixed(0)} KB)</span>
              <button onClick={() => onChange(files.filter((_, j) => j !== i))} style={{ color: colors.accent, opacity: 0.7 }} className="hover:opacity-100">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
