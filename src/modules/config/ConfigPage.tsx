import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { UomMappingsTab } from './tabs/UomMappingsTab'
import { ProductUsageTab } from './tabs/ProductUsageTab'
import { TankMonitorTab } from './tabs/TankMonitorTab'
import { EndingBalancesTab } from './tabs/EndingBalancesTab'

export function ConfigPage() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Inventory Configuration</h1>
        <p className="text-xs text-inky mt-0.5">UoM conversions, product usage, tank monitors, and ending balances</p>
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

      <Tabs defaultValue="uom-mappings">
        <TabsList>
          <TabsTrigger value="uom-mappings">UoM Conversions</TabsTrigger>
          <TabsTrigger value="product-usage">Product Usage</TabsTrigger>
          <TabsTrigger value="tank-monitor">Tank Monitor</TabsTrigger>
          <TabsTrigger value="ending-balances">Month End Ending Balance</TabsTrigger>
        </TabsList>

        <TabsContent value="uom-mappings"><UomMappingsTab /></TabsContent>
        <TabsContent value="product-usage"><ProductUsageTab /></TabsContent>
        <TabsContent value="tank-monitor"><TankMonitorTab /></TabsContent>
        <TabsContent value="ending-balances"><EndingBalancesTab /></TabsContent>
      </Tabs>
    </div>
  )
}
