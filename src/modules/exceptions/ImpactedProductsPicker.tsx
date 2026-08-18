import { useEffect, useMemo, useState } from 'react'
import { Combobox } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { supabase } from '@/lib/supabase'

interface Props {
  companyId: string | null
  locationId: string | null
  selected: string[]
  onChange: (ids: string[]) => void
  compact?: boolean
}

// Which of the shop's products a finding affects — mirrors Location Comms'
// "Products Requested" picker (chip-toggle over configured products, plus a
// combobox to add a product not configured for this shop). Shared by the
// inline table cell and the full-edit modal.
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

  const selectedSet = new Set(selected)
  const toggle = (pid: string) => onChange(selectedSet.has(pid) ? selected.filter((x) => x !== pid) : [...selected, pid])
  const remove = (pid: string) => onChange(selected.filter((x) => x !== pid))
  // Already-selected products that aren't in the configured list (added via the combobox).
  const extras = selected.filter((pid) => !configured.includes(pid))

  const addOptions: ComboboxOption[] = useMemo(() =>
    usage.filter((pid) => !configured.includes(pid) && !selectedSet.has(pid)).sort().map((pid) => ({ value: pid, label: pid })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [usage, configured, selected])

  return (
    <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}>
      {!compact && <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Impacted Products</span>}
      <div className="flex flex-wrap gap-1">
        {configured.length === 0 && extras.length === 0 && (
          <span className="text-[11px] font-mono text-inky/40 italic">{locationId ? 'No configured products for this shop' : 'Pick a shop first'}</span>
        )}
        {configured.map((pid) => (
          <button key={pid} type="button" onClick={() => toggle(pid)}
            className={['px-2 py-0.5 rounded text-[11px] font-mono border transition-colors', selectedSet.has(pid) ? 'bg-navy text-cream border-navy' : 'bg-cream text-navy border-navy/30 hover:border-navy'].join(' ')}>
            {pid}
          </button>
        ))}
        {extras.map((pid) => (
          <span key={pid} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-navy text-cream border border-navy">
            {pid}<button type="button" onClick={() => remove(pid)} className="hover:text-red-300">×</button>
          </span>
        ))}
      </div>
      {locationId && (
        <div className={compact ? 'w-40' : 'w-64'}>
          <Combobox options={addOptions} value={addPick}
            onChange={(v) => { if (v && !selectedSet.has(v)) onChange([...selected, v]); setAddPick('') }}
            placeholder="Add another product…" allowCreate onCreateOption={async (v) => ({ value: v, label: v })} />
        </div>
      )}
    </div>
  )
}
