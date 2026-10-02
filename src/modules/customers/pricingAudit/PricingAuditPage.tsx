// Pricing Audit — direct ask 2026-10-02. Package Pricing Audit (relocated
// from Package Mapping) + Product Pricing Audit + Custom Product Pricing +
// Custom Packages (replaces Custom Shop Config's job going forward — see
// useCustomPackages.ts) + Summary.
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { PackagePricingAuditTab } from './PackagePricingAuditTab'
import { ProductPricingAuditTab } from './ProductPricingAuditTab'
import { CustomProductPricingTab } from './CustomProductPricingTab'
import { CustomPackagesTab } from './CustomPackagesTab'
import { SummaryTab } from './SummaryTab'

export function PricingAuditPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Pricing Audit</h1>
        <p className="text-xs text-inky mt-0.5">
          What's actually being sold in Droptop vs. what it should be — by package and by product — plus the custom
          package layouts that come with acquiring more shops.
        </p>
      </div>

      <Tabs defaultValue="package_audit">
        <TabsList>
          <TabsTrigger value="package_audit">Package Pricing Audit</TabsTrigger>
          <TabsTrigger value="product_audit">Product Pricing Audit</TabsTrigger>
          <TabsTrigger value="custom_product_pricing">Custom Product Pricing</TabsTrigger>
          <TabsTrigger value="custom_packages">Custom Packages</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>
        <TabsContent value="package_audit"><PackagePricingAuditTab /></TabsContent>
        <TabsContent value="product_audit"><ProductPricingAuditTab /></TabsContent>
        <TabsContent value="custom_product_pricing"><CustomProductPricingTab /></TabsContent>
        <TabsContent value="custom_packages"><CustomPackagesTab /></TabsContent>
        <TabsContent value="summary"><SummaryTab /></TabsContent>
      </Tabs>
    </div>
  )
}
