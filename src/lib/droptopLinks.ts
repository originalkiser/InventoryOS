// Deep-links into Droptop's own web app (droptop-app.com) — direct ask
// 2026-10-01, tested against a real order link:
// https://droptop-app.com/dash/order_manager?sids=1065&oi=763-1065-19742
//
// Our own `order_id` string (e.g. "763-1065-19742") already carries
// Droptop's own store id as its middle segment — matches the `sids` param
// exactly, confirmed against the real link above — so no separate shop-id
// lookup (e.g. a Monday/location field) is needed to build this.
export function buildDroptopOrderManagerUrl(orderId: string): string | null {
  const parts = orderId.split('-')
  const sid = parts[1]
  if (!sid) return null
  return `https://droptop-app.com/dash/order_manager?sids=${encodeURIComponent(sid)}&oi=${encodeURIComponent(orderId)}`
}

// Droptop forces a fresh login (landing on the dashboard, not the deep
// link) whenever droptop-app.com is opened in a brand-new tab — so a plain
// `window.open(url, '_blank')` per order would just bounce through a login
// screen and lose the link every time. Opening with a fixed window NAME
// instead reuses the SAME tab across every call from this app: the browser
// navigates that already-open tab to the new URL rather than opening a
// second one, which keeps it on its already-authenticated session. This
// only works for a tab this app itself opened (or has since reused) under
// this name — a tab the user opened manually by typing the URL in has no
// name set, and no browser API exists to discover or target an arbitrary
// already-open tab across origins, so that case still opens a new tab once.
// After that first time, every subsequent click correctly reuses it.
const DROPTOP_TAB_NAME = 'sb_droptop_tab'
export function openDroptopTab(url: string): void {
  window.open(url, DROPTOP_TAB_NAME)
}
