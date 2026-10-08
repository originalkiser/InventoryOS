import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DateRangePicker, type RangePreset } from './DateRangePicker'

afterEach(cleanup)

const presets: RangePreset[] = [{ key: 'last_7_days', label: 'Last 7 days', range: () => ({ start: '2026-10-01', end: '2026-10-07' }) }]

function setup(over: Partial<React.ComponentProps<typeof DateRangePicker>> = {}) {
  const onApply = vi.fn()
  render(<DateRangePicker triggerText="Pick" start="2026-10-05" end="2026-10-08" presets={presets} onApply={onApply} {...over} />)
  fireEvent.click(screen.getByText('Pick'))
  return onApply
}

describe('DateRangePicker', () => {
  it('opens on the current range and applies a new one (second click ends it, an earlier click restarts it)', () => {
    const onApply = setup()
    expect(screen.getByText('Oct 5 to Oct 8 · 4 days')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /October 12, 2026/ }))   // starts over
    expect(screen.getByText(/Pick an end date on or after Oct 12/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /October 9, 2026/ }))    // earlier than start -> becomes the start
    expect(screen.getByText(/earlier than your start/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /October 15, 2026/ }))
    fireEvent.click(screen.getByText('Apply'))
    expect(onApply).toHaveBeenCalledWith('2026-10-09', '2026-10-15', null)
  })
  it('a preset applies with its key, and a single day is a valid range', () => {
    const onApply = setup()
    fireEvent.click(screen.getByText('Last 7 days'))
    fireEvent.click(screen.getByText('Apply'))
    expect(onApply).toHaveBeenCalledWith('2026-10-01', '2026-10-07', 'last_7_days')
    cleanup()
    const again = setup()
    fireEvent.click(screen.getByText('Clear'))
    fireEvent.click(screen.getByRole('button', { name: /October 6, 2026/ }))
    fireEvent.click(screen.getByRole('button', { name: /October 6, 2026/ }))
    fireEvent.click(screen.getByText('Apply'))
    expect(again).toHaveBeenCalledWith('2026-10-06', '2026-10-06', null)
  })
  it('will not pick days after maxDate', () => {
    const onApply = setup({ maxDate: '2026-10-08' })
    fireEvent.click(screen.getByText('Clear'))
    const future = screen.getByRole('button', { name: /October 20, 2026/ }) as HTMLButtonElement
    expect(future.disabled).toBe(true)
    expect(onApply).not.toHaveBeenCalled()
  })
})
