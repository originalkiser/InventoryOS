// Dependency-free confetti burst (no canvas-confetti or similar package —
// see CLAUDE.md's "no new dependencies without approval" rule) for Orders
// v2's Export button, gated behind the company-wide "confetti_on_export"
// app setting (see ProfilePanel.tsx's Dev Settings section, developer-role
// only). Plain DOM particles, each self-removing once its own lifecycle
// finishes.
//
// "Like a confetti cannon went off from the tip of the cursor" — a biased
// upward/outward angle spread (roughly +-70deg from straight up) rather
// than a full 360deg radial burst, with real gravity acceleration pulling
// each particle back down over its flight.
//
// Direct ask 2026-09-30: real collision instead of a plain arc-and-fade —
// particles bounce off whatever real page elements are marked
// `data-confetti-floor`, settle and slide to a stop on whichever one they
// land on (or the bottom of the viewport if they miss every marked
// surface), rest there for a while, then fade out slowly. The physics is a
// small manual step simulation (not a closed-form arc) since a bounce is a
// branch, not a formula.
//
// Follow-up same day: once a particle is resting, the cursor can "collide"
// with it — mousemove pushes any resting particle it passes near a short
// hop away, settling again nearby. This is why the flight and rest phases
// are two SEPARATE mechanisms rather than one long precomputed
// `el.animate()` keyframe list (the original shape, before this follow-up):
// the flight/bounce/slide portion still plays as one WAAPI animation
// (nothing needs to react mid-flight), but a WAAPI animation's keyframes
// are fixed at creation time and can't branch on a live mouse position —
// once a particle settles, control hands off to plain `style.left/top` +
// a shared mousemove listener, which CAN react per-event.

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

// Mouse-collision tuning for the resting phase.
const CURSOR_COLLIDE_RADIUS = 34 // px — cursor within this of a resting particle's center counts as a hit
const PUSH_DISTANCE = 55 // px — how far a hit knocks the particle away
const PUSH_COOLDOWN_MS = 220 // matches the CSS transition below, so a particle can't be re-pushed mid-hop

interface Floor { top: number; left: number; right: number }

// Found live 2026-09-30: confetti was landing on an invisible surface near
// the top of the screen — this app's KeepAlivePages keeps up to 3 recently-
// visited pages mounted in the background (display:none while inactive),
// but during its own slide-transition animation a previous page can
// briefly still be display:block while animating out, which — for the
// small window that's true — makes ITS OWN OrderStepper (also marked
// data-confetti-floor) a second, real, non-zero-size element matching the
// same selector, positioned wherever that other page's own sticky header
// happened to sit. `checkVisibility()` (baseline-supported in every
// browser this app targets) is the correct, built-in check for "is this
// actually on screen right now" — it accounts for display:none,
// visibility:hidden, and hidden ancestors, which a plain non-zero-size
// getBoundingClientRect() check does not.
function isGenuinelyVisible(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: () => boolean }
  return anyEl.checkVisibility ? anyEl.checkVisibility() : true
}

function getFloors(): Floor[] {
  const floors: Floor[] = []
  document.querySelectorAll('[data-confetti-floor]').forEach((el) => {
    if (!isGenuinelyVisible(el)) return
    const r = el.getBoundingClientRect()
    // Also require the surface to actually be within the visible viewport
    // right now (not scrolled away above/below it) — a second, independent
    // guard against bouncing off something the user can't see.
    if (r.width > 0 && r.height > 0 && r.bottom >= 0 && r.top <= window.innerHeight) {
      floors.push({ top: r.top, left: r.left, right: r.right })
    }
  })
  // Bottom of the viewport is always the last-resort floor, so a particle
  // that misses every marked surface still lands and rests somewhere
  // instead of free-falling past MAX_SIM_STEPS with no clean resting point.
  floors.push({ top: window.innerHeight - 2, left: -Infinity, right: Infinity })
  return floors.sort((a, b) => a.top - b.top)
}

// ── Shared mouse-collision registry for every resting particle from every
// burst — one listener total, not one per burst, added lazily on the first
// particle that ever settles and removed once none remain. ─────────────────
interface RestingParticle {
  el: HTMLDivElement
  size: number
  left: number
  top: number
  pushedUntil: number
}
const restingParticles = new Set<RestingParticle>()
let mouseListenerAttached = false

function onMouseMoveForConfetti(e: MouseEvent) {
  const now = performance.now()
  for (const p of restingParticles) {
    if (now < p.pushedUntil) continue
    const cx = p.left + p.size / 2
    const cy = p.top + p.size / 2
    const dx = cx - e.clientX
    const dy = cy - e.clientY
    const dist = Math.hypot(dx, dy)
    if (dist === 0 || dist > CURSOR_COLLIDE_RADIUS) continue
    // Push directly away from the cursor along the (dx,dy) vector, clamped
    // to stay on screen so a hit near an edge doesn't fling it offscreen.
    const nx = dx / dist
    const ny = dy / dist
    const newLeft = Math.min(Math.max(0, p.left + nx * PUSH_DISTANCE), window.innerWidth - p.size)
    const newTop = Math.min(Math.max(0, p.top + ny * PUSH_DISTANCE), window.innerHeight - p.size)
    p.left = newLeft
    p.top = newTop
    p.pushedUntil = now + PUSH_COOLDOWN_MS
    p.el.style.left = `${newLeft}px`
    p.el.style.top = `${newTop}px`
  }
}

function addRestingParticle(p: RestingParticle) {
  restingParticles.add(p)
  if (!mouseListenerAttached) {
    window.addEventListener('mousemove', onMouseMoveForConfetti)
    mouseListenerAttached = true
  }
}

function removeRestingParticle(p: RestingParticle) {
  restingParticles.delete(p)
  if (restingParticles.size === 0 && mouseListenerAttached) {
    window.removeEventListener('mousemove', onMouseMoveForConfetti)
    mouseListenerAttached = false
  }
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
    // real 0..1 fractions in one pass below, once the true flight duration
    // is known.

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
    for (const k of keyframes) {
      const raw = k.offset ?? 0
      k.offset = Math.min(1, (raw * TIME_SCALE) / flightSeconds || 0)
    }

    const finalLeft = x + px
    const finalTop = y + py
    const anim = el.animate(keyframes, { duration: flightSeconds * 1000, easing: 'linear', fill: 'forwards' })

    anim.finished.then(() => {
      // Hand off from the WAAPI flight animation to plain left/top styling
      // for the interactive resting phase — a CSS transition (triggered by
      // the mousemove handler changing left/top directly) reacts to a live
      // cursor position; a fixed WAAPI keyframe list can't. cancel() first:
      // a fill:'forwards' animation keeps its own computed end-state style
      // in effect (winning over a plain inline style for the same
      // property) until the Animation itself is released.
      anim.cancel()
      el.style.transform = 'none'
      el.style.left = `${finalLeft}px`
      el.style.top = `${finalTop}px`
      el.style.transition = `left ${PUSH_COOLDOWN_MS}ms ease-out, top ${PUSH_COOLDOWN_MS}ms ease-out`

      const particle: RestingParticle = { el, size, left: finalLeft, top: finalTop, pushedUntil: 0 }
      addRestingParticle(particle)

      setTimeout(() => {
        removeRestingParticle(particle)
        el.style.transition = `opacity ${FADE_SECONDS}s linear`
        el.style.opacity = '0'
        setTimeout(() => el.remove(), FADE_SECONDS * 1000)
      }, REST_HOLD_SECONDS * 1000)
    }).catch(() => { el.remove() }) // animation was cancelled (e.g. page nav mid-flight) — just clean up

  }

  setTimeout(() => container.remove(), (MAX_SIM_STEPS * SIM_DT * TIME_SCALE + REST_HOLD_SECONDS + FADE_SECONDS + 3) * 1000)
}
