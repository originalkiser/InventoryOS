// Dependency-free confetti burst (no canvas-confetti or similar package —
// see CLAUDE.md's "no new dependencies without approval" rule) for Orders
// v2's Export button, gated behind the company-wide "confetti_on_export"
// app setting (see ProfilePanel.tsx's Dev Settings section, developer-role
// only). Plain DOM particles animated via the Web Animations API, each
// self-removing once its own animation finishes.
//
// "Like a confetti cannon went off from the tip of the cursor" — a biased
// upward/outward angle spread (roughly +-70deg from straight up) rather
// than a full 360deg radial burst, with real gravity acceleration pulling
// each particle back down over its flight.
//
// Direct ask 2026-09-30: real collision instead of a plain arc-and-fade —
// particles bounce off whatever real page elements are marked
// `data-confetti-floor` (OrderStepper's own root, the Export preview
// table's header row), settle and slide to a stop on whichever one they
// land on (or the bottom of the viewport if they miss every marked
// surface), rest there for a while, then fade out slowly. The physics is a
// small manual step simulation (not a closed-form arc like before) since a
// bounce is a branch, not a formula — built once per particle into a
// single `el.animate()` keyframe list with real per-segment `offset`s so
// one call still covers flight + bounce + rest + fade.

const COLORS = ['#2ECC71', '#B7E0DE', '#E67E22', '#C0392B', '#F2F1E6', '#4F7489']

// Physics tuning — px/s(^2) and unitless ratios, found by eye against a
// real click in the browser rather than derived from anything physical.
const GRAVITY = 650
const RESTITUTION = 0.38 // vertical velocity kept per bounce
const BOUNCE_FRICTION = 0.7 // horizontal velocity kept per bounce (on top of restitution's own loss)
const SLIDE_FRICTION = 0.92 // horizontal velocity decay per sim step once resting
const REST_VELOCITY = 40 // px/s — below this on impact, it's a landing, not a bounce
const MIN_SLIDE_VELOCITY = 4 // px/s — below this while resting, treat as fully stopped
const SIM_DT = 0.02 // seconds per physics step
const MAX_SIM_STEPS = 300 // ~6s of simulated flight/bounce/slide — safety cap, real ones settle much sooner
// Stretches how long the flight/bounce/slide portion takes to PLAY (not
// the shape of the arc/bounces themselves) — direct ask 2026-09-30, "10%
// slower", applied the same way the prior 2x-speed change did: scale the
// TIME AXIS used to place keyframes, not the underlying simulation.
const TIME_SCALE = 1.1
const REST_HOLD_SECONDS = 15 // direct ask: rest in place this long once landed
const FADE_SECONDS = 2 // then fade out over this long

interface Floor { top: number; left: number; right: number }

function getFloors(): Floor[] {
  const floors: Floor[] = []
  document.querySelectorAll('[data-confetti-floor]').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) floors.push({ top: r.top, left: r.left, right: r.right })
  })
  // Bottom of the viewport is always the last-resort floor, so a particle
  // that misses every marked surface still lands and rests somewhere
  // instead of free-falling past MAX_SIM_STEPS with no clean resting point.
  floors.push({ top: window.innerHeight - 2, left: -Infinity, right: Infinity })
  return floors.sort((a, b) => a.top - b.top)
}

export function fireConfettiCannon(x: number, y: number, count = 70) {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;'
  document.body.appendChild(container)

  const floors = getFloors()

  for (let i = 0; i < count; i++) {
    const size = 5 + Math.random() * 6
    const isCircle = Math.random() < 0.3
    const el = document.createElement('div')
    el.style.cssText = [
      'position:absolute',
      `left:${x}px`, `top:${y}px`,
      `width:${size}px`, `height:${size * (isCircle ? 1 : 0.6)}px`,
      `background:${COLORS[Math.floor(Math.random() * COLORS.length)]}`,
      `border-radius:${isCircle ? '50%' : '2px'}`,
      'will-change:transform,opacity',
    ].join(';')
    container.appendChild(el)

    const angle = (-90 + (Math.random() * 140 - 70)) * (Math.PI / 180)
    const velocity = 260 + Math.random() * 360
    let vx = Math.cos(angle) * velocity
    let vy = Math.sin(angle) * velocity
    const spinRate = (Math.random() - 0.5) * 480 // deg/s while airborne/sliding

    let px = 0 // position relative to launch point (== relative to left/top above)
    let py = 0
    let rotation = 0
    let resting = false
    let simSeconds = 0

    const keyframes: Keyframe[] = [{ offset: 0, transform: 'translate(0px, 0px) rotate(0deg)', opacity: 1 }]
    const pushFrame = (atSeconds: number) => keyframes.push({
      offset: atSeconds, // raw elapsed seconds for now — see the conversion pass below
      transform: `translate(${px}px, ${py}px) rotate(${rotation}deg)`,
      opacity: 1,
    })
    // Raw elapsed-seconds are stashed in `offset` above and converted to
    // real 0..1 fractions in one pass at the end, once the true total
    // duration (flight + rest + fade) is known — keyframe offsets can't be
    // computed correctly mid-simulation since later phases' lengths aren't
    // known yet.

    let steps = 0
    while (!resting && steps < MAX_SIM_STEPS) {
      steps++
      const prevPy = py
      vy += GRAVITY * SIM_DT
      px += vx * SIM_DT
      py += vy * SIM_DT
      rotation += spinRate * SIM_DT
      simSeconds += SIM_DT

      const gx = x + px
      const gyPrev = y + prevPy
      const gy = y + py
      const floor = floors.find((f) => gx >= f.left && gx <= f.right && gyPrev < f.top && gy >= f.top)
      if (floor) {
        py = floor.top - y // snap to the surface
        if (Math.abs(vy) < REST_VELOCITY) {
          vy = 0
          resting = true
        } else {
          vy = -vy * RESTITUTION
          vx *= BOUNCE_FRICTION
        }
      }
      pushFrame(simSeconds)
    }
    // Still sliding (resting on a floor, vy pinned to 0, vx decaying via
    // friction) until it genuinely stops — "rest on top of the columns
    // border and maybe slide off depending on how long the animation goes
    // for": this is exactly that tail end.
    while (resting && Math.abs(vx) > MIN_SLIDE_VELOCITY && steps < MAX_SIM_STEPS) {
      steps++
      vx *= SLIDE_FRICTION
      px += vx * SIM_DT
      rotation += spinRate * 0.15 * SIM_DT // a light tumble while sliding, not a full spin
      simSeconds += SIM_DT
      pushFrame(simSeconds)
    }

    const flightSeconds = simSeconds * TIME_SCALE
    const restStartSeconds = flightSeconds
    const restEndSeconds = restStartSeconds + REST_HOLD_SECONDS
    const fadeEndSeconds = restEndSeconds + FADE_SECONDS
    const totalSeconds = fadeEndSeconds

    // Convert every flight/bounce/slide keyframe's stashed elapsed-seconds
    // (in `offset`) into a real fraction of the total duration, scaled by
    // TIME_SCALE so the whole throw plays 10% slower without changing its
    // shape.
    for (const k of keyframes) {
      const raw = k.offset ?? 0
      k.offset = Math.min(1, (raw * TIME_SCALE) / totalSeconds)
    }
    // Hold position through the rest window, then fade out in place.
    const lastTransform = keyframes[keyframes.length - 1].transform
    keyframes.push({ offset: restEndSeconds / totalSeconds, transform: lastTransform, opacity: 1 })
    keyframes.push({ offset: 1, transform: lastTransform, opacity: 0 })

    el.animate(keyframes, { duration: totalSeconds * 1000, easing: 'linear', fill: 'forwards' })
  }

  setTimeout(() => container.remove(), (REST_HOLD_SECONDS + FADE_SECONDS + 6) * 1000)
}
