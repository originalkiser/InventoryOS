// A side-view drawing of a tank shape with the liquid level shaded in. fill = 0..1 of the inside depth (what the shop measured).
// `monitorFill` draws a second line where the tank monitor says the level is; when the two disagree by more than the allowance
// (`overAllowance`), the space between them is shaded red.
import { useId } from 'react'
import type { TankShape } from './tankMath'

interface Body { kind: 'rect' | 'ellipse' | 'path'; x: number; y: number; w: number; h: number; rx?: number; d?: string; rim?: { cx: number; cy: number; rx: number; ry: number } }

// All drawn in a 120 x 80 box. Cylinders get elliptical caps so they read as cylinders rather than rectangles.
const BODIES: Record<TankShape, Body> = {
  horizontal_cylinder: { kind: 'path', x: 8, y: 18, w: 104, h: 44, d: 'M16 18 H104 A8 22 0 0 1 104 62 H16 A8 22 0 0 1 16 18 Z', rim: { cx: 16, cy: 40, rx: 8, ry: 22 } },
  horizontal_capsule: { kind: 'rect', x: 8, y: 18, w: 104, h: 44, rx: 22 },
  horizontal_elliptical: { kind: 'path', x: 8, y: 18, w: 104, h: 44, d: 'M20 18 H100 Q112 18 112 40 Q112 62 100 62 H20 Q8 62 8 40 Q8 18 20 18 Z' },
  horizontal_dish: { kind: 'path', x: 8, y: 18, w: 104, h: 44, d: 'M14 18 H106 Q112 18 112 24 V56 Q112 62 106 62 H14 Q8 62 8 56 V24 Q8 18 14 18 Z' },
  horizontal_oval: { kind: 'rect', x: 12, y: 14, w: 96, h: 52, rx: 20 },
  horizontal_ellipse: { kind: 'ellipse', x: 8, y: 16, w: 104, h: 48 },
  vertical_cylinder: { kind: 'path', x: 32, y: 6, w: 56, h: 68, d: 'M32 14 V66 A28 8 0 0 0 88 66 V14 A28 8 0 0 0 32 14 Z', rim: { cx: 60, cy: 14, rx: 28, ry: 8 } },
  vertical_capsule: { kind: 'rect', x: 34, y: 6, w: 52, h: 68, rx: 26 },
  vertical_oval: { kind: 'rect', x: 28, y: 6, w: 64, h: 68, rx: 18 },
  rectangle: { kind: 'rect', x: 20, y: 14, w: 80, h: 52, rx: 2 },
}

// The oil's surface is a gentle wave rather than a ruler-straight line. Empty and full tanks stay flat (nothing to wave at).
function wavePath(top: number, f: number, fill: boolean): string {
  if (f <= 0.001 || f >= 0.999) return fill ? `M0 ${top} H120 V80 H0 Z` : `M0 ${top} H120`
  const a = 1.8 // wave height in the 120 x 80 drawing
  const surface = `M0 ${top} q 7.5 -${a} 15 0${' t 15 0'.repeat(7)}`
  return fill ? `${surface} V80 H0 Z` : surface
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function TankShapeSvg({ shape, fill = 0, monitorFill = null, overAllowance = false, className = '' }: {
  shape: TankShape; fill?: number; monitorFill?: number | null; overAllowance?: boolean; className?: string
}) {
  const id = useId().replace(/:/g, '')
  const b = BODIES[shape] ?? BODIES.rectangle
  const f = clamp01(fill)
  const topOf = (x: number) => b.y + b.h * (1 - x)
  const liquidTop = topOf(f)
  const outline = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 }
  const clipShape = b.kind === 'rect' ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} />
    : b.kind === 'ellipse' ? <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} />
    : <path d={b.d} />
  const stroke = b.kind === 'rect' ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} {...outline} />
    : b.kind === 'ellipse' ? <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...outline} />
    : <path d={b.d} {...outline} />
  const mf = monitorFill == null ? null : clamp01(monitorFill)
  const monitorTop = mf == null ? null : topOf(mf)
  const clip = `url(#tank-${id})`
  return (
    <svg viewBox="0 0 120 80" className={className} role="img" aria-label={shape.replace(/_/g, ' ')}>
      <defs><clipPath id={`tank-${id}`}>{clipShape}</clipPath></defs>
      <path d={wavePath(liquidTop, f, true)} clipPath={clip} fill="#B7E0DE" opacity={0.85} />
      {/* shaded gap between what the shop measured and what the monitor says, when it's beyond the allowance */}
      {overAllowance && monitorTop != null && Math.abs(monitorTop - liquidTop) > 0.5 && (
        <rect x={0} y={Math.min(monitorTop, liquidTop)} width={120} height={Math.abs(monitorTop - liquidTop)} clipPath={clip} fill="#C0392B" opacity={0.55} />
      )}
      {f > 0.001 && f < 0.999 && monitorTop != null && <path d={wavePath(liquidTop, f, false)} clipPath={clip} fill="none" stroke="#4F7489" strokeWidth={1.6} />}
      {monitorTop != null && <line x1={0} x2={120} y1={monitorTop} y2={monitorTop} clipPath={clip} stroke="#002745" strokeWidth={1.6} strokeDasharray="4 2.5" />}
      {stroke}
      {b.rim && <ellipse cx={b.rim.cx} cy={b.rim.cy} rx={b.rim.rx} ry={b.rim.ry} {...outline} strokeWidth={1.4} />}
    </svg>
  )
}
