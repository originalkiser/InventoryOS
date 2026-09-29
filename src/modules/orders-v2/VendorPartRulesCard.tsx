// Orders v2-specific per-product settings that otherwise only live on
// inventory.vendor_parts (Config -> Vendor Parts) — direct ask 2026-09-29,
// "so a user can edit from there vs having to navigate to the config
// page." Deliberately a narrow, Orders-v2-scoped view of that same table
// (critical minimum + the "order alone" exception only), not a
// reimplementation of VendorPartsTab.tsx's own full editor (part number,
// cost, package size, etc. — none of that belongs in Order Settings).
import { useEffect, useMemo, useState } from 'react'
import { Card, CardBody, Input, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useVendors } from './useLookups'
import toast from 'react-hot-toast'

const sb = () => supabase as any

interface PartRow {
  id: string
  vendor_id: string | null
  our_part_number: string | null
  min_on_hand_qty: number | null
  can_ignore_minimum: boolean | null
  default_order_amount_if_alone: number | null
}

export function VendorPartRulesCard() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const vendors = useVendors()
  const [rows, setRows] = useState<PartRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!companyId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    sb().schema('inventory').from('vendor_parts')
      .select('id, vendor_id, our_part_number, min_on_hand_qty, can_ignore_minimum, default_order_amount_if_alone')
      .eq('company_id', companyId).order('our_part_number')
      .then(({ data, error }: any) => {
        if (cancelled) return
        if (error) { toast.error(error.message); setLoading(false); return }
        setRows((data ?? []) as PartRow[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [companyId])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => (r.our_part_number ?? '').toLowerCase().includes(q))
  }, [rows, search])

  async function patch(id: string, patch: Partial<PartRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    const { error } = await sb().schema('inventory').from('vendor_parts').update(patch).eq('id', id)
    if (error) toast.error(error.message)
  }

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Product Minimums &amp; Order-Alone Exceptions</h3>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5">
          Same fields as Config → Vendor Parts, editable here directly. <strong>Critical Min</strong> keeps enough
          on-hand for at least one service — if a product's on-hand drops to or below this (in quarts), it's ordered
          regardless of the usual days-of-supply trigger. <strong>Can Order Alone</strong> lets a product ship by
          itself in the amount below (e.g. 2 cases) without pulling in other products or tripping the "below minimum"
          flag, when it's the only thing on the order for that shop.
        </p>
      </div>
      <Input placeholder="Search product ID…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
      {loading ? (
        <p className="text-xs font-mono text-inky/50">Loading…</p>
      ) : (
        <div className="overflow-auto rounded border border-navy/20 max-h-96">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-cream">
              <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                <th className="px-2 py-1.5 text-left">Product</th>
                <th className="px-2 py-1.5 text-left">Vendor</th>
                <th className="px-2 py-1.5 text-right">Critical Min (qty)</th>
                <th className="px-2 py-1.5 text-center">Can Order Alone</th>
                <th className="px-2 py-1.5 text-right">Order Alone Qty</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.id} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                  <td className="px-2 py-1 text-navy whitespace-nowrap">{r.our_part_number}</td>
                  <td className="px-2 py-1 text-inky/70 whitespace-nowrap">{vendors.byId(r.vendor_id)?.name ?? '—'}</td>
                  <td className="px-2 py-1 text-right">
                    <input type="number" min={0} defaultValue={r.min_on_hand_qty ?? ''}
                      onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== r.min_on_hand_qty) patch(r.id, { min_on_hand_qty: v }) }}
                      className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-sky" />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <div className="flex justify-center">
                      <Toggle size="sm" color="cyan" checked={!!r.can_ignore_minimum}
                        onChange={(v) => patch(r.id, { can_ignore_minimum: v })} />
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right">
                    {r.can_ignore_minimum ? (
                      <input type="number" min={0} defaultValue={r.default_order_amount_if_alone ?? ''}
                        onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== r.default_order_amount_if_alone) patch(r.id, { default_order_amount_if_alone: v }) }}
                        className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-sky" />
                    ) : <span className="text-inky/30">—</span>}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-4 text-center text-inky/40 italic">No products match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </CardBody></Card>
  )
}
