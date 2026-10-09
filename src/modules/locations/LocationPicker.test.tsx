import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocationPicker, type PickerShop } from './LocationPicker'

afterEach(cleanup)

const shops: PickerShop[] = [
  { id: 'a', num: '14', name: 'Greenville', am: 'Dana', director: 'Pat', types: ['zero_sales', 'po_late'] },
  { id: 'b', num: '27', name: 'Simpsonville', am: 'Marcus', director: 'Pat', types: [] },
  { id: 'c', num: '55', name: 'Anderson', am: 'Marcus', director: 'Lee', types: ['duplicate_case'] },
]

describe('LocationPicker', () => {
  it('opens, filters by search and by exception type, and picks a shop', () => {
    const onChange = vi.fn()
    render(<LocationPicker shops={shops} value="a" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Greenville/i }))
    expect(screen.getByText('3 of 3 locations')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Duplicate case types on hand'))            // type filter chip
    expect(screen.getByText('1 of 3 locations')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Duplicate case types on hand'))            // off again
    fireEvent.change(screen.getByLabelText('Search locations'), { target: { value: 'simps' } })
    expect(screen.getByText('1 of 3 locations')).toBeTruthy()
    fireEvent.click(screen.getByText('Simpsonville'))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('groups the list by area manager or director, and has no "Flagged" button or "List by" text', () => {
    render(<LocationPicker shops={shops} value="a" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Greenville/i }))
    expect(screen.queryByText('Flagged')).toBeNull()
    expect(screen.queryByText(/list by/i)).toBeNull()
    fireEvent.click(screen.getByText('Area Manager'))
    expect(screen.getByText('Marcus')).toBeTruthy()
    expect(screen.getByText('2 stores')).toBeTruthy()
    fireEvent.click(screen.getByText('Director'))
    expect(screen.getByText('Lee')).toBeTruthy()
  })

  it('can hide the icons and filters', () => {
    render(<LocationPicker shops={shops} value="a" onChange={() => {}} showIcons={false} showFilters={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Greenville/i }))
    expect(screen.queryByLabelText('Duplicate case types on hand')).toBeNull()
  })
})
