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

const COLORS = ['#2ECC71', '#B7E0DE', '#E67E22', '#C0392B', '#F2F1E6', '#4F7489']

export function fireConfettiCannon(x: number, y: number, count = 70) {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;'
  document.body.appendChild(container)

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
    // flightDuration is the physical flight this trajectory is computed
    // over (keeps the same arc/distances); playbackDuration is what's
    // actually handed to the animation. Halved here (2x speed, direct ask
    // 2026-09-30) by SEPARATING the two rather than just shrinking
    // flightDuration alone, which would cut the trajectory short instead
    // of playing the same full arc back faster.
    const flightDuration = 900 + Math.random() * 500
    const playbackDuration = flightDuration / 2
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
}
