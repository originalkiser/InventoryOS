// Summary — direct ask 2026-10-02. Shops with any custom pricing/package
// arrangement, and how many custom-priced products fall into each product
// category (via inventory.category_simplification — Oil/Parts/Additives;
// unmapped/null is its own "Other" bucket for display, there's no literal
// "Other" value stored).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { SbLoader } from '@/components/ui'

const SIMPLE_CATS = ['Oil', 'Parts', 'Additives'] as const
type SimpleCat = (typeof SIMPLE_CATS)[number] | 'Other'

export function SummaryTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations('other')
  const [pricingRows, setPricingRows] = useState<{ location_id: string; product_id: string }[] | null>(null)
  const [packageCounts, setPackageCounts] = useState<Map<string, number>>(new Map())
  const [categoryByProduct, setCategoryByProduct] = useState<Map<string, SimpleCat>>(new Map())

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const [pricingRes, packagesRes, simplRes] = await Promise.all([
      sb.schema('inventory').from('custom_product_pricing').select('location_id, product_id').eq('company_id', companyId),
      sb.schema('inventory').from('custom_packages').select('location_id').eq('company_id', companyId),
      sb.schema('inventory').from('category_simplification').select('category, simple_category').eq('company_id', companyId),
    ])
    setPricingRows((pricingRes.data ?? []) as { location_id: string; product_id: string }[])
    const pkgCounts = new Map<string, number>()
    for (const r of (packagesRes.data ?? []) as { location_id: string }[]) pkgCounts.set(r.location_id, (pkgCounts.get(r.location_id) ?? 0) + 1)
    setPackageCounts(pkgCounts)
    const simplMap = new Map<string, string | null>(
      (simplRes.data ?? []).map((r: { category: string; simple_category: string | null }): [string, string | null] => [r.category, r.simple_category]),
    )

    // Resolve each custom-priced product's category via product_usage
    // (its own rolling-rate table, cheap — only the distinct product ids
    // actually marked custom need resolving, never the full table).
    const productIds = [...new Set(((pricingRes.data ?? []) as { product_id: string }[]).map((r) => r.product_id))]
    const catByProduct = new Map<string, SimpleCat>()
    if (productIds.length) {
      const { data: puRows } = await sb.schema('inventory').from('product_usage')
        .select('product_id, category').eq('company_id', companyId).in('product_id', productIds)
      for (const r of (puRows ?? []) as { product_id: string; category: string | null }[]) {
        if (catByProduct.has(r.product_id)) continue
        const simple = r.category ? simplMap.get(r.category) : null
        catByProduct.set(r.product_id, (simple && (SIMPLE_CATS as readonly string[]).includes(simple) ? simple as SimpleCat : 'Other'))
      }
    }
    setCategoryByProduct(catByProduct)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const rows = useMemo(() => {
    if (!pricingRows) return []
    const byShop = new Map<string, Record<SimpleCat, number>>()
    for (const r of pricingRows) {
      const cat = categoryByProduct.get(r.product_id) ?? 'Other'
      const counts = byShop.get(r.location_id) ?? { Oil: 0, Parts: 0, Additives: 0, Other: 0 }
      counts[cat]++
      byShop.set(r.location_id, counts)
    }
    // Shops with custom PACKAGES but no custom PRICING still get a row.
    for (const locationId of packageCounts.keys()) {
      if (!byShop.has(locationId)) byShop.set(locationId, { Oil: 0, Parts: 0, Additives: 0, Other: 0 })
    }
    return [...byShop.entries()]
      .map(([locationId, counts]) => ({
        locationId,
        shopLabel: loc.locations.find((l) => l.id === locationId)?.shop_city || loc.locations.find((l) => l.id === locationId)?.name || locationId,
        counts,
        packageCount: packageCounts.get(locationId) ?? 0,
        total: counts.Oil + counts.Parts + counts.Additives + counts.Other,
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
  }, [pricingRows, categoryByProduct, packageCounts, loc.locations])

  if (pricingRows === null || loc.loading) return <div className="py-8"><SbLoader /></div>

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Summary</h2>
        <p className="text-xs text-inky mt-0.5">Every shop with custom pricing and/or custom packages, with a category breakdown of custom-priced products.</p>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-6 text-center">No shops have custom pricing or custom packages yet.</p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
              <th className="text-left px-3 py-2 sticky left-0 bg-cream">Shop</th>
              <th className="text-right px-3 py-2">Custom Packages</th>
              {SIMPLE_CATS.map((c) => <th key={c} className="text-right px-3 py-2">{c}</th>)}
              <th className="text-right px-3 py-2">Other</th>
              <th className="text-right px-3 py-2 font-bold">Total Custom Products</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.locationId} className="border-b border-navy/10 hover:bg-navy/5">
                  <td className="px-3 py-2 text-navy sticky left-0 bg-cream whitespace-nowrap">{r.shopLabel}</td>
                  <td className="px-3 py-2 text-right text-inky">{r.packageCount || '—'}</td>
                  {SIMPLE_CATS.map((c) => <td key={c} className="px-3 py-2 text-right text-inky">{r.counts[c] || '—'}</td>)}
                  <td className="px-3 py-2 text-right text-inky">{r.counts.Other || '—'}</td>
                  <td className="px-3 py-2 text-right text-navy font-bold">{r.total || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
