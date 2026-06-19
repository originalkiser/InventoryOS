import { supabase } from '@/lib/supabase'
import { generateOrderNumber } from '@/utils/orderNumberUtils'
import type { PlacedOrder, NewPlacedOrder, OrderFilters } from '@/types/integrations'

export async function savePlacedOrder(order: NewPlacedOrder): Promise<PlacedOrder> {
  const { data, error } = await (supabase as any)
    .from('placed_orders')
    .insert({
      order_number: generateOrderNumber(),
      location_id: order.location_id,
      location_name: order.location_name,
      placed_at: new Date().toISOString(),
      placed_by: order.placed_by ?? null,
      order_data: order.order_data,
      status: 'placed',
      notes: order.notes ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as PlacedOrder
}

export async function getPlacedOrders(filters?: OrderFilters): Promise<PlacedOrder[]> {
  let q = (supabase as any).from('placed_orders').select('*')
  if (filters?.locationId) q = q.eq('location_id', filters.locationId)
  if (filters?.status && filters.status !== 'all') q = q.eq('status', filters.status)
  if (filters?.startDate) q = q.gte('placed_at', filters.startDate)
  if (filters?.endDate) q = q.lte('placed_at', `${filters.endDate}T23:59:59Z`)
  const { data, error } = await q.order('placed_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as PlacedOrder[]
}

export async function updateOrderStatus(id: string, status: PlacedOrder['status']): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (status === 'archived') patch.archived_at = new Date().toISOString()
  const { error } = await (supabase as any).from('placed_orders').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function getOrderByNumber(orderNumber: string): Promise<PlacedOrder | null> {
  const { data } = await (supabase as any)
    .from('placed_orders')
    .select('*')
    .eq('order_number', orderNumber)
    .limit(1)
  return ((data ?? []) as PlacedOrder[])[0] ?? null
}
