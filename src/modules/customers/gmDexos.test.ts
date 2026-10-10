import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS, classifyVehicle, compliancePct, isApprovedOilId, isGmMake, monthChunks, normalizeSettings,
  totalsOf, vehicleAge, warrantyStatus, chunkArray, type SummaryRow,
} from './gmDexos'

const S = DEFAULT_SETTINGS
const base = { make: 'Chevrolet', modelYear: 2024, mileage: 30000, serviceDate: '2026-09-10', usesDexos: false }

describe('isApprovedOilId', () => {
  const ids = S.approvedIds
  it('matches approved ids and their case-type variants', () => {
    expect(isApprovedOilId('DEXOS-SYN-5W30', ids)).toBe(true)
    expect(isApprovedOilId('DEXOS-SYN-5W30D', ids)).toBe(true)
    expect(isApprovedOilId('DEXOS-SYN-0W20BB', ids)).toBe(true)
    expect(isApprovedOilId('dexos-syn-0w20d', ids)).toBe(true)
    expect(isApprovedOilId('0W40-MBL1-DEXOSR', ids)).toBe(true)
  })
  it('does not match other oils or longer ids', () => {
    expect(isApprovedOilId('SYN-0W20', ids)).toBe(false)
    expect(isApprovedOilId('SYN-5W30D', ids)).toBe(false)
    expect(isApprovedOilId('EURO-SYN-0W20C', ids)).toBe(false)
    expect(isApprovedOilId('DEXOS-SYN-5W30-EXTRA', ids)).toBe(false)
    expect(isApprovedOilId('DEXOS-SYN-5W30ABCD', ids)).toBe(false)
    expect(isApprovedOilId('', ids)).toBe(false)
    expect(isApprovedOilId(null, ids)).toBe(false)
  })
  it('escapes regex characters in configured ids', () => {
    expect(isApprovedOilId('A.B', ['A.B'])).toBe(true)
    expect(isApprovedOilId('AxB', ['A.B'])).toBe(false)
  })
})

describe('warranty rules', () => {
  it('age is service year minus model year', () => {
    expect(vehicleAge('2026-09-10', 2023)).toBe(3)
  })
  it('requires BOTH age < years AND miles < limit', () => {
    expect(warrantyStatus({ modelYear: 2024, mileage: 30000, serviceDate: '2026-09-10' }, S)).toBe('in')
    expect(warrantyStatus({ modelYear: 2021, mileage: 30000, serviceDate: '2026-09-10' }, S)).toBe('out') // age 5 is not < 5
    expect(warrantyStatus({ modelYear: 2022, mileage: 30000, serviceDate: '2026-09-10' }, S)).toBe('in') // age 4
    expect(warrantyStatus({ modelYear: 2024, mileage: 60000, serviceDate: '2026-09-10' }, S)).toBe('out') // miles not < 60000
    expect(warrantyStatus({ modelYear: 2024, mileage: 59999, serviceDate: '2026-09-10' }, S)).toBe('in')
    expect(warrantyStatus({ modelYear: 2018, mileage: 20000, serviceDate: '2026-09-10' }, S)).toBe('out')
  })
  it('missing year or zero/missing mileage is unknown', () => {
    expect(warrantyStatus({ modelYear: null, mileage: 100, serviceDate: '2026-09-10' }, S)).toBe('unknown')
    expect(warrantyStatus({ modelYear: 2024, mileage: null, serviceDate: '2026-09-10' }, S)).toBe('unknown')
    expect(warrantyStatus({ modelYear: 2024, mileage: 0, serviceDate: '2026-09-10' }, S)).toBe('unknown')
  })
  it('honours custom limits', () => {
    expect(warrantyStatus({ modelYear: 2021, mileage: 70000, serviceDate: '2026-09-10' }, { maxAgeYears: 6, maxMiles: 100000 })).toBe('in')
  })
})

describe('classifyVehicle', () => {
  it('splits GM in warranty by Dexos use', () => {
    expect(classifyVehicle({ ...base, usesDexos: true }, S)).toBe('gm_warranty_dexos')
    expect(classifyVehicle({ ...base, usesDexos: false }, S)).toBe('gm_warranty_miss')
  })
  it('GM out of warranty ignores oil choice', () => {
    expect(classifyVehicle({ ...base, mileage: 90000, usesDexos: true }, S)).toBe('gm_out_of_warranty')
    expect(classifyVehicle({ ...base, modelYear: 2015 }, S)).toBe('gm_out_of_warranty')
  })
  it('GM with missing data is unknown', () => {
    expect(classifyVehicle({ ...base, modelYear: null }, S)).toBe('gm_unknown')
  })
  it('non-GM is split by Dexos only', () => {
    expect(classifyVehicle({ ...base, make: 'Toyota', usesDexos: true }, S)).toBe('nongm_dexos')
    expect(classifyVehicle({ ...base, make: 'Toyota' }, S)).toBe('nongm_no_dexos')
    expect(classifyVehicle({ ...base, make: null }, S)).toBe('nongm_no_dexos')
  })
  it('make matching is case-insensitive and editable', () => {
    expect(isGmMake(' chevrolet ', S.gmMakes)).toBe(true)
    expect(isGmMake('Pontiac', S.gmMakes)).toBe(false)
    expect(isGmMake('Pontiac', [...S.gmMakes, 'Pontiac'])).toBe(true)
  })
})

describe('normalizeSettings', () => {
  it('falls back to defaults for missing/garbled values', () => {
    expect(normalizeSettings(null)).toEqual(S)
    expect(normalizeSettings({ maxAgeYears: -1, maxMiles: NaN as unknown as number, approvedIds: 'x' as unknown as string[] })).toEqual(S)
  })
  it('dedupes and trims lists', () => {
    expect(normalizeSettings({ approvedIds: [' A ', 'a', '', 'B'] }).approvedIds).toEqual(['A', 'B'])
  })
})

describe('roll-ups', () => {
  const row = (o: Partial<SummaryRow>): SummaryRow => ({
    location_id: 'x', month: '2026-08-01', total_vehicles: 0, total_orders: 0, gm_warranty_dexos: 0, gm_warranty_miss: 0,
    gm_out_of_warranty: 0, gm_unknown: 0, nongm_dexos: 0, nongm_no_dexos: 0, ...o,
  })
  it('compliance is dexos / (dexos + miss)', () => {
    expect(compliancePct(1, 3)).toBe(25)
    expect(compliancePct(0, 0)).toBeNull()
    expect(compliancePct(5, 0)).toBe(100)
  })
  it('totals sum rows and compute compliance', () => {
    const t = totalsOf([row({ gm_warranty_dexos: 1, gm_warranty_miss: 1, total_vehicles: 2 }), row({ gm_warranty_miss: 2, gm_out_of_warranty: 4, total_vehicles: 6 })])
    expect(t.gmWarrantyDexos).toBe(1)
    expect(t.gmWarrantyMiss).toBe(3)
    expect(t.gmOutOfWarranty).toBe(4)
    expect(t.vehicles).toBe(8)
    expect(t.compliance).toBe(25)
  })
})

describe('monthChunks', () => {
  it('splits a range into clipped calendar months', () => {
    expect(monthChunks('2026-08-01', '2026-10-10')).toEqual([
      { month: '2026-08-01', start: '2026-08-01', end: '2026-08-31' },
      { month: '2026-09-01', start: '2026-09-01', end: '2026-09-30' },
      { month: '2026-10-01', start: '2026-10-01', end: '2026-10-10' },
    ])
  })
  it('clips a mid-month start and crosses years', () => {
    const c = monthChunks('2026-12-15', '2027-01-05')
    expect(c).toEqual([
      { month: '2026-12-01', start: '2026-12-15', end: '2026-12-31' },
      { month: '2027-01-01', start: '2027-01-01', end: '2027-01-05' },
    ])
  })
  it('returns nothing for an inverted range', () => {
    expect(monthChunks('2026-09-02', '2026-09-01')).toEqual([])
  })
  it('chunkArray splits evenly', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})
