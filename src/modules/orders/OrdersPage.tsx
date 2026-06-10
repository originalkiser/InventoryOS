import { useEffect, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Modal, Input } from '@/components/ui'
import type { OrderSession } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { useForm } from 'react-hook-form'

const col = createColumnHelper<OrderSession>()
const STATUS_COLOR: Record<string, 'cyan' | 'green' | 'amber' | 'gray'> = {
  draft: 'gray', pending: 'amber', exported: 'cyan', fulfilled: 'green',
}
const COLUMNS = [
  col.accessor('status', { header: 'Status', cell: (i) => <Badge color={STATUS_COLOR[i.getValue()] ?? 'gray'}>{i.getValue()}</Badge> }),
  col.accessor('created_at', { header: 'Created', cell: (i) => format(new Date(i.getValue()), 'MMM d, yyyy h:mm a') }),
  col.accessor('notes', { header: 'Notes', cell: (i) => i.getValue() ?? '—' }),
]

export function OrdersPage() {
  const { profile } = useAuthStore()
  const [orders, setOrders] = useState<OrderSession[]>([])
  const [loading, setLoading] = useState(true)
  const [newOpen, setNewOpen] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ notes: string }>()
  const { table, globalFilter, setGlobalFilter } = useTable(orders, COLUMNS)

  useEffect(() => {
    if (!profile?.company_id) return
    load()
    const ch = supabase.channel('orders-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_sessions', filter: `company_id=eq.${profile.company_id}` }, load)
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [profile?.company_id])

  async function load() {
    if (!profile?.company_id) return
    setLoading(true)
    const { data } = await supabase.from('order_sessions').select('*').eq('company_id', profile.company_id).order('created_at', { ascending: false })
    setOrders(data ?? [])
    setLoading(false)
  }

  async function createOrder(form: { notes: string }) {
    if (!profile?.company_id) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('order_sessions').insert({
      company_id: profile.company_id,
      created_by: profile.id,
      status: 'draft',
      notes: form.notes || null,
    })
    if (error) toast.error(error.message)
    else { toast.success('Order created'); reset(); setNewOpen(false) }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white tracking-wide uppercase">Orders</h1>
          <p className="text-xs text-gray-500 mt-0.5">Create and manage inventory orders</p>
        </div>
      </div>
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="orders.csv" exportData={orders} loading={loading}
        actions={<Button size="sm" onClick={() => setNewOpen(true)}>+ New Order</Button>}
      />
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Order">
        <form onSubmit={handleSubmit(createOrder)} className="flex flex-col gap-3">
          <Input label="Notes (optional)" {...register('notes')} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit">Create Draft</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
