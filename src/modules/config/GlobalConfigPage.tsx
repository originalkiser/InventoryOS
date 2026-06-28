import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { LocationsTab } from './tabs/LocationsTab'
import { VendorPartsTab } from './tabs/VendorPartsTab'
import { OrderConfigTab } from './tabs/OrderConfigTab'
import { ProductMappingTab } from './tabs/ProductMappingTab'
import { GlobalProductsTab } from './tabs/GlobalProductsTab'
import { PosLocationMapTab } from './tabs/PosLocationMapTab'
import { CompanyHolidaysTab } from './tabs/CompanyHolidaysTab'

export function GlobalConfigPage() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Global Configuration</h1>
        <p className="text-xs text-inky mt-0.5">Locations, vendors, products, and location mappings — shared across all modules</p>
      </div>

      {!isAdmin && (
        <div className="flex items-start gap-3 px-4 py-3 bg-sky/20 border border-sky/60 rounded-lg">
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-inky" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs font-body text-navy">
            <strong className="font-heading uppercase tracking-wide">Read-only view.</strong>{' '}
            Only admins can make changes. Contact your workspace admin to update settings.
          </span>
        </div>
      )}

      <Tabs defaultValue="locations">
        <TabsList>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="vendor-parts">Vendor Parts</TabsTrigger>
          <TabsTrigger value="order-config">Order Config</TabsTrigger>
          <TabsTrigger value="product-mapping">Product Mapping</TabsTrigger>
          <TabsTrigger value="global-products">Global Products</TabsTrigger>
          <TabsTrigger value="pos-map">Location Mapping</TabsTrigger>
          <TabsTrigger value="holidays">Holidays</TabsTrigger>
        </TabsList>

        <TabsContent value="locations"><LocationsTab /></TabsContent>
        <TabsContent value="vendor-parts"><VendorPartsTab /></TabsContent>
        <TabsContent value="order-config"><OrderConfigTab /></TabsContent>
        <TabsContent value="product-mapping"><ProductMappingTab /></TabsContent>
        <TabsContent value="global-products"><GlobalProductsTab /></TabsContent>
        <TabsContent value="pos-map"><PosLocationMapTab /></TabsContent>
        <TabsContent value="holidays"><CompanyHolidaysTab /></TabsContent>
      </Tabs>
    </div>
  )
}
