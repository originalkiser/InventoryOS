// Tank volume at a filled depth, for the shapes in CalculatorSoup's tank calculator. All dimensions are INCHES; volumes
// come back in cubic inches, converted to U.S. gallons / quarts by the helpers. Pure — no React — so it's testable.
//
// Every horizontal tank is a cross-section area (closed-form circular / elliptical segments) times its body length, plus
// two heads; every vertical tank is a cross-section area times depth (with rounded ends for capsules).

export type TankShape =
  | 'horizontal_cylinder' | 'vertical_cylinder' | 'rectangle' | 'horizontal_oval' | 'vertical_oval'
  | 'horizontal_capsule' | 'vertical_capsule' | 'horizontal_elliptical' | 'horizontal_dish' | 'horizontal_ellipse'

export type DimKey = 'length' | 'width' | 'height' | 'diameter' | 'dish_depth'
export type TankDims = Partial<Record<DimKey, number>>

export interface ShapeDef { label: string; dims: { key: DimKey; label: string; hint?: string }[]; orientation: 'horizontal' | 'vertical' | 'box' }

const L = { key: 'length' as const, label: 'Length (inches)', hint: 'End to end, overall' }
const D = { key: 'diameter' as const, label: 'Diameter (inches)' }
export const SHAPES: Record<TankShape, ShapeDef> = {
  horizontal_cylinder: { label: 'Horizontal Cylinder', orientation: 'horizontal', dims: [L, D] },
  vertical_cylinder: { label: 'Vertical Cylinder', orientation: 'vertical', dims: [{ key: 'height', label: 'Height (inches)' }, D] },
  rectangle: { label: 'Rectangle/Tote/Rhino', orientation: 'box', dims: [L, { key: 'width', label: 'Width (inches)' }, { key: 'height', label: 'Height (inches)' }] },
  horizontal_oval: { label: 'Horizontal Oval', orientation: 'horizontal', dims: [L, { key: 'width', label: 'Width (inches)', hint: 'Widest point of the oval' }, { key: 'height', label: 'Height (inches)' }] },
  vertical_oval: { label: 'Vertical Oval', orientation: 'vertical', dims: [{ key: 'height', label: 'Height (inches)' }, { key: 'width', label: 'Width (inches)', hint: 'Long side of the oval' }, { key: 'diameter', label: 'Depth front-to-back (inches)' }] },
  horizontal_capsule: { label: 'Horizontal Capsule', orientation: 'horizontal', dims: [L, D] },
  vertical_capsule: { label: 'Vertical Capsule', orientation: 'vertical', dims: [{ key: 'height', label: 'Height (inches)', hint: 'Overall, including both rounded ends' }, D] },
  horizontal_elliptical: { label: 'Horizontal 2:1 Elliptical', orientation: 'horizontal', dims: [L, D] },
  horizontal_dish: { label: 'Horizontal Dish Ends', orientation: 'horizontal', dims: [L, D, { key: 'dish_depth', label: 'Dish depth (inches)', hint: 'How far each end bows out' }] },
  horizontal_ellipse: { label: 'Horizontal Ellipse', orientation: 'horizontal', dims: [L, { key: 'width', label: 'Width (inches)' }, { key: 'height', label: 'Height (inches)' }] },
}
/** The shapes offered for a NEW tank, in dropdown order. The elliptical / dish-end / ellipse shapes are retired (no longer offered) but stay
 *  in SHAPES so a tank already saved with one keeps calculating and drawing correctly. */
export const SHAPE_ORDER: TankShape[] = ['rectangle', 'horizontal_cylinder', 'horizontal_capsule', 'horizontal_oval', 'vertical_cylinder', 'vertical_capsule', 'vertical_oval']
export const MEASURE_HEIGHT_HELP = 'Measure from the bottom of the tank to the capacity line or top fill line — e.g. on a tote tank, measure from the bottom of the tank to the last line on the tote, not to the top of the tote.'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pos = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0)

/** Area of the part of a circle of radius r that is below height y (measured from the bottom). */
function circleSegmentArea(r: number, y: number): number {
  const d = clamp(y, 0, 2 * r)
  if (r <= 0 || d <= 0) return 0
  if (d >= 2 * r) return Math.PI * r * r
  return r * r * Math.acos((r - d) / r) - (r - d) * Math.sqrt(Math.max(0, 2 * r * d - d * d))
}
/** Same for an ellipse of full width W and height H. */
const ellipseSegmentArea = (W: number, H: number, y: number) => (H > 0 ? (W / H) * circleSegmentArea(H / 2, y) : 0)
/** A stadium ("oval" with flat top and bottom and semicircular sides), W wide and H tall. */
const stadiumSegmentArea = (W: number, H: number, y: number) => Math.max(0, W - H) * clamp(y, 0, H) + circleSegmentArea(H / 2, y)
/** Volume of the liquid in one dished/elliptical head (depth e) of a round tank of radius r, liquid height y. */
const headVolume = (r: number, e: number, y: number) => (r > 0 ? (e / r) * (Math.PI * y * y * (3 * r - y)) / 6 : 0)

export interface TankCalc { volumeCuIn: number; capacityCuIn: number; maxDepth: number }

/** Liquid volume (cubic inches) at filled depth `depth` (inches), the tank's full capacity and its inside depth. */
export function tankVolume(shape: TankShape, dims: TankDims, depth: number): TankCalc {
  const len = pos(dims.length), dia = pos(dims.diameter), w = pos(dims.width), h = pos(dims.height)
  const dish = pos(dims.dish_depth)
  const calc = (maxDepth: number, vol: (d: number) => number): TankCalc => {
    const d = clamp(depth, 0, maxDepth)
    return { volumeCuIn: vol(d), capacityCuIn: vol(maxDepth), maxDepth }
  }
  switch (shape) {
    case 'rectangle': return calc(h, (d) => len * w * d)
    case 'vertical_cylinder': return calc(h, (d) => Math.PI * (dia / 2) ** 2 * d)
    case 'vertical_oval': return calc(h, (d) => {
      const r = Math.min(w, dia) / 2
      return ((Math.max(w, dia) - 2 * r) * 2 * r + Math.PI * r * r) * d
    })
    case 'vertical_capsule': {
      const r = dia / 2
      const cyl = Math.max(0, h - 2 * r)
      const cap = (y: number) => (Math.PI * y * y * (3 * r - y)) / 3
      return calc(h, (d) => {
        if (d <= r) return cap(d)
        if (d <= r + cyl) return cap(r) + Math.PI * r * r * (d - r)
        const empty = h - d
        return cap(r) * 2 + Math.PI * r * r * cyl - cap(Math.max(0, empty))
      })
    }
    case 'horizontal_cylinder': case 'horizontal_capsule': case 'horizontal_elliptical': case 'horizontal_dish': {
      const r = dia / 2
      const e = shape === 'horizontal_capsule' ? r : shape === 'horizontal_elliptical' ? r / 2 : shape === 'horizontal_dish' ? dish : 0
      const body = Math.max(0, len - 2 * e)
      return calc(dia, (d) => body * circleSegmentArea(r, d) + 2 * headVolume(r, e, d))
    }
    case 'horizontal_oval': return calc(h, (d) => len * stadiumSegmentArea(w, h, d))
    case 'horizontal_ellipse': return calc(h, (d) => len * ellipseSegmentArea(w, h, d))
  }
}

export const CU_IN_PER_GAL = 231
export const cuInToGallons = (v: number) => v / CU_IN_PER_GAL
export const cuInToQuarts = (v: number) => (v / CU_IN_PER_GAL) * 4

/** Quarts at a filled depth, plus the tank's capacity in quarts. */
export function tankQuarts(shape: TankShape, dims: TankDims, depth: number) {
  const c = tankVolume(shape, dims, depth)
  return { quarts: cuInToQuarts(c.volumeCuIn), capacityQuarts: cuInToQuarts(c.capacityCuIn), maxDepth: c.maxDepth }
}

/** Which dimension is the tank's inside depth (what a monitor's "height" corresponds to). */
export function depthKey(shape: TankShape): DimKey {
  return shape === 'horizontal_cylinder' || shape === 'horizontal_capsule' || shape === 'horizontal_elliptical' || shape === 'horizontal_dish' ? 'diameter' : 'height'
}

/** True when every dimension the shape needs has a positive value. */
export function dimsComplete(shape: TankShape, dims: TankDims): boolean {
  return SHAPES[shape].dims.every((d) => pos(dims[d.key]) > 0)
}
