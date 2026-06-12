// Reproduction harness for the "New Issue freezes" report.
// Renders IssueFormModal with mock option data; if it infinite-loops, this test
// hangs and vitest kills it (confirming a render loop, not env-specific).
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const dataBySection: Record<string, any[]> = {
  locations: [{ id: 'l1', name: 'Store 1' }, { id: 'l2', name: 'Store 2' }],
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
  return { supabase: { from: (t: string) => makeQuery(dataBySection[t] ?? []) } }
})

import { IssueFormModal } from './IssueFormModal'
import { useAuthStore } from '@/stores/authStore'

describe('IssueFormModal repro', () => {
  it('opens with option data without infinite-looping', async () => {
    useAuthStore.setState({ profile: { id: 'u1', company_id: 'co1', full_name: 'T', email: 't@x.com', role: 'admin' } as any })
    render(<IssueFormModal open onClose={() => {}} existing={null} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getByText('New Issue')).toBeTruthy())
  }, 8000)
})
