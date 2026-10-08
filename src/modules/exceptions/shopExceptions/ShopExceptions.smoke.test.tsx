// Smoke test: the Location Lookup card and the triage view against a fake Supabase — one card per shop per type, icons, severity, Skip / Excuse.
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const rows: any[] = [
  { id: 'e1', location_id: 'a', type: 'zero_sales', severity: 3, status: 'pending', first_seen: '2026-10-05', last_seen: '2026-10-09', acked_keys: [], status_changed_at: null, logged_message: null,
    items: [{ key: '5w30', product_id: '5W30', days: 4, qty: 38, first: '2026-10-05' }, { key: 'r1540', product_id: 'R1540', days: 1, qty: 10, first: '2026-10-08' }] },
  { id: 'e2', location_id: 'a', type: 'po_late', severity: 2, status: 'pending', first_seen: '2026-10-08', last_seen: '2026-10-09', acked_keys: [], status_changed_at: null, logged_message: null,
    items: [{ key: 'PO1', po: '1-20260924', supplier: 'Valvoline', expected: '2026-10-06', days_late: 3 }, { key: 'PO2', po: '1-20260925', supplier: 'Valvoline', expected: '2026-10-06', days_late: 3 }] },
  { id: 'e3', location_id: 'b', type: 'duplicate_case', severity: 1, status: 'pending', first_seen: '2026-10-09', last_seen: '2026-10-09', acked_keys: [], status_changed_at: null, logged_message: null,
    items: [{ key: 'syn-5w20', family: 'SYN-5W20', members: [{ product_id: 'SYN-5W20', on_hand: 291 }, { product_id: 'SYN-5W20D', on_hand: 178 }], diff: 113, severity: 1 }] },
]
const updates: { id: string; patch: any }[] = []

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let isUpdate = false; let patch: any = null
    const p: any = {
      select: () => p, eq: (_c: string, v: any) => { if (isUpdate) updates.push({ id: v, patch }); return p }, neq: () => p, order: () => p, range: () => p,
      update: (x: any) => { isUpdate = true; patch = x; return p },
      then: (ok: any, bad: any) => Promise.resolve({ data: isUpdate ? null : table === 'shop_exceptions' ? rows : [], error: null }).then(ok, bad),
    }
    return p
  }
  return { supabase: { schema: () => ({ from: builder }), from: builder, functions: { invoke: async () => ({ data: { created: 0, updated: 0, resolved: 0 }, error: null }) } } }
})
vi.mock('@/hooks/useLocations', () => ({
  useLocations: () => ({ labelOf: (id: string) => ({ a: '12-Hurricane', b: '100-Proctorville' } as Record<string, string>)[id] ?? id, codeOf: (id: string) => ({ a: '12', b: '100' } as Record<string, string>)[id] ?? id, fieldValue: () => '', options: [], locations: [], loading: false }),
}))
vi.mock('@/hooks/useAppSetting', () => ({ useAppSetting: (_k: string, d: any) => [d, () => {}] }))

import { ShopExceptionsCard } from './ShopExceptionsCard'
import { TriagePanel } from './TriagePanel'
import { useAuthStore } from '@/stores/authStore'
import { useShopExceptionsStore } from './useShopExceptions'

afterEach(() => { cleanup(); useShopExceptionsStore.setState({ items: [], loadedFor: null, loading: false }); updates.length = 0 })
const signIn = () => useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })

describe('shop exceptions', () => {
  it('the Location Lookup card lists this shop\'s pending exceptions by priority with their summaries', async () => {
    signIn()
    render(<ShopExceptionsCard locationId="a" />)
    expect(await screen.findByText('Zero on hand')).toBeTruthy()
    expect(screen.getByText('PO late')).toBeTruthy()
    expect(screen.queryByText('Duplicate case types')).toBeNull() // that one is another shop's
    expect(screen.getByText(/2 products sold at 0 · 48 qt · up to 4 days/)).toBeTruthy()
    expect(screen.getByText(/2 POs · oldest 3 days late/)).toBeTruthy()
    expect(screen.getByText('High')).toBeTruthy()
  })

  it('clicking a row opens the modal with the one card listing every product, and Skip saves + advances', async () => {
    signIn()
    render(<ShopExceptionsCard locationId="a" />)
    fireEvent.click(await screen.findByText('Zero on hand'))
    expect(await screen.findByText(/5W30 · 4 days, 38 qt sold at 0/)).toBeTruthy()
    expect(screen.getByText(/R1540 · 1 day, 10 qt sold at 0/)).toBeTruthy()
    fireEvent.click(screen.getByText('Skip'))
    await waitFor(() => expect(updates.some((u) => u.id === 'e1' && u.patch.status === 'skipped' && u.patch.acked_keys.length === 2)).toBe(true))
  })

  it('the triage view groups by shop and by type, with one card per shop per type', async () => {
    signIn()
    render(<TriagePanel />)
    expect((await screen.findAllByText(/12-Hurricane/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Selling at zero on hand').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('By exception type'))
    expect(await screen.findByText('Duplicate case types on hand')).toBeTruthy()
    expect(screen.getAllByText('100-Proctorville').length).toBeGreaterThan(0)
  })
})
