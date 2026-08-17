import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocations } from '@/hooks/useLocations'
import { naturalCompare } from '@/lib/naturalSort'
import type { LocationGroupField, LocationGroupTag } from '@/types'

export interface LocationSelectionValue {
  ids: string[]
  groups: LocationGroupTag[]
}

interface Props {
  value: LocationSelectionValue
  onChange: (v: LocationSelectionValue) => void
  placeholder?: string
  compact?: boolean // tighter, height-capped footprint for use inside a grid cell
}

const GROUP_LABEL: Record<LocationGroupField, string> = { market: 'Market', area_manager: 'Area Manager', director: 'Regional Director' }

function mostCommon(vals: (string | null | undefined)[]): string | undefined {
  const counts = new Map<string, number>()
  for (const v of vals) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function groupTagLabel(g: LocationGroupTag): string {
  const label = GROUP_LABEL[g.field]
  if (g.extra && g.field === 'area_manager') return `${label}: ${g.value} (${g.extra} Market)`
  if (g.extra && g.field === 'market') return `${label}: ${g.value} (AM: ${g.extra})`
  return `${label}: ${g.value}`
}

// Multi-select for locations: removable chips + a dropdown with individual
// checkboxes plus "select all in Market / Area Manager / Regional Director"
// bulk-add shortcuts. Group picks are remembered as separate tags (shown
// alongside the shop chips) so it's clear the selection came from a market
// or AM/RD sweep, not a one-by-one pick. Used by Projects and Meeting Notes.
export function LocationMultiSelect({ value, onChange, placeholder = '+ Add locations', compact = false }: Props) {
  const loc = useLocations()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { ids: selected, groups } = value

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

  const groupOptions = (field: LocationGroupField) =>
    [...new Set(active.map((l) => (l as any)[field]).filter(Boolean) as string[])].sort()

  function toggle(id: string) {
    onChange({ ids: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], groups })
  }
  function remove(id: string) {
    onChange({ ids: selected.filter((x) => x !== id), groups })
  }
  function removeGroup(g: LocationGroupTag) {
    onChange({ ids: selected, groups: groups.filter((x) => !(x.field === g.field && x.value === g.value)) })
  }
  function addGroup(field: LocationGroupField, groupValue: string) {
    if (!groupValue) return
    const matches = active.filter((l) => (l as any)[field] === groupValue)
    const nextIds = new Set(selected)
    for (const l of matches) nextIds.add(l.id)
    let extra: string | undefined
    if (field === 'area_manager') extra = mostCommon(matches.map((l) => l.market))
    else if (field === 'market') extra = mostCommon(matches.map((l) => l.area_manager))
    const tag: LocationGroupTag = { field, value: groupValue, extra }
    const nextGroups = [...groups.filter((g) => !(g.field === field && g.value === groupValue)), tag]
    onChange({ ids: [...nextIds], groups: nextGroups })
  }

  const chipCls = compact ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1'
  const hasChips = groups.length > 0 || selected.length > 0

  return (
    <div ref={ref} className="relative flex flex-col gap-1.5">
      {hasChips && (
        <div className={compact ? 'max-h-16 overflow-y-auto flex flex-wrap gap-1 pr-0.5' : 'flex flex-wrap gap-1'}>
          {groups.map((g) => (
            <span key={`${g.field}:${g.value}`} className={`inline-flex items-center gap-1 rounded border border-sky/50 bg-sky/15 font-mono text-navy font-semibold ${chipCls}`}>
              {groupTagLabel(g)}
              <button type="button" onClick={() => removeGroup(g)} title="Remove group selection" className="text-inky/50 hover:text-[#C0392B] leading-none">✕</button>
            </span>
          ))}
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
