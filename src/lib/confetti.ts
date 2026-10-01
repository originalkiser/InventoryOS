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
// surface), rest there for a while, then fade out slowly.
//
// Same-day follow-up #1: once a particle is resting, the cursor can
// "collide" with it — mousemove knocks it away with a real gravity-
// affected hop (not a flat sideways teleport), so it arcs up/out and falls
// back down onto a floor again, the same physics as the initial launch.
//
// Same-day follow-up #2: a "Confetti Simple" company-wide setting
// (confetti_simple) opts back into the ORIGINAL plain arc-and-fade with no
// floor collision, no rest, no cursor interaction — some people just want
// the simple version. See `simple` in fireConfettiCannon's options.
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
const PUSH_COOLDOWN_MS = 500 // can't be re-triggered again until its own push-hop animation has had time to finish

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

interface FlightResult {
  keyframes: Keyframe[] // offsets are still raw SECONDS at this point, not 0..1 fractions
  finalPx: number
  finalPy: number
  finalRotation: number
  totalSimSeconds: number
  settledOnFloor: boolean // false only if it ran out of MAX_SIM_STEPS mid-air/mid-slide — practically never
}

// Shared by the initial cannon launch AND a cursor-push reaction — both are
// "a particle starts somewhere with some velocity, gravity pulls it down,
// it bounces/slides to a stop on a floor." Works in coordinates RELATIVE to
// (startX, startY) so the caller can re-anchor it anywhere (the original
// click point, or wherever a resting particle currently sits).
function simulateFlight(
  startX: number, startY: number, vx0: number, vy0: number, spinRate: number, floors: Floor[],
): FlightResult {
  let vx = vx0
  let vy = vy0
  let px = 0
  let py = 0
  let rotation = 0
  let resting = false
  let simSeconds = 0

  const keyframes: Keyframe[] = [{ offset: 0, transform: 'translate(0px, 0px) rotate(0deg)', opacity: 1 }]
  const pushFrame = (atSeconds: number) => keyframes.push({
    offset: atSeconds,
    transform: `translate(${px}px, ${py}px) rotate(${rotation}deg)`,
    opacity: 1,
  })

  let steps = 0
  while (!resting && steps < MAX_SIM_STEPS) {
    steps++
    const prevPy = py
    vy += GRAVITY * SIM_DT
    px += vx * SIM_DT
    py += vy * SIM_DT
    rotation += spinRate * SIM_DT
    simSeconds += SIM_DT

    const gx = startX + px
    const gyPrev = startY + prevPy
    const gy = startY + py
    const floor = floors.find((f) => gx >= f.left && gx <= f.right && gyPrev < f.top && gy >= f.top)
    if (floor) {
      py = floor.top - startY
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
  const settledOnFloor = resting
  while (resting && Math.abs(vx) > MIN_SLIDE_VELOCITY && steps < MAX_SIM_STEPS) {
    steps++
    vx *= SLIDE_FRICTION
    px += vx * SIM_DT
    rotation += spinRate * 0.15 * SIM_DT
    simSeconds += SIM_DT
    pushFrame(simSeconds)
  }

  return { keyframes, finalPx: px, finalPy: py, finalRotation: rotation, totalSimSeconds: simSeconds, settledOnFloor }
}

// ── Shared mouse-collision registry for every resting particle from every
// burst — one listener total, not one per burst, added lazily on the first
// particle that ever settles and removed once none remain. ─────────────────
interface RestingParticle {
  el: HTMLDivElement
  size: number
  left: number
  top: number
  spinRate: number
  rotation: number
  pushedUntil: number
}
const restingParticles = new Set<RestingParticle>()
let mouseListenerAttached = false

// A cursor hit replays the SAME simulateFlight physics used for the
// original launch — gravity stays on, so a knocked particle arcs away and
// falls back down onto a floor again instead of flatly teleporting
// sideways and sitting there (direct ask 2026-09-30). Anchored at the
// particle's CURRENT resting position, with a modest outward+upward
// velocity scaled by how close the cursor got.
function pushParticle(p: RestingParticle, cursorX: number, cursorY: number) {
  const dx = (p.left + p.size / 2) - cursorX
  const dy = (p.top + p.size / 2) - cursorY
  const dist = Math.max(1, Math.hypot(dx, dy))
  const nx = dx / dist
  const ny = dy / dist
  const strength = 180 + Math.random() * 120
  const vx0 = nx * strength
  // A bit of upward kick regardless of the raw push direction — reads as
  // "knocked into the air" rather than "shoved along the floor" — gravity
  // then brings it back down for real, same as the initial launch.
  const vy0 = ny * strength - 140

  const floors = getFloors()
  const result = simulateFlight(p.left, p.top, vx0, vy0, p.spinRate, floors)
  const totalSeconds = Math.max(0.05, result.totalSimSeconds)
  for (const k of result.keyframes) {
    const raw = k.offset ?? 0
    k.offset = Math.min(1, raw / totalSeconds)
  }

  p.pushedUntil = performance.now() + totalSeconds * 1000 + 50
  const anim = p.el.animate(result.keyframes, { duration: totalSeconds * 1000, easing: 'linear', fill: 'forwards' })
  anim.finished.then(() => {
    anim.cancel()
    const newLeft = p.left + result.finalPx
    const newTop = p.top + result.finalPy
    p.el.style.transform = 'none'
    p.el.style.left = `${newLeft}px`
    p.el.style.top = `${newTop}px`
    p.left = newLeft
    p.top = newTop
    p.rotation += result.finalRotation
  }).catch(() => {})
}

function onMouseMoveForConfetti(e: MouseEvent) {
  const now = performance.now()
  for (const p of restingParticles) {
    if (now < p.pushedUntil) continue
    const cx = p.left + p.size / 2
    const cy = p.top + p.size / 2
    if (Math.hypot(cx - e.clientX, cy - e.clientY) > CURSOR_COLLIDE_RADIUS) continue
    pushParticle(p, e.clientX, e.clientY)
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

export function fireConfettiCannon(x: number, y: number, opts: { count?: number; simple?: boolean } = {}) {
  const count = opts.count ?? 70
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;'
  document.body.appendChild(container)

  // Confetti Simple (direct ask 2026-09-30): the original plain arc-and-
  // fade, no floor collision/rest/cursor interaction at all — a fixed,
  // closed-form trajectory for every particle, same shape this file had
  // before the collision physics was added.
  if (opts.simple) {
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
      const dx = Math.cos(angle) * velocity
      const dy = Math.sin(angle) * velocity
      const gravity = 650
      const flightDuration = 900 + Math.random() * 500
      const playbackDuration = (flightDuration / 2) * 1.1
      const spin = (Math.random() - 0.5) * 720

      const steps = 14
      const keyframes: Keyframe[] = []
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const time = t * (flightDuration / 1000)
        const px = dx * time
        const py = dy * time + 0.5 * gravity * time * time
        keyframes.push({
          transform: `translate(${px}px, ${py}px) rotate(${spin * t}deg)`,
          opacity: t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1,
        })
      }
      el.animate(keyframes, { duration: playbackDuration, easing: 'linear', fill: 'forwards' })
    }
    setTimeout(() => container.remove(), 2000)
    return
  }

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
    const vx0 = Math.cos(angle) * velocity
    const vy0 = Math.sin(angle) * velocity
    const spinRate = (Math.random() - 0.5) * 480 // deg/s while airborne/sliding

    const result = simulateFlight(x, y, vx0, vy0, spinRate, floors)
    const flightSeconds = result.totalSimSeconds * TIME_SCALE
    const keyframes = result.keyframes
    for (const k of keyframes) {
      const raw = k.offset ?? 0
      k.offset = Math.min(1, (raw * TIME_SCALE) / flightSeconds || 0)
    }

    const finalLeft = x + result.finalPx
    const finalTop = y + result.finalPy
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

      const particle: RestingParticle = {
        el, size, left: finalLeft, top: finalTop,
        spinRate, rotation: result.finalRotation, pushedUntil: 0,
      }
      addRestingParticle(particle)

      setTimeout(() => {
        removeRestingParticle(particle)
        el.style.transition = `opacity ${FADE_SECONDS}s linear`
        el.style.opacity = '0'
        setTimeout(() => el.remove(), FADE_SECONDS * 1000)
      }, REST_HOLD_SECONDS * 1000)
    }).catch(() => { el.remove() }) // animation was cancelled (e.g. page nav mid-flight) — just clean up

  }

  setTimeout(() => container.remove(), (MAX_SIM_STEPS * SIM_DT * TIME_SCALE + REST_HOLD_SECONDS + FADE_SECONDS + 5) * 1000)
}
