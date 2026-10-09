// Shared geometry for the nav layouts' page-card panels (mega menu drop-down, horizontal floating dock): cards are all one size (like the
// Droptop options), at most three per row, and the panel is centered under the button that opened it unless a screen edge is in the way.
export const CARD_W = 236
export const CARD_GAP = 8
export const PANEL_PAD = 12
export const MAX_COLS = 3

export const clampNum = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Columns for n cards: as many as there are cards, up to three. */
export const panelCols = (n: number) => Math.min(MAX_COLS, Math.max(1, n))

/** Outer width of a panel holding n cards. */
export const panelWidth = (n: number) => { const c = panelCols(n); return c * CARD_W + (c - 1) * CARD_GAP + PANEL_PAD * 2 }

/** Left edge for a panel of width w centered on cx, pushed back inside the viewport (with a small margin) when it would overflow. */
export function centeredLeft(cx: number, w: number, viewport: number, margin = 8): number {
  return clampNum(cx - w / 2, margin, Math.max(margin, viewport - w - margin))
}
