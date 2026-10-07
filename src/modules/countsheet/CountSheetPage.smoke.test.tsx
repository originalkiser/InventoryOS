// Smoke test: mount the Count Sheet against a fake Supabase and walk the main interactions (no login needed).
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures: Record<string, any[]> = {
  product_usage: [
    { product_id: 'SYN-5W30', category: 'Engine Oil', on_hands: 100, daily_usage: 4.5, unit_cost: 2, count_sequence: 2 },
    { product_id: 'M4455', category: 'Filters', on_hands: 12, daily_usage: 0.5, unit_cost: 5, count_sequence: 1 },
    { product_id: 'WIPER', category: 'Wipers', on_hands: 0, daily_usage: null, unit_cost: 3, count_sequence: null },
  ],
  count_sheets: [{ id: 's1', label: 'Count — Oct 7', count_date: '2026-10-07', created_at: '2026-10-07T00:00:00Z' }],
  count_sheet_places: [{ id: 'pl1', name: 'Bay 1', sort_order: 0 }, { id: 'pl2', name: 'Back room', sort_order: 1 }],
  count_sheet_entries: [
    { id: 'e1', product_id: 'SYN-5W30', place_id: 'pl1', qty: 60, sort_order: 0 },
    { id: 'e2', product_id: 'SYN-5W30', place_id: 'pl2', qty: 30, sort_order: 0 },
    { id: 'e3', product_id: 'M4455', place_id: 'pl1', qty: null, sort_order: 10 },
  ],
  daily_product_activity: [
    { product_id: 'SYN-5W30', activity_date: '2026-10-03', adjusted_qty: 0, other_qty: 24, raw_change_types: ['receive'] },
    { product_id: 'M4455', activity_date: '2026-09-28', adjusted_qty: -6, other_qty: 0, raw_change_types: [] },
  ],
}
const inserted: any[] = []

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let mode: 'select' | 'write' = 'select'
    let payload: any = null
    const p: any = {
      select: () => p, eq: () => p, or: () => p, gte: () => p, in: () => p, order: () => p, range: () => p,
      insert: (v: any) => { mode = 'write'; payload = v; inserted.push({ table, v }); return p },
      update: () => { mode = 'write'; return p }, delete: () => { mode = 'write'; return p }, upsert: () => { mode = 'write'; return p },
      single: () => Promise.resolve({ data: { id: `new-${inserted.length}`, ...(payload ?? {}) }, error: null }),
      then: (ok: any, bad: any) => Promise.resolve({ data: mode === 'select' ? fixtures[table] ?? [] : null, error: null }).then(ok, bad),
    }
    return p
  }
  return { supabase: { schema: () => ({ from: builder }), from: builder } }
})
vi.mock('@/hooks/useLocations', () => ({
  useLocations: () => ({ includedOptions: [{ value: 'loc1', label: '1-Thomasville' }], locations: [], loading: false }),
}))

import { CountSheetPage } from './CountSheetPage'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => cleanup())

describe('CountSheetPage', () => {
  it('lists the shop\'s Droptop products with hints, and shows where else a product was counted', async () => {
    localStorage.setItem('count_sheet_last_shop', 'loc1')
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<CountSheetPage />)
    await screen.findByText('WIPER', {}, { timeout: 5000 }); await screen.findByText('SYN-5W30')
    expect(screen.getByText('M4455')).toBeTruthy()
    expect(screen.getByText('WIPER')).toBeTruthy()
    expect(screen.getByText(/not pushed to Droptop/i)).toBeTruthy()
    // total counted for the product across both places (60 + 30) and the variance vs Droptop's 100 on hand
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−10').length).toBeGreaterThan(0)
    // last receipt hint
    expect(screen.getAllByText(/\+24/).length).toBeGreaterThan(0)

    // open the Bay 1 place: only its products, with the "also counted" hint for a product counted in two places
    fireEvent.click(screen.getAllByRole('button', { name: /^Bay 1/ })[0])
    await waitFor(() => expect(screen.queryByText('WIPER')).toBeNull())
    expect(screen.getByText(/Also counted: Back room 30/)).toBeTruthy()

    // "add count" adds another entry spot
    const before = document.querySelectorAll('input[data-qty-input]').length
    fireEvent.click(screen.getAllByText(/add count/i)[0])
    await waitFor(() => expect(document.querySelectorAll('input[data-qty-input]').length).toBe(before + 1))
    expect(inserted.some((i) => i.table === 'count_sheet_entries')).toBe(true)
  }, 15000)

  it('filters by product type and searches', async () => {
    localStorage.setItem('count_sheet_last_shop', 'loc1')
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<CountSheetPage />)
    await screen.findByText('WIPER', {}, { timeout: 5000 }); await screen.findByText('SYN-5W30')
    fireEvent.change(screen.getByPlaceholderText('Search products…'), { target: { value: 'wiper' } })
    await waitFor(() => expect(screen.queryByText('SYN-5W30')).toBeNull())
    expect(screen.getByText('WIPER')).toBeTruthy()
    const table = within(document.body)
    expect(table.getByText(/1 shown/)).toBeTruthy()
  }, 15000)
})
