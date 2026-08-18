import { useEffect, useMemo, useState } from 'react'
import { Combobox, MultiSelectDropdown } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { supabase } from '@/lib/supabase'

interface Props {
  companyId: string | null
  locationId: string | null
  selected: string[]
  onChange: (ids: string[]) => void
  compact?: boolean
}

// Which of the shop's products a finding affects. A checkbox multi-select
// (not a wall of toggle chips — that made table rows balloon in height) over
// the shop's configured products, plus a combobox to add one that isn't
// configured. In the full-edit modal, selected products are also called out
// as removable pills, matching the "N shops ignored" chip list on the Tank
// Monitors Low VMI page.
export function ImpactedProductsPicker({ companyId, locationId, selected, onChange, compact }: Props) {
  const [configured, setConfigured] = useState<string[]>([])
  const [usage, setUsage] = useState<string[]>([])
  const [addPick, setAddPick] = useState('')

  useEffect(() => {
    if (!companyId || !locationId) { setConfigured([]); setUsage([]); return }
    const sb = supabase as any
    Promise.all([
      sb.schema('inventory').from('location_order_config').select('product_id').eq('company_id', companyId).eq('location_id', locationId),
      sb.schema('inventory').from('product_usage').select('product_id').eq('company_id', companyId).eq('location_id', locationId),
    ]).then(([c, u]: any[]) => {
      setConfigured([...new Set(((c.data ?? []) as any[]).map((r) => r.product_id).filter(Boolean))] as string[])
      setUsage([...new Set(((u.data ?? []) as any[]).map((r) => r.product_id).filter(Boolean))] as string[])
    })
  }, [companyId, locationId])

  // Checkbox options: configured products plus anything already selected (so
  // a product added via the combobox below still shows as a checked row).
  const options = useMemo(() =>
    [...new Set([...configured, ...selected])].sort().map((pid) => ({ value: pid })),
  [configured, selected])

  const addOptions: ComboboxOption[] = useMemo(() =>
    usage.filter((pid) => !options.some((o) => o.value === pid)).sort().map((pid) => ({ value: pid, label: pid })),
  [usage, options])

  const remove = (pid: string) => onChange(selected.filter((x) => x !== pid))

  const dropdown = (
    <MultiSelectDropdown options={options} selected={selected} onChange={onChange} showAllOption={false} countNoun="products"
      placeholder={locationId ? 'No products' : 'Pick a shop first'} />
  )

  if (compact) return dropdown

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Impacted Products</span>
      <div className="flex items-center gap-2">
        {dropdown}
        {locationId && (
          <div className="w-56">
            <Combobox options={addOptions} value={addPick}
              onChange={(v) => { if (v && !selected.includes(v)) onChange([...selected, v]); setAddPick('') }}
              placeholder="Add another product…" allowCreate onCreateOption={async (v) => ({ value: v, label: v })} />
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.map((pid) => (
            <span key={pid} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-[11px] font-mono text-navy">
              {pid}
              <button type="button" onClick={() => remove(pid)} title="Remove" className="text-inky/50 hover:text-[#C0392B]">✕</button>
            </span>
          ))}
          <button type="button" onClick={() => onChange([])} className="text-inky/50 hover:text-navy hover:underline self-center text-[11px] font-mono">reset all</button>
        </div>
      )}
    </div>
  )
}
