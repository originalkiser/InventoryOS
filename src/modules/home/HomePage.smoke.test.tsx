// Smoke test: the Home page renders every card against an empty fake Supabase (no crash, each card reaches its empty state), and Customize
// exposes the remove / add controls.
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

vi.mock('@/lib/supabase', () => {
  const builder = () => {
    const p: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'neq', 'gte', 'order', 'limit', 'range']) p[m] = () => p
    p.then = (ok: any, bad: any) => Promise.resolve({ data: [], count: 0, error: null }).then(ok, bad)
    return p
  }
  return { supabase: { schema: () => ({ from: builder }), from: builder } }
})
vi.mock('react-grid-layout', () => {
  const Grid = ({ children }: any) => <div data-testid="grid">{children}</div>
  return { default: Grid, WidthProvider: (c: any) => c }
})
vi.mock('@/hooks/useColumnPrefs', () => ({ usePersistedJson: (_k: string, d: any) => useState(d) }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }))
vi.mock('@/hooks/useLocations', () => ({ useLocations: () => ({ codeOf: (id: string) => id, labelOf: (id: string) => id, locations: [], loading: false }) }))
vi.mock('@/hooks/useDeptAccess', () => ({ useDeptAccess: () => null }))
vi.mock('@/hooks/useProfilePrefs', () => ({ useProfilePref: (_k: string, d: any) => [d, () => {}, true] }))
vi.mock('@/hooks/useSidebarPrefs', () => ({
  useSidebarPrefs: () => ({ sectionOrder: ['inventory', 'droptop'], itemOrder: {}, favorites: [], sectionCollapsed: {} }),
}))
vi.mock('@/hooks/useNavBadges', () => ({
  useNavBadge: () => 0, useNavBadgeSum: () => 0,
  useNavBadgesStore: (sel: any) => sel({ counts: { 'po-status': 4 } }),
}))
vi.mock('@/hooks/useInventoryAlerts', () => ({ useInventoryAlertsStore: (sel: any) => sel({ derivedCount: 2 }) }))
vi.mock('@/stores/recentPagesStore', () => ({ useRecentPagesStore: (sel: any) => sel({ recentPages: [{ path: '/orders-v2', label: 'Orders v2', visitedAt: Date.now() }] }) }))

import HomePage from './HomePage'
import { useAuthStore } from '@/stores/authStore'

afterEach(cleanup)

describe('Home page', () => {
  it('renders the cards and their empty states', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'Pat Example', email: 'p@x.com', role: 'admin' } as any })
    render(<MemoryRouter><HomePage /></MemoryRouter>)
    expect(screen.getByText(/Pat/)).toBeTruthy()                       // welcome card
    expect(screen.getByText('Needs attention')).toBeTruthy()
    expect(await screen.findByText('Nothing late.')).toBeTruthy()       // late POs, empty
    expect(await screen.findByText('No orders in progress.')).toBeTruthy()
    expect(screen.getByText('Jump back in')).toBeTruthy()
    expect(screen.getAllByText('Purchase Orders').length).toBeGreaterThan(0) // the po-status badge shows up in Needs attention
  })

  it('Customize lets a card be removed and added back', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'Pat Example', email: 'p@x.com', role: 'admin' } as any })
    render(<MemoryRouter><HomePage /></MemoryRouter>)
    fireEvent.click(screen.getByText('Customize'))
    const removes = screen.getAllByTitle('Remove this card')
    fireEvent.click(removes[removes.length - 1])
    await waitFor(() => expect(screen.getByText(/Add card \(1\)/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Add card \(1\)/))
    expect(screen.getByText('Jump back in', { selector: 'span' })).toBeTruthy()
  })
})
