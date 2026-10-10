import { describe, expect, it } from 'vitest'
import { deriveSummary } from './droptopRollups'
import type { Classification } from './PackageMappingPage'

const cls = new Map<string, Classification>([['Economy', 'oil_change'], ['Premium', 'oil_change'], ['Air Filter', 'air_filter'], ['Wipers', 'wiper_blades'], ['Flush', 'none']])

describe('deriveSummary', () => {
  const sales = [
    { order_date: '2026-10-01', location_id: 'a', orders: 10, revenue: 1000, subtotal: 950 },
    { order_date: '2026-10-02', location_id: 'a', orders: 5, revenue: 500, subtotal: 480 },
    { order_date: '2026-10-02', location_id: 'b', orders: 5, revenue: 600, subtotal: 580 },
  ]
  const pkgs = [
    { package_name: 'Economy', orders: 12, packages_sold: 12, revenue: 800 },
    { package_name: 'Premium', orders: 6, packages_sold: 8, revenue: 700 },
    { package_name: 'Air Filter', orders: 4, packages_sold: 4, revenue: 100 },
    { package_name: 'Wipers', orders: 2, packages_sold: 2, revenue: 60 },
    { package_name: 'Flush', orders: 1, packages_sold: 1, revenue: 90 },
  ]
  const prods = [
    { product_id: 'x', product_type: 'oil', brand_name: null, uom: 'QT', quantity: 100, price_total: 0, cost_total: 0 },
    { product_id: 'y', product_type: 'filter', brand_name: null, uom: 'EA', quantity: 50, price_total: 0, cost_total: 0 },
  ]
  it('takes order counts and revenue from sales by day, never from package orders', () => {
    const s = deriveSummary(sales, pkgs, prods, cls)
    expect(s.totals.count).toBe(20)
    expect(s.totals.revenue).toBe(2100)
    expect(s.totals.avg_order_value).toBe(105)
    expect(s.dataThrough).toBe('2026-10-02')
    expect(s.by_shop.find((x) => x.location_id === 'a')).toMatchObject({ count: 15, revenue: 1500 })
  })
  it('computes M5% from packages sold and oil quarts per oil-change package', () => {
    const s = deriveSummary(sales, pkgs, prods, cls)
    expect(s.totals.m5_pct).toBeCloseTo(30, 5) // (4+2) / (12+8)
    expect(s.totals.avg_quarts_per_oil_order).toBeCloseTo(5, 5) // 100 qt / 20
  })
  it('handles an empty range', () => {
    const s = deriveSummary([], [], [], cls)
    expect(s.totals).toMatchObject({ count: 0, revenue: 0, avg_order_value: 0, m5_pct: null })
    expect(s.dataThrough).toBeNull()
  })
})
