// A simple side-view drawing of a tank shape with the liquid level shaded in. fill = 0..1 of the inside depth.
import { useId } from 'react'
import type { TankShape } from './tankMath'

interface Body { kind: 'rect' | 'ellipse' | 'path'; x: number; y: number; w: number; h: number; rx?: number; d?: string }

// All drawn in a 120 x 80 box.
const BODIES: Record<TankShape, Body> = {
  horizontal_cylinder: { kind: 'rect', x: 8, y: 18, w: 104, h: 44, rx: 3 },
  horizontal_capsule: { kind: 'rect', x: 8, y: 18, w: 104, h: 44, rx: 22 },
  horizontal_elliptical: { kind: 'path', x: 8, y: 18, w: 104, h: 44, d: 'M20 18 H100 Q112 18 112 40 Q112 62 100 62 H20 Q8 62 8 40 Q8 18 20 18 Z' },
  horizontal_dish: { kind: 'path', x: 8, y: 18, w: 104, h: 44, d: 'M14 18 H106 Q112 18 112 24 V56 Q112 62 106 62 H14 Q8 62 8 56 V24 Q8 18 14 18 Z' },
  horizontal_oval: { kind: 'rect', x: 12, y: 14, w: 96, h: 52, rx: 20 },
  horizontal_ellipse: { kind: 'ellipse', x: 8, y: 16, w: 104, h: 48 },
  vertical_cylinder: { kind: 'rect', x: 34, y: 6, w: 52, h: 68, rx: 3 },
  vertical_capsule: { kind: 'rect', x: 34, y: 6, w: 52, h: 68, rx: 26 },
  vertical_oval: { kind: 'rect', x: 28, y: 6, w: 64, h: 68, rx: 18 },
  rectangle: { kind: 'rect', x: 20, y: 14, w: 80, h: 52, rx: 2 },
}

// The oil's surface is a gentle wave rather than a ruler-straight line. Empty and full tanks stay flat (nothing to wave at).
function liquidPath(top: number, f: number): string {
  if (f <= 0.001 || f >= 0.999) return `M0 ${top} H120 V80 H0 Z`
  const a = 1.8 // wave height in the 120 x 80 drawing
  return `M0 ${top} q 7.5 -${a} 15 0${' t 15 0'.repeat(7)} V80 H0 Z`
}

export function TankShapeSvg({ shape, fill = 0, className = '' }: { shape: TankShape; fill?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  const b = BODIES[shape] ?? BODIES.rectangle
  const f = Math.min(1, Math.max(0, fill))
  const liquidTop = b.y + b.h * (1 - f)
  const outline = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 }
  const clip = b.kind === 'rect' ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} />
    : b.kind === 'ellipse' ? <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} />
    : <path d={b.d} />
  const stroke = b.kind === 'rect' ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} {...outline} />
    : b.kind === 'ellipse' ? <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...outline} />
    : <path d={b.d} {...outline} />
  return (
    <svg viewBox="0 0 120 80" className={className} role="img" aria-label={shape.replace(/_/g, ' ')}>
      <defs><clipPath id={`tank-${id}`}>{clip}</clipPath></defs>
      <path d={liquidPath(liquidTop, f)} clipPath={`url(#tank-${id})`} fill="#B7E0DE" opacity={0.85} />
      {stroke}
    </svg>
  )
}
