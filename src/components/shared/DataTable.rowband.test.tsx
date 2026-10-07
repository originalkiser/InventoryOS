// Row banding: a caller's row class (Orders v2's per-shop band) must survive a full-row tone, and a banded row sits on a plain base.
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createColumnHelper } from '@tanstack/react-table'

vi.mock('@/lib/supabase', () => ({ supabase: { schema: () => ({ from: () => ({}) }), from: () => ({}) } }))

import { DataTable } from './DataTable'
import { useTable } from '@/hooks/useTable'

interface Row { id: string; shop: string; product: string; excluded: boolean }
const col = createColumnHelper<Row>()
const columns = [col.accessor('shop', { header: 'Shop' }), col.accessor('product', { header: 'Product' })]
const data: Row[] = [
  { id: '1', shop: 'A', product: 'p1', excluded: false },
  { id: '2', shop: 'A', product: 'p2', excluded: true },
  { id: '3', shop: 'B', product: 'p3', excluded: true },
  { id: '4', shop: 'B', product: 'p4', excluded: false },
]
const BAND = 'bg-navy/[0.11]'

function Harness() {
  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, { initialColumnPinning: { left: ['shop'], right: [] } })
  return (
    <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
      getRowTone={(r) => (r.excluded ? 'rgba(124,139,150,0.25)' : null)}
      getRowClassName={(r) => (r.shop === 'B' ? BAND : 'bg-cream')} />
  )
}

afterEach(() => cleanup())

describe('DataTable row banding', () => {
  it('keeps the band under a toned row and uses a plain base for tinted rows', () => {
    const { container } = render(<Harness />)
    const rows = [...container.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(4)
    const band = (tr: Element) => [...tr.querySelectorAll("span")].some((s) => String(s.className).includes(BAND)) || tr.className.includes(BAND)
    // shop B rows carry the band whether or not they're toned (row 3 is excluded = toned)
    expect(band(rows[2])).toBe(true)
    expect(band(rows[3])).toBe(true)
    // shop A rows don't
    expect(band(rows[0])).toBe(false)
    expect(band(rows[1])).toBe(false)
    // the pinned shop cell of every banded/tinted row sits on the plain cream base — never the alternating zebra shade
    for (const tr of rows) {
      const pinned = [...tr.querySelectorAll('td')].find((td) => (td as HTMLElement).style.position === 'sticky' && td.textContent !== '')!
      expect(pinned.className).toContain('bg-cream')
      expect(pinned.className).not.toContain('ECEBD8')
    }
  })
})
