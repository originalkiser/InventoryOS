// Page-level repro: render IssuesPage with data, then click "+ New Issue".
// If the page render loops, this hangs and vitest kills it.
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const dataBySection: Record<string, any[]> = {
  issues: [
    {
      id: 'i1', title: 'Freezer running warm', location_id: 'l1', category_id: 'c1', status_id: 's1',
      start_date: '2026-01-01', target_resolution_date: null, resolved_date: null, resolution_notes: null,
      created_at: '2026-01-01T00:00:00Z',
      locations: { name: 'Store 1' }, issue_categories: { name: 'Equipment' }, issue_statuses: { name: 'Open' },
    },
  ],
  locations: [{ id: 'l1', name: 'Store 1' }],
  issue_categories: [{ id: 'c1', name: 'Equipment' }],
  issue_statuses: [{ id: 's1', name: 'Open' }, { id: 's2', name: 'Resolved' }],
}

vi.mock('@/lib/supabase', () => {
  const makeQuery = (data: any[]) => {
    const p: any = {
      select: () => p,
      eq: () => p,
      order: () => p,
      single: () => Promise.resolve({ data: data?.[0], error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data, error: null }).then(onF, onR),
    }
    return p
  }
  const channel: any = { on: () => channel, subscribe: () => channel }
  return {
    supabase: {
      from: (t: string) => makeQuery(dataBySection[t] ?? []),
      channel: () => channel,
      removeChannel: () => {},
    },
  }
})

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), () => {}],
}))

import { IssuesPage } from './IssuesPage'
import { useAuthStore } from '@/stores/authStore'

describe('IssuesPage repro', () => {
  it('clicking + New Issue opens the modal without freezing', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<IssuesPage />)
    await waitFor(() => expect(screen.getByText(/Freezer running warm/i)).toBeTruthy())
    // Regression: clicking used to trigger an autoResetPageIndex render loop
    // (the filtered useTable arrays are new refs each render) and freeze the tab.
    const btn = screen.getAllByText('+ New Issue')[0]
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText('New Issue')).toBeTruthy())
  }, 8000)
})
