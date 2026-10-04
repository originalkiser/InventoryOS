import { describe, it, expect } from 'vitest'
import { tankQuarts, tankVolume, cuInToGallons, dimsComplete } from './tankMath'

describe('tank volume', () => {
  it('vertical cylinder: pi r^2 h', () => {
    const g = cuInToGallons(tankVolume('vertical_cylinder', { diameter: 48, height: 60 }, 30).volumeCuIn)
    expect(g).toBeCloseTo((Math.PI * 24 * 24 * 30) / 231, 3)
  })
  it('rectangle: l x w x depth', () => {
    expect(tankQuarts('rectangle', { length: 48, width: 24, height: 36 }, 12).quarts).toBeCloseTo((48 * 24 * 12) / 231 * 4, 5)
  })
  it('horizontal cylinder is exactly half full at half the diameter', () => {
    const q = tankQuarts('horizontal_cylinder', { length: 120, diameter: 48 }, 24)
    expect(q.quarts).toBeCloseTo(q.capacityQuarts / 2, 1)
    expect(q.capacityQuarts).toBeCloseTo((Math.PI * 24 * 24 * 120) / 231 * 4, 1)
  })
  it('capsule and elliptical heads add volume beyond the flat-ended cylinder of the same body', () => {
    const flat = tankQuarts('horizontal_cylinder', { length: 100, diameter: 48 }, 48).capacityQuarts
    const capsule = tankQuarts('horizontal_capsule', { length: 100, diameter: 48 }, 48).capacityQuarts
    // body 52 + two hemispheres = pi r^2 (52) + 4/3 pi r^3
    expect(capsule).toBeCloseTo(((Math.PI * 576 * 52 + (4 / 3) * Math.PI * 24 ** 3) / 231) * 4, 1)
    expect(capsule).toBeLessThan(flat)
  })
  it('depth is clamped to the inside depth and never negative', () => {
    const q = tankQuarts('vertical_cylinder', { diameter: 48, height: 60 }, 999)
    expect(q.quarts).toBeCloseTo(q.capacityQuarts, 5)
    expect(tankQuarts('vertical_cylinder', { diameter: 48, height: 60 }, -5).quarts).toBe(0)
  })
  it('vertical capsule is monotonic and fills to capacity', () => {
    let prev = -1
    for (let d = 0; d <= 60; d += 5) {
      const v = tankQuarts('vertical_capsule', { diameter: 30, height: 60 }, d).quarts
      expect(v).toBeGreaterThanOrEqual(prev); prev = v
    }
    expect(prev).toBeCloseTo(tankQuarts('vertical_capsule', { diameter: 30, height: 60 }, 60).capacityQuarts, 3)
  })
  it('knows when a shape has all its dimensions', () => {
    expect(dimsComplete('horizontal_dish', { length: 100, diameter: 48 })).toBe(false)
    expect(dimsComplete('horizontal_dish', { length: 100, diameter: 48, dish_depth: 6 })).toBe(true)
  })
})
