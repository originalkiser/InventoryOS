import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditNumber, EditSelect, EditText } from './InlineCells'
import { StagedEdits } from './StagedEdits'

afterEach(cleanup)

function setup() {
  const saveNote = vi.fn(); const saveStatus = vi.fn(); const saveQty = vi.fn()
  render(
    <StagedEdits noun="change">
      <EditText value="old note" onSave={saveNote} stage={{ row: 'r1', rowLabel: 'PO-1', field: 'Notes' }} placeholder="note" />
      <EditSelect value="Open" options={['Open', 'Closed']} onSave={saveStatus} stage={{ row: 'r1', rowLabel: 'PO-1', field: 'Status' }} />
      <EditNumber value={5} onSave={saveQty} stage={{ row: 'r1', rowLabel: 'PO-1', field: 'Qty' }} />
    </StagedEdits>,
  )
  return { saveNote, saveStatus, saveQty }
}

describe('staged edits', () => {
  it('holds edits (nothing saved), shows the bar, and saves them all on Save', async () => {
    const { saveNote, saveStatus } = setup()
    fireEvent.change(screen.getByPlaceholderText('note'), { target: { value: 'new note' } })
    fireEvent.blur(screen.getByPlaceholderText('note'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Closed' } })
    expect(saveNote).not.toHaveBeenCalled(); expect(saveStatus).not.toHaveBeenCalled()
    expect(screen.getByText(/unsaved change/)).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    fireEvent.click(screen.getByText('Save 2'))
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith('new note'))
    expect(saveStatus).toHaveBeenCalledWith('Closed')
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).toBeNull())
  })

  it('Review lists the before / after and lets one be undone; Discard puts everything back without saving', async () => {
    const { saveNote, saveStatus } = setup()
    fireEvent.change(screen.getByPlaceholderText('note'), { target: { value: 'new note' } })
    fireEvent.blur(screen.getByPlaceholderText('note'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Closed' } })
    fireEvent.click(screen.getByText('Review'))
    expect(await screen.findByText('old note')).toBeTruthy()           // the "was"
    expect(screen.getByText('new note')).toBeTruthy()                 // the "now"
    fireEvent.click(screen.getAllByText('Undo')[0])                    // undo the note
    await waitFor(() => expect(screen.getByText('1', { selector: 'b' })).toBeTruthy())
    fireEvent.click(screen.getByText('Discard all'))
    fireEvent.click(await screen.findByText('Discard 1'))
    await waitFor(() => expect(screen.queryByText(/unsaved change/)).toBeNull())
    expect(saveNote).not.toHaveBeenCalled(); expect(saveStatus).not.toHaveBeenCalled()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('Open')
  })

  it('editing a cell back to the saved value clears its staged change', () => {
    setup()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Closed' } })
    expect(screen.getByText(/unsaved change/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Open' } })
    expect(screen.queryByText(/unsaved change/)).toBeNull()
  })

  it('outside a staged scope a cell saves straight away', () => {
    const save = vi.fn()
    render(<EditSelect value="Open" options={['Open', 'Closed']} onSave={save} stage={{ row: 'r', rowLabel: 'x', field: 'Status' }} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Closed' } })
    expect(save).toHaveBeenCalledWith('Closed')
  })
})
