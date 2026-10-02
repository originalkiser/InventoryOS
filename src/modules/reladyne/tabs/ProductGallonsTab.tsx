// Product Gallons — by-product gallons/revenue derived live from
// reladyne_volume_data (the same role the Product Gallons workbook's own
// "Product Pivot" sheet plays, just computed here instead of re-stored — see
// migration 20260930by's header comment).
//
// Reworked 2026-10-02: one shared filter bar (period with real dates,
// product, package type, market, shop) drives five views — Summary (period
// rollup), By Month (per-month trend), Charts, Underperformers (markets/shops
// with poor billed % of ordered), and Product Mapping (Bulk/Package/Drum).
// "Delivered" in the source data is gallons_billed, so it's labeled Billed.
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Select, SbLoader, MultiSelectDropdown, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { useReladyneVolumeData, useReladyneProductGroupMap } from '../useMmrData'
import {
  GROUP_KEYS, GROUP_LABELS, defaultGroupFor, shopNumberFromShipTo, billedPct, monthsBackOptionsWithDates,
  trailingPeriods, num0, pct1, money, type GroupKey,
} from '../mmrShared'
import { sumRows, groupRows, type GRow, type GroupByDim, type MonthMetric } from './gallons/gallonsData'
import { GallonsByMonth } from './gallons/GallonsByMonth'
import { GallonsCharts } from './gallons/GallonsCharts'
import { GallonsUnderperformers } from './gallons/GallonsUnderperformers'
import { GallonsMapping, type MappingProduct } from './gallons/GallonsMapping'

interface ProductRow {
  productDesc: string
  group: GroupKey
  ordered: number
  billed: number
  billedPct: number | null
  revenue: number
  revenuePerGallon: number | null
}

const TABLE_KEY = 'reladyne.product_gallons'
const UNMAPPED = 'Unmapped'

const byNumeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-navy/30 bg-cream px-3 py-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-inky/70">{label}</div>
      <div className="text-lg font-heading font-bold text-navy">{value}</div>
      {sub && <div className="text-[10px] font-mono text-inky/60">{sub}</div>}
    </div>
  )
}

export function ProductGallonsTab() {
  const { rows: raw, loading } = useReladyneVolumeData()
  const mapping = useReladyneProductGroupMap()
  const loc = useLocations('other')

  const [preset, setPreset] = useState('3')
  const [products, setProducts] = useState<string[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [markets, setMarkets] = useState<string[]>([])
  const [shops, setShops] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<GroupByDim>('product')
  const [metric, setMetric] = useState<MonthMetric>('both')
  const [threshold, setThreshold] = useState(95)
  const [minOrdered, setMinOrdered] = useState(100)
  // Tabs is uncontrolled — a drill-down from Underperformers forces a switch
  // by remounting it on the target tab.
  const [tab, setTab] = useState('summary')
  const [tabKey, setTabKey] = useState(0)

  const presetOptions = useMemo(() => monthsBackOptionsWithDates(raw.map((r) => r.period)), [raw])
  const periods = useMemo(() => trailingPeriods(raw.map((r) => r.period), preset === 'all' ? 'all' : Number(preset)), [raw, preset])

  // Shop number (from RelaDyne's ship-to name) -> market, via core.locations.name.
  const marketByShop = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of loc.locations) {
      const market = String((l as any).market ?? (l.metadata as any)?.market ?? '').trim()
      m.set(String(l.name).trim(), market || UNMAPPED)
    }
    return m
  }, [loc.locations])

  const enriched = useMemo((): GRow[] => raw.map((r) => {
    const shop = shopNumberFromShipTo(r.ship_to_name) ?? (r.ship_to_name?.trim() || 'Unknown')
    return {
      period: r.period,
      productDesc: r.product_desc,
      group: mapping.overrides.get(r.product_desc) ?? defaultGroupFor(r.package_group, r.product_desc),
      shop,
      market: marketByShop.get(shop) ?? UNMAPPED,
      ordered: Number(r.gallons_ordered ?? 0),
      billed: Number(r.gallons_billed ?? 0),
      revenue: Number(r.revenue ?? 0),
    }
  }), [raw, mapping.overrides, marketByShop])

  const inSel = (sel: string[], v: string) => sel.length === 0 || sel.includes(v)
  // Period + product + package type only — Underperformers' own input, since
  // it must still see every market/shop to find the weak ones.
  const scoped = useMemo(
    () => enriched.filter((r) => periods.has(r.period) && inSel(products, r.productDesc) && inSel(groups, GROUP_LABELS[r.group])),
    [enriched, periods, products, groups],
  )
  const filtered = useMemo(() => scoped.filter((r) => inSel(markets, r.market) && inSel(shops, r.shop)), [scoped, markets, shops])

  const productOptions = useMemo(() => [...new Set(enriched.map((r) => r.productDesc))].sort(byNumeric).map((value) => ({ value })), [enriched])
  const groupOptions = useMemo(() => GROUP_KEYS.map((g) => ({ value: GROUP_LABELS[g] })), [])
  const marketOptions = useMemo(() => [...new Set(enriched.map((r) => r.market))].sort(byNumeric).map((value) => ({ value })), [enriched])
  const shopOptions = useMemo(() => [...new Set(enriched.map((r) => r.shop))].sort(byNumeric).map((value) => ({ value })), [enriched])

  const mappingProducts = useMemo((): MappingProduct[] => {
    const m = new Map<string, MappingProduct>()
    for (const r of raw) {
      const cur = m.get(r.product_desc) ?? { productDesc: r.product_desc, packageGroup: r.package_group, defaultGroup: defaultGroupFor(r.package_group, r.product_desc), billedAllTime: 0 }
      cur.billedAllTime += Number(r.gallons_billed ?? 0)
      m.set(r.product_desc, cur)
    }
    return [...m.values()]
  }, [raw])

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = useMemo(() => sumRows(filtered), [filtered])
  const perGroup = useMemo(() => {
    const g = groupRows(filtered, (r) => r.group)
    return GROUP_KEYS.map((k) => ({ key: k, agg: sumRows(g.get(k) ?? []) }))
  }, [filtered])

  const productRows = useMemo((): ProductRow[] => [...groupRows(filtered, (r) => r.productDesc).entries()].map(([productDesc, list]) => {
    const a = sumRows(list)
    return {
      productDesc, group: list[0].group, ordered: a.ordered, billed: a.billed, billedPct: billedPct(a.ordered, a.billed),
      revenue: a.revenue, revenuePerGallon: a.billed > 0 ? a.revenue / a.billed : null,
    }
  }), [filtered])

  const col = useMemo(() => createColumnHelper<ProductRow>(), [])
  const columns = useMemo(() => [
    col.accessor('productDesc', { id: 'product', header: 'Product' }),
    col.accessor((r) => GROUP_LABELS[r.group], { id: 'package_type', header: 'Package Type' }),
    col.accessor('ordered', { id: 'gallons_ordered', header: 'Gallons Ordered', cell: (i) => <span className="block text-right">{num0(i.getValue())}</span> }),
    col.accessor('billed', { id: 'gallons_billed', header: 'Gallons Billed', cell: (i) => <span className="block text-right">{num0(i.getValue())}</span> }),
    col.accessor('billedPct', {
      id: 'billed_pct', header: 'Billed % of Ordered',
      cell: (i) => {
        const v = i.getValue()
        return <span className={`block text-right ${v != null && v < threshold ? 'text-[#C0392B] font-bold' : ''}`}>{pct1(v)}</span>
      },
    }),
    col.accessor('revenue', { id: 'revenue', header: 'Revenue', cell: (i) => <span className="block text-right">{money(i.getValue())}</span> }),
    col.accessor('revenuePerGallon', { id: 'revenue_per_gallon', header: 'Revenue / Gal', cell: (i) => <span className="block text-right">{i.getValue() != null ? money(i.getValue()) : '—'}</span> }),
  ], [col, threshold])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(productRows, columns, {
    persistKey: TABLE_KEY, initialSorting: [{ id: 'gallons_billed', desc: true }], initialPageSize: 50,
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  function drill(entity: 'market' | 'shop', key: string) {
    if (entity === 'market') { setMarkets([key]); setShops([]) } else { setShops([key]); setMarkets([]) }
    setGroupBy('product')
    setMetric('both')
    setTab('by-month')
    setTabKey((k) => k + 1)
  }

  if (loading || mapping.loading || loc.loading) return <div className="py-10 flex justify-center"><SbLoader size={28} /></div>

  const filterCount = [products, groups, markets, shops].filter((s) => s.length > 0).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-72">
          <Select label="Period" value={preset} onChange={(e) => setPreset(e.target.value)} options={presetOptions} />
        </div>
        <div className="w-56">
          <span className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Product</span>
          <MultiSelectDropdown options={productOptions} selected={products} onChange={setProducts} placeholder="All products" countNoun="products" searchable />
        </div>
        <div className="w-40">
          <span className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Package Type</span>
          <MultiSelectDropdown options={groupOptions} selected={groups} onChange={setGroups} placeholder="All types" countNoun="types" />
        </div>
        <div className="w-44">
          <span className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Market</span>
          <MultiSelectDropdown options={marketOptions} selected={markets} onChange={setMarkets} placeholder="All markets" countNoun="markets" searchable />
        </div>
        <div className="w-40">
          <span className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Shop</span>
          <MultiSelectDropdown options={shopOptions} selected={shops} onChange={setShops} placeholder="All shops" countNoun="shops" searchable />
        </div>
        {filterCount > 0 && (
          <button className="text-xs font-mono text-inky underline pb-2"
            onClick={() => { setProducts([]); setGroups([]); setMarkets([]); setShops([]) }}>
            Clear filters
          </button>
        )}
      </div>

      <Tabs key={tabKey} defaultValue={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="by-month">By Month</TabsTrigger>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="underperformers">Underperformers</TabsTrigger>
          <TabsTrigger value="mapping">Product Mapping</TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Kpi label="Gallons Ordered" value={num0(total.ordered)} />
              <Kpi label="Gallons Billed" value={num0(total.billed)} />
              <Kpi label="Billed % of Ordered" value={pct1(billedPct(total.ordered, total.billed))} />
              <Kpi label="Revenue" value={money(total.revenue)} />
              <Kpi label="Revenue / Gal" value={total.billed > 0 ? money(total.revenue / total.billed) : '—'} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {perGroup.map(({ key, agg }) => (
                <Kpi key={key} label={`${GROUP_LABELS[key]} — billed / ordered`}
                  value={`${num0(agg.billed)} / ${num0(agg.ordered)}`}
                  sub={`${pct1(billedPct(agg.ordered, agg.billed))} billed of ordered`} />
              ))}
            </div>
            <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="RelaDyne Product Gallons" />
          </div>
        </TabsContent>

        <TabsContent value="by-month">
          <GallonsByMonth rows={filtered} groupBy={groupBy} onGroupByChange={setGroupBy} metric={metric} onMetricChange={setMetric} threshold={threshold} />
        </TabsContent>

        <TabsContent value="charts"><GallonsCharts rows={filtered} /></TabsContent>

        <TabsContent value="underperformers">
          <GallonsUnderperformers rows={scoped} threshold={threshold} onThresholdChange={setThreshold}
            minOrdered={minOrdered} onMinOrderedChange={setMinOrdered} onDrill={drill} />
        </TabsContent>

        <TabsContent value="mapping">
          <GallonsMapping products={mappingProducts} overrides={mapping.overrides} setGroup={mapping.setGroup} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
