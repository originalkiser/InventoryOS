import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { NewOrderTab } from './NewOrderTab'
import { OrderHistoryTab } from './OrderHistoryTab'
import { MinRulesTab } from './MinRulesTab'
import { ProfilesTab } from './ProfilesTab'

export function OrdersPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Orders</h1>
        <p className="text-xs text-inky mt-0.5">Inventory-driven order planning</p>
      </div>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Config Order</TabsTrigger>
          <TabsTrigger value="manual">Manual Order</TabsTrigger>
          <TabsTrigger value="independent">Independent</TabsTrigger>
          <TabsTrigger value="history">Order History</TabsTrigger>
          <TabsTrigger value="rules">Min Rules</TabsTrigger>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
        </TabsList>
        <TabsContent value="config"><NewOrderTab mode="config" /></TabsContent>
        <TabsContent value="manual"><NewOrderTab mode="manual" /></TabsContent>
        <TabsContent value="independent"><NewOrderTab mode="independent" /></TabsContent>
        <TabsContent value="history"><OrderHistoryTab /></TabsContent>
        <TabsContent value="rules"><MinRulesTab /></TabsContent>
        <TabsContent value="profiles"><ProfilesTab /></TabsContent>
      </Tabs>
    </div>
  )
}
