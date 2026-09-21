// Orders v2 — vendor and user lookups shared by the module's pages.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

export interface VendorLite { id: string; name: string; vendor_code: string | null }

export function useVendors() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [vendors, setVendors] = useState<VendorLite[]>([])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    sb().schema('inventory').from('vendors').select('id, name, vendor_code').eq('company_id', companyId).order('name')
      .then(({ data }: any) => { if (!cancelled) setVendors((data ?? []) as VendorLite[]) })
    return () => { cancelled = true }
  }, [companyId])

  const byIdMap = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors])
  const byId = useCallback((id: string | null | undefined) => (id ? byIdMap.get(id) ?? null : null), [byIdMap])
  const options = useMemo(() => vendors.map((v) => ({ value: v.id, label: v.name })), [vendors])
  // Mighty has no location_order_config-driven engine path — see
  // mightyEngine.ts/MightyOrderReview.tsx. Matched by vendor_code (stable)
  // rather than name (an admin could rename the display name later).
  const isMighty = useCallback((id: string | null | undefined) => byId(id)?.vendor_code === 'MIGHTY', [byId])

  return { vendors, byId, options, isMighty }
}

export function useUserNames() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [users, setUsers] = useState<{ id: string; full_name: string | null }[]>([])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    sb().schema('platform').from('user_profiles')
      .select('id, full_name').eq('company_id', companyId).is('deleted_at', null).order('full_name')
      .then(({ data }: any) => { if (!cancelled) setUsers((data ?? []) as any[]) })
    return () => { cancelled = true }
  }, [companyId])

  const map = useMemo(() => new Map(users.map((u) => [u.id, u.full_name ?? ''])), [users])
  const nameOf = useCallback((id: string | null | undefined) => (id ? map.get(id) || '—' : '—'), [map])
  const options = useMemo(() => users.map((u) => ({ value: u.id, label: u.full_name ?? u.id })), [users])

  return { users, nameOf, options }
}
