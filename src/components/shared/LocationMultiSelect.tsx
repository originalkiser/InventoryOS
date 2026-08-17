import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocations } from '@/hooks/useLocations'
import { naturalCompare } from '@/lib/naturalSort'

interface Props {
  selected: string[] // location ids
  onChange: (ids: string[]) => void
  placeholder?: string
  compact?: boolean // tighter chips/trigger for use inside a grid cell
}

// Multi-select for locations: removable chips + a dropdown with individual
// checkboxes plus "select all in Market / Area Manager / Regional Director"
// bulk-add shortcuts. Used by Projects and Meeting Notes.
export function LocationMultiSelect({ selected, onChange, placeholder = '+ Add locations', compact = false }: Props) {
  const loc = useLocations()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOut(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [open])

  const active = useMemo(() => loc.locations.filter((l) => l.active), [loc.locations])
  const labelOf = (id: string) => { const l = loc.byId(id); return l ? (l.shop_city || l.name) : id }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? active.filter((l) => (l.name ?? '').toLowerCase().includes(q) || (l.shop_city ?? '').toLowerCase().includes(q))
      : active
    return [...list].sort((a, b) => naturalCompare(a.shop_city || a.name, b.shop_city || b.name))
  }, [active, search])

  const groupOptions = (field: 'market' | 'area_manager' | 'director') =>
    [...new Set(active.map((l) => (l as any)[field]).filter(Boolean) as string[])].sort()

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }
  function remove(id: string) {
    onChange(selected.filter((x) => x !== id))
  }
  function addGroup(field: 'market' | 'area_manager' | 'director', value: string) {
    if (!value) return
    const ids = active.filter((l) => (l as any)[field] === value).map((l) => l.id)
    const next = new Set(selected)
    for (const id of ids) next.add(id)
    onChange([...next])
  }

  const chipCls = compact ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1'

  return (
    <div ref={ref} className="relative flex flex-col gap-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => (
            <span key={id} className={`inline-flex items-center gap-1 rounded border border-navy/20 bg-navy/[0.04] font-mono text-navy ${chipCls}`}>
              {labelOf(id)}
              <button type="button" onClick={() => remove(id)} title="Remove" className="text-inky/50 hover:text-[#C0392B] leading-none">✕</button>
            </span>
          ))}
        </div>
      )}

      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`self-start rounded border border-navy/30 font-mono text-inky hover:border-navy hover:text-navy transition-colors ${chipCls}`}>
        {placeholder}
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-72 rounded border border-navy/30 bg-cream dark:bg-[#0e2638] shadow-xl flex flex-col">
          <div className="p-2 border-b border-navy/10 flex flex-col gap-1.5">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search locations…" autoFocus
              className="w-full rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy dark:text-[#F2F1E6] placeholder-inky/40 focus:border-sky focus:outline-none" />
            <div className="grid grid-cols-1 gap-1">
              <GroupPicker label="Add all in Market…" options={groupOptions('market')} onPick={(v) => addGroup('market', v)} />
              <GroupPicker label="Add all for Area Manager…" options={groupOptions('area_manager')} onPick={(v) => addGroup('area_manager', v)} />
              <GroupPicker label="Add all for Regional Director…" options={groupOptions('director')} onPick={(v) => addGroup('director', v)} />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto p-1 flex flex-col gap-px">
            {filtered.length === 0 ? (
              <span className="px-2 py-2 text-xs font-mono text-inky/50 italic">No locations found</span>
            ) : filtered.map((l) => (
              <label key={l.id} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-navy/5 select-none">
                <input type="checkbox" checked={selected.includes(l.id)} onChange={() => toggle(l.id)} className="accent-sky w-3.5 h-3.5 shrink-0" />
                <span className="text-xs font-mono text-navy dark:text-[#F2F1E6] flex-1 truncate">{l.shop_city || l.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function GroupPicker({ label, options, onPick }: { label: string; options: string[]; onPick: (value: string) => void }) {
  return (
    <select value="" onChange={(e) => { onPick(e.target.value); e.currentTarget.value = '' }} disabled={options.length === 0}
      className="w-full rounded border border-navy/20 bg-cream dark:bg-[#122b40] px-1.5 py-1 text-[11px] font-mono text-inky disabled:opacity-40 focus:border-sky focus:outline-none">
      <option value="" disabled>{label}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}
