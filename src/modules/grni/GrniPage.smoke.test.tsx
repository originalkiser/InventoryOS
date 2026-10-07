// Smoke test: mount the GRNI page against a fake Supabase and check the Summary / By Shop numbers end to end (no login needed).
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures: Record<string, any[]> = {
  grni_runs: [{ id: 'r1', period_month: '2026-09-01', cutoff_date: '2026-09-26', bulk_pct: 0.9, package_pct: 0.64, prior_pct: 0.9, compliance_threshold: 0.8, orders_uploaded_at: '2026-10-06T12:00:00Z', invoices_uploaded_at: '2026-10-06T12:00:00Z', notes: null, created_at: '2026-10-06T12:00:00Z' }],
  grni_product_prices: [
    { item_code: 'PKG', item_id: 'EURO-SYN-0W30C', uom: 'CS', pkg_qty_gal: 3, price_gal: 30, effective_from: '2000-01-01' },
    { item_code: 'BULK', item_id: 'SYN-0W20', uom: 'BULK', pkg_qty_gal: 1, price_gal: 10, effective_from: '2000-01-01' },
  ],
  grni_open_orders: [
    // shop 10: good receiving, received 2 of 2 cases -> $180
    { id: 'o1', order_date: '2026-09-10', customer_po_no: '10-09102026P', ship_to_name: 'STRICKLAND BROTHERS #10', shop: 10, product_code: 'PKG', product_desc: 'Euro 0W30 case', qty_ordered: 2 },
    // shop 20: low receiving -> bulk 100 gal x $10 x 90% = $900
    { id: 'o2', order_date: '2026-09-11', customer_po_no: '20-09112026B', ship_to_name: 'STRICKLAND BROTHERS #20', shop: 20, product_code: 'BULK', product_desc: 'SYN 0W20 bulk', qty_ordered: 100 },
    // earlier month still open -> 1 case x $90 x 90% = $81
    { id: 'o3', order_date: '2026-08-10', customer_po_no: '10-08102026P', ship_to_name: 'STRICKLAND BROTHERS #10', shop: 10, product_code: 'PKG', product_desc: 'Euro 0W30 case', qty_ordered: 1 },
  ],
  grni_open_invoices: [
    // shipped in September, invoiced in October: 6 gal x $30 = $180
    { id: 'i1', invoice_no: '9', customer_po_no: '30-09052026P', order_date: '2026-09-05', ship_date: '2026-09-08', invoice_date: '2026-10-02', shop: 30, product_code: 'PKG', product_desc: '', gallons_shipped: 6 },
  ],
  grni_shop_compliance: [{ shop: 20, shop_label: '20 - X', invoiced_gal: 100, received_gal: 10, pct: 0.1, source: 'computed', override: null }],
  droptop_purchase_orders: [{ id: 'po1', custom_po_id: '10-09102026P' }],
  droptop_purchase_order_items: [{ purchase_order_id: 'po1', product_id: 'EURO-SYN-0W30C', received_quantity: 2 }],
}

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let write = false
    const p: any = {
      select: () => p, eq: () => p, in: () => p, order: () => p, range: () => p,
      insert: () => { write = true; return p }, update: () => { write = true; return p }, delete: () => { write = true; return p }, upsert: () => { write = true; return p },
      single: () => Promise.resolve({ data: fixtures[table]?.[0] ?? null, error: null }),
      then: (ok: any, bad: any) => Promise.resolve({ data: write ? null : fixtures[table] ?? [], error: null }).then(ok, bad),
    }
    return p
  }
  return { supabase: { schema: () => ({ from: builder }), from: builder } }
})
vi.mock('@/hooks/useLocations', () => ({ useLocations: () => ({ includedOptions: [], locations: [{ id: 'a', name: '10', shop_city: '10-Elkin' }, { id: 'b', name: '20', shop_city: '20-Lenoir' }], loading: false }) }))

import { GrniPage } from './GrniPage'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => cleanup())

describe('GrniPage', () => {
  it('values received, assumed, invoiced-after and prior-month lines', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<GrniPage />)
    await screen.findByText('Current-month GRNI', {}, { timeout: 5000 })
    // received $180 + assumed $900 + invoiced after $180 = $1,260 current; prior $81; total $1,341
    expect(await screen.findByText('$1,260.00')).toBeTruthy()
    expect(screen.getAllByText('$180.00').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('$900.00')).toBeTruthy()
    expect(screen.getByText('$81.00')).toBeTruthy()
    expect(screen.getByText('$1,341.00')).toBeTruthy()
    // by shop: shop 20 is on the standard percentages
    fireEvent.click(screen.getByText('By Shop'))
    expect(await screen.findByText('20-Lenoir')).toBeTruthy()
    expect(screen.getByText(/Auto — standard %/)).toBeTruthy()
  }, 15000)
})
