import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { getPlacedOrders, updateOrderStatus } from '@/services/placedOrdersService'
import type { PlacedOrder, OrderFilters } from '@/types/integrations'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'placed', label: 'Placed' },
  { value: 'received', label: 'Received' },
  { value: 'cancelled', label: 'Cancelled' },
]

const STATUS_BADGE: Record<string, string> = {
  placed: 'bg-sky/20 text-sky',
  received: 'bg-green-100 text-green-700',
  cancelled: 'bg-inky/10 text-inky/50',
  archived: 'bg-inky/5 text-inky/30',
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

interface Props {
  onNewOrder?: () => void
}

export function PlacedOrdersTable({ onNewOrder }: Props) {
  const [orders, setOrders] = useState<PlacedOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<OrderFilters>({ status: 'all' })
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  async function load(f: OrderFilters = filters) {
    setLoading(true)
    try {
      const data = await getPlacedOrders(f)
      setOrders(data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleStatusChange(order: PlacedOrder, status: PlacedOrder['status']) {
    setUpdatingId(order.id)
    try {
      await updateOrderStatus(order.id, status)
      toast.success(`Order ${order.order_number} marked as ${status}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setUpdatingId(null)
    }
  }

  function applyFilter(patch: Partial<OrderFilters>) {
    const next = { ...filters, ...patch }
    setFilters(next)
    load(next)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="border border-inky/20 rounded px-2 py-1 text-xs font-mono bg-cream text-navy"
          value={filters.status ?? 'all'}
          onChange={(e) => applyFilter({ status: e.target.value })}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          type="date"
          className="border border-inky/20 rounded px-2 py-1 text-xs font-mono bg-cream text-navy"
          value={filters.startDate ?? ''}
          onChange={(e) => applyFilter({ startDate: e.target.value || undefined })}
          placeholder="From"
        />
        <input
          type="date"
          className="border border-inky/20 rounded px-2 py-1 text-xs font-mono bg-cream text-navy"
          value={filters.endDate ?? ''}
          onChange={(e) => applyFilter({ endDate: e.target.value || undefined })}
          placeholder="To"
        />
        <Button size="sm" variant="ghost" onClick={() => load()} className="text-xs">Refresh</Button>
        {onNewOrder && <Button size="sm" onClick={onNewOrder} className="ml-auto">New Order</Button>}
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-xs font-mono text-inky/40 py-6 text-center">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-xs font-mono text-inky/40 py-6 text-center">No orders found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="border-b-2 border-inky/20">
                <th className="text-left py-2 pr-4 font-heading text-xs uppercase tracking-wider text-inky/60">Order #</th>
                <th className="text-left py-2 pr-4 font-heading text-xs uppercase tracking-wider text-inky/60">Location</th>
                <th className="text-left py-2 pr-4 font-heading text-xs uppercase tracking-wider text-inky/60">Placed At</th>
                <th className="text-left py-2 pr-4 font-heading text-xs uppercase tracking-wider text-inky/60">Status</th>
                <th className="text-left py-2 pr-4 font-heading text-xs uppercase tracking-wider text-inky/60">Expires</th>
                <th className="py-2 font-heading text-xs uppercase tracking-wider text-inky/60">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-b border-inky/10 hover:bg-inky/5">
                  <td className="py-2 pr-4 text-navy font-bold">{order.order_number}</td>
                  <td className="py-2 pr-4">{order.location_name ?? order.location_id ?? '—'}</td>
                  <td className="py-2 pr-4 text-inky/70">{fmtDate(order.placed_at)}</td>
                  <td className="py-2 pr-4">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${STATUS_BADGE[order.status] ?? ''}`}>
                      {order.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-inky/50">{order.expires_at ? new Date(order.expires_at).toLocaleDateString() : '—'}</td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      {order.status === 'placed' && (
                        <>
                          <button
                            disabled={updatingId === order.id}
                            onClick={() => handleStatusChange(order, 'received')}
                            className="text-green-700 hover:underline disabled:opacity-40"
                          >
                            Received
                          </button>
                          <button
                            disabled={updatingId === order.id}
                            onClick={() => handleStatusChange(order, 'cancelled')}
                            className="text-red-500 hover:underline disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
