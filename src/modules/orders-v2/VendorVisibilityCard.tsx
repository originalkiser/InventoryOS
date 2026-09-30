import { useState } from 'react'
import { Card, CardBody, Input, Button, Toggle } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useVendors } from './useLookups'

const sb = () => supabase as any

// Same vendor_code convention VendorPartsTab.tsx's own quick-add already
// uses — a stable, uppercase, no-space code distinct from the display name.
const slugCode = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/**
 * Which vendors show up on "Start New Order" — direct ask 2026-09-30: "add
 * settings for vendors to show on order selection, so we can add vendors
 * and hide vendors later." Every other vendor list in the app (filters,
 * history, config screens) stays unfiltered — this only ever controls the
 * "Start New Order" picker (useVendors' own orderableOptions).
 */
export function VendorVisibilityCard() {
  const { profile } = useAuthStore()
  const vendors = useVendors()
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)

  async function toggle(id: string, next: boolean) {
    const { error } = await sb().schema('inventory').from('vendors').update({ show_in_order_selection: next }).eq('id', id)
    if (error) { toast.error(error.message); return }
    await vendors.reload()
    toast.success(next ? 'Vendor shown on Start New Order' : 'Vendor hidden from Start New Order')
  }

  async function addVendor() {
    const name = newName.trim()
    if (!name || !profile?.company_id) return
    setAdding(true)
    const { error } = await sb().schema('inventory').from('vendors')
      .insert({ company_id: profile.company_id, name, vendor_code: slugCode(name) })
    setAdding(false)
    if (error) { toast.error(error.message); return }
    setNewName('')
    await vendors.reload()
    toast.success(`Vendor "${name}" added`)
  }

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Vendor Visibility</h3>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5">
          Which vendors appear on "Start New Order." Hiding a vendor here doesn&apos;t affect its existing orders,
          history, or config elsewhere — it only removes it from the picker for a NEW order.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        {vendors.vendors.map((v) => (
          <div key={v.id} className="flex items-center justify-between gap-2 rounded border border-navy/15 px-3 py-1.5">
            <span className="text-xs font-mono text-navy">{v.name}</span>
            <Toggle checked={v.show_in_order_selection !== false} onChange={(next) => toggle(v.id, next)} size="sm" />
          </div>
        ))}
        {vendors.vendors.length === 0 && !vendors.loading && (
          <p className="text-[11px] font-mono text-inky/50">No vendors yet — add one below.</p>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input label="Add Vendor" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Vendor name…" />
        </div>
        <Button size="sm" loading={adding} disabled={!newName.trim()} onClick={addVendor}>Add</Button>
      </div>
    </CardBody></Card>
  )
}
