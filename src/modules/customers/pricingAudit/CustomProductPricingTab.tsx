// Custom Product Pricing — direct ask 2026-10-02. Reviews/manages which
// (shop, product) pairs have been marked as intentionally custom retail/
// cost pricing from the Product Pricing Audit tab (writes into
// inventory.custom_product_pricing, migration 20260930cc) — grouped by
// shop, since that's how the audit's own marking flow scopes selections.
// Unmarking here puts a row back into scope for the next audit pass.
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Card, CardBody, SbLoader } from '@/components/ui'
import { X } from 'lucide-react'

interface CustomPricingRow {
  id: string
  location_id: string
  product_id: string
  notes: string | null
}

export function CustomProductPricingTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations('other')
  const [rows, setRows] = useState<CustomPricingRow[] | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('custom_product_pricing')
      .select('id, location_id, product_id, notes').eq('company_id', companyId)
    setRows((data ?? []) as CustomPricingRow[])
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function unmark(id: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('custom_product_pricing').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setRows((prev) => (prev ?? []).filter((r) => r.id !== id))
    toast.success('Unmarked — back in scope for the Product Pricing Audit')
  }

  const byShop = useMemo(() => {
    const m = new Map<string, CustomPricingRow[]>()
    for (const r of rows ?? []) {
      const arr = m.get(r.location_id) ?? []
      arr.push(r)
      m.set(r.location_id, arr)
    }
    return [...m.entries()]
      .map(([locationId, products]) => ({
        locationId,
        shopLabel: loc.locations.find((l) => l.id === locationId)?.shop_city || loc.locations.find((l) => l.id === locationId)?.name || locationId,
        products: products.sort((a, b) => a.product_id.localeCompare(b.product_id)),
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
  }, [rows, loc.locations])

  if (rows === null || loc.loading) return <div className="py-8"><SbLoader /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Custom Product Pricing</h2>
        <p className="text-xs text-inky mt-0.5">
          Shops with products marked as intentionally custom-priced — excluded from the Product Pricing Audit.
          Unmark a product to put it back in scope.
        </p>
      </div>

      {byShop.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-6 text-center">
          Nothing marked yet — mark products as custom from the Product Pricing Audit tab.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {byShop.map((shop) => (
            <Card key={shop.locationId}><CardBody className="flex flex-col gap-2">
              <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">{shop.shopLabel}</span>
              <div className="flex flex-col gap-1">
                {shop.products.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-xs font-mono text-inky border-b border-navy/10 pb-1">
                    <span>{p.product_id}</span>
                    <button onClick={() => unmark(p.id)} title="Unmark — put back in scope for the audit" className="text-inky/40 hover:text-[#C0392B]">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </CardBody></Card>
          ))}
        </div>
      )}
    </div>
  )
}
