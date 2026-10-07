// Smoke test: mount the COGS Price Check against a fake Supabase and check the summary and by-shop numbers end to end (no login needed).
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures: Record<string, any[]> = {
  cogs_checks: [{ id: 'k1', name: 'Sept RelaDyne', vendor: 'RelaDyne', start_date: '2026-09-01', end_date: '2026-09-30', sell_through: false, start_balance_date: null, adjust_unmatched: false, tolerance: 0.0005, notes: null, created_at: '2026-10-07T00:00:00Z' }],
  cogs_price_entries: [
    { id: 'p1', vendor: 'RelaDyne', product_id: 'SYN-5W30', price_per_qt: 3, start_date: null, end_date: '2026-08-31', note: null },
    { id: 'p2', vendor: 'RelaDyne', product_id: 'SYN-5W30', price_per_qt: 4, start_date: '2026-09-01', end_date: null, note: null },
  ],
  cogs_start_balances: [],
  cogs_ledger: [
    // a sale booked at the old price: 10 qt x ($4 - $3) = -$10 (more COGS)
    { id: 'l1', location_id: 'a', change_date: '2026-09-05', change_type: 'sale', product_id: 'SYN-5W30', po_custom_id: '', qty_change: -10, total_cost: -30 },
    // a receipt ordered 9/2 (new price) but booked at the old price: 20 x ($4 - $3) = +$20
    { id: 'l2', location_id: 'b', change_date: '2026-09-08', change_type: 'receipt', product_id: 'SYN-5W30', po_custom_id: '20-09022026P', qty_change: 20, total_cost: 60 },
    // a receipt ordered 8/28 (old price) booked at the old price: correct, no impact
    { id: 'l3', location_id: 'b', change_date: '2026-09-08', change_type: 'receipt', product_id: 'SYN-5W30', po_custom_id: '20-08282026P', qty_change: 20, total_cost: 60 },
  ],
  droptop_purchase_orders: [],
}

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let write = false
    const p: any = {
      select: () => p, eq: () => p, in: () => p, gte: () => p, lte: () => p, gt: () => p, order: () => p, range: () => p, limit: () => p,
      insert: () => { write = true; return p }, update: () => { write = true; return p }, delete: () => { write = true; return p }, upsert: () => { write = true; return p },
      single: () => Promise.resolve({ data: fixtures[table]?.[0] ?? null, error: null }),
      then: (ok: any, bad: any) => Promise.resolve({ data: write ? null : fixtures[table] ?? [], error: null }).then(ok, bad),
    }
    return p
  }
  return { supabase: { schema: () => ({ from: builder }), from: builder } }
})
vi.mock('@/hooks/useLocations', () => ({
  useLocations: () => ({ includedOptions: [], locations: [], loading: false, resolveId: () => null, labelOf: (id: string) => ({ a: '10-Elkin', b: '20-Lenoir' } as Record<string, string>)[id] ?? id }),
}))

import { CogsPriceCheckPage } from './CogsPriceCheckPage'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => cleanup())

describe('CogsPriceCheckPage', () => {
  it('totals the re-costed sale and receipt and lists them by shop', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<CogsPriceCheckPage />)
    await screen.findAllByText('Total impact', {}, { timeout: 5000 })
    // sales -$10, receipts +$20, total +$10
    expect((await screen.findAllByText('-$10.00', {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.getAllByText('$20.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('$10.00').length).toBeGreaterThanOrEqual(1)
    expect(await screen.findByText('10-Elkin')).toBeTruthy()
    expect(screen.getByText('20-Lenoir')).toBeTruthy()
    fireEvent.click(screen.getByText('Prices'))
    expect((await screen.findAllByText('RelaDyne')).length).toBeGreaterThan(0)
  }, 15000)
})
