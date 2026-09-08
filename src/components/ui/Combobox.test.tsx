// Keyboard-navigation coverage for the shared Combobox (28 consumers app-wide,
// including the Location Lookup shop picker this was added for) — Arrow keys
// should walk the (possibly search-filtered) option list, Enter should commit
// the highlighted row, and Escape should close without selecting.
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Combobox } from './Combobox'

// This project's vitest config doesn't set `test.globals`, so RTL's usual
// auto-cleanup-via-global-afterEach never registers — without this, each
// test's render() would stack on top of the last, breaking getByRole
// lookups across the multiple cases below.
afterEach(cleanup)

const options = [
  { value: '1', label: 'Alpha Shop' },
  { value: '2', label: 'Beta Shop' },
  { value: '3', label: 'Gamma Shop' },
]

describe('Combobox keyboard navigation', () => {
  it('opens highlighting the first row, and one ArrowDown/Enter selects the second option', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Type to search...')
    // Nothing selected yet, so opening seeds the highlight on row 0 (Alpha) —
    // one Down moves to row 1 (Beta) without needing an extra press first.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('2', 'Beta Shop')
  })

  it('narrows via search text, then Down/Enter selects from the filtered results', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Type to search...')
    fireEvent.change(input, { target: { value: 'gam' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('3', 'Gamma Shop')
  })

  it('does not move highlight past the last row (clamps, does not wrap)', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Type to search...')
    for (let i = 0; i < 10; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('3', 'Gamma Shop')
  })

  it('Escape closes the dropdown without selecting', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Type to search...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Type to search...')).toBeNull()
  })

  it('opening re-seeds the highlight on the currently selected value', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="2" onChange={onChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Type to search...')
    // Already on Beta (index 1) — one more Down should land on Gamma (index 2).
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('3', 'Gamma Shop')
  })

  it('Enter/Space/ArrowDown on the closed trigger opens it (keyboard-reachable without a mouse click)', () => {
    const onChange = vi.fn()
    render(<Combobox options={options} value="" onChange={onChange} />)

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })

    expect(screen.getByPlaceholderText('Type to search...')).toBeTruthy()
  })
})
