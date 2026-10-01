// RelaDyne MMR (Monthly Management Report) — direct ask 2026-09-30. Hosts
// the 4 views derived from RelaDyne's monthly vendor-performance exports:
// volume commitment/actual + by-customer gallons, OTIF delivery stats,
// item fill % trend by product, and by-product gallons/revenue. See
// mmrParsers.ts/useMmrData.ts for how the 3 source spreadsheets map onto
// these, and migration 20260930by for the schema/data-model reasoning.
import { useState } from 'react'
import { Upload } from 'lucide-react'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { MmrUploadModal } from './MmrUploadModal'
import { VolumeTab } from './tabs/VolumeTab'
import { OtifTab } from './tabs/OtifTab'
import { ItemFillTrendTab } from './tabs/ItemFillTrendTab'
import { ProductGallonsTab } from './tabs/ProductGallonsTab'

export function MmrPage() {
  const [uploadOpen, setUploadOpen] = useState(false)
  // Bumped on a successful import so every tab's own data hook refetches —
  // simplest way to keep all 4 tabs in sync with a just-completed upload
  // without threading a shared store through every tab.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">MMR</h1>
          <p className="text-xs text-inky mt-0.5">
            RelaDyne's monthly vendor-performance report — volume, OTIF delivery, item fill rate, and product gallons.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setUploadOpen(true)}>
          <Upload className="w-3.5 h-3.5 mr-1" /> Upload Monthly Data
        </Button>
      </div>

      <Tabs defaultValue="volume">
        <TabsList>
          <TabsTrigger value="volume">Volume</TabsTrigger>
          <TabsTrigger value="otif">OTIF</TabsTrigger>
          <TabsTrigger value="item-fill">Item Fill Trend</TabsTrigger>
          <TabsTrigger value="product-gallons">Product Gallons</TabsTrigger>
        </TabsList>

        <TabsContent value="volume"><VolumeTab key={`volume-${refreshKey}`} /></TabsContent>
        <TabsContent value="otif"><OtifTab key={`otif-${refreshKey}`} /></TabsContent>
        <TabsContent value="item-fill"><ItemFillTrendTab key={`fill-${refreshKey}`} /></TabsContent>
        <TabsContent value="product-gallons"><ProductGallonsTab key={`gallons-${refreshKey}`} /></TabsContent>
      </Tabs>

      <MmrUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
