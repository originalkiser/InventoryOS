import { PlacedOrdersTable } from '@/components/integrations/PlacedOrdersTable'

export function OrderHistoryPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order History</h1>
          <p className="text-xs text-inky mt-0.5">
            Placed orders — 60-day retention. Orders are automatically archived after 60 days.
          </p>
        </div>
      </div>

      <PlacedOrdersTable />
    </div>
  )
}
