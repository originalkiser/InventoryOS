import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { LocationsTab } from './tabs/LocationsTab'
import { VendorPartsTab } from './tabs/VendorPartsTab'
import { OrderConfigTab } from './tabs/OrderConfigTab'
import { ProductMappingTab } from './tabs/ProductMappingTab'
import { GlobalProductsTab } from './tabs/GlobalProductsTab'
import { UomMappingsTab } from './tabs/UomMappingsTab'
import { EndingBalancesTab } from './tabs/EndingBalancesTab'

export function ConfigPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-white tracking-wide uppercase">Configuration</h1>
        <p className="text-xs text-gray-500 mt-0.5">Manage locations, products, vendors, and import settings</p>
      </div>

      <Tabs defaultValue="locations">
        <TabsList>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="vendor-parts">Vendor Parts</TabsTrigger>
          <TabsTrigger value="order-config">Order Config</TabsTrigger>
          <TabsTrigger value="product-mapping">Product Mapping</TabsTrigger>
          <TabsTrigger value="global-products">Global Products</TabsTrigger>
          <TabsTrigger value="uom-mappings">UoM Conversions</TabsTrigger>
          <TabsTrigger value="ending-balances">Month End Ending Balance</TabsTrigger>
        </TabsList>

        <TabsContent value="locations"><LocationsTab /></TabsContent>
        <TabsContent value="vendor-parts"><VendorPartsTab /></TabsContent>
        <TabsContent value="order-config"><OrderConfigTab /></TabsContent>
        <TabsContent value="product-mapping"><ProductMappingTab /></TabsContent>
        <TabsContent value="global-products"><GlobalProductsTab /></TabsContent>
        <TabsContent value="uom-mappings"><UomMappingsTab /></TabsContent>
        <TabsContent value="ending-balances"><EndingBalancesTab /></TabsContent>
      </Tabs>
    </div>
  )
}
