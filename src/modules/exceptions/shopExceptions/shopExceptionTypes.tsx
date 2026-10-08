// The five automatic shop exceptions: their order of priority, wording, colors and icons (the Exception Icon Set). One open exception per shop
// per type — see inventory.shop_exceptions (migration 20261009a) and run-automated-checks/detect.ts for how they're found and combined.
import type { CSSProperties } from 'react'

export type ShopExceptionType = 'po_late' | 'zero_sales' | 'adj_positive' | 'adj_negative' | 'duplicate_case'
export type ExceptionStatus = 'pending' | 'skipped' | 'excused' | 'logged' | 'resolved'

export interface ShopException {
  id: string
  location_id: string
  type: ShopExceptionType
  severity: 1 | 2 | 3
  status: ExceptionStatus
  first_seen: string
  last_seen: string
  items: ExceptionItem[]
  acked_keys: string[]
  status_changed_at: string | null
  logged_message: string | null
}
export interface ExceptionItem { key: string; [field: string]: any }

export const SEV_LABEL: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High' }
export const STATUS_LABEL: Record<ExceptionStatus, string> = { pending: 'Pending', skipped: 'Skipped', excused: 'Excused', logged: 'Logged', resolved: 'Resolved' }

/** Highest priority first — what the triage views and the Location Lookup card sort by (then severity). */
export const TYPE_ORDER: ShopExceptionType[] = ['zero_sales', 'adj_negative', 'po_late', 'adj_positive', 'duplicate_case']

interface TypeMeta {
  label: string
  short: string
  blurb: string
  /** Stacks day over day on one item per product (shown with a day-stack bar). */
  stacks?: boolean
  cssVar: string
  /** SVG path markup (24x24 viewBox): the fuller drawing for tiles / large, and the bolder one for the 22px badge. */
  big: string
  small: string
}

export const TYPE_META: Record<ShopExceptionType, TypeMeta> = {
  po_late: {
    label: 'PO should have delivered', short: 'PO late', cssVar: '--exc-po',
    blurb: 'An open purchase order is past its expected delivery with nothing received. POs for the same shop are added to one card.',
    big: '<path d="M2 9h9v7.5H2zM11 11.5h3.5l2.5 2.5v2.5h-6"/><circle cx="5.2" cy="18.2" r="1.5"/><circle cx="14" cy="18.2" r="1.5"/><circle cx="18.5" cy="6" r="3.8"/><path d="M18.5 4.1V6l1.4 1.1"/>',
    small: '<path d="M2 11.5h9V17H2zM11 13.5h3.8l2.2 2.2V17H11"/><circle cx="5.3" cy="19.4" r="1.4" fill="currentColor"/><circle cx="14" cy="19.4" r="1.4" fill="currentColor"/><circle cx="17" cy="7" r="5"/><path d="M17 4.4V7l2.2 1.3"/>',
  },
  zero_sales: {
    label: 'Selling at zero on hand', short: 'Zero on hand', stacks: true, cssVar: '--exc-zero',
    blurb: 'A product keeps selling while the system shows nothing on hand. Days and quantity stack on one item until it is corrected.',
    big: '<path d="M2.5 4.5v7l10 10 9-9-10-10h-7z"/><ellipse cx="12" cy="12" rx="2.2" ry="3.3"/>',
    small: '<path d="M2.5 4.5v7l10 10 9-9-10-10h-7z"/><ellipse cx="12" cy="12" rx="2.7" ry="3.9"/>',
  },
  adj_positive: {
    label: 'Large positive adjustment', short: 'Large + adjustment', cssVar: '--exc-pos',
    blurb: 'Stock was adjusted up by a large amount. Each product is added to the one card for the shop.',
    big: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V8M8.5 11.5L12 8l3.5 3.5"/>',
    small: '<path d="M12 20V5M5.5 11.5L12 5l6.5 6.5"/>',
  },
  adj_negative: {
    label: 'Large negative adjustment', short: 'Large − adjustment', cssVar: '--exc-neg',
    blurb: 'Stock was adjusted down by a large amount. Each product is added to the one card for the shop.',
    big: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V16M8.5 12.5L12 16l3.5-3.5"/>',
    small: '<path d="M12 4v15M5.5 12.5L12 19l6.5-6.5"/>',
  },
  duplicate_case: {
    label: 'Duplicate case types on hand', short: 'Duplicate case types', cssVar: '--exc-dup',
    blurb: 'The same product is on hand under more than one case type. High when the quantities are within 40 qts of each other (likely the same stock counted twice), low when further apart.',
    big: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-2a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2"/>',
    small: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0014.5 4h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8"/>',
  },
}

export const typeColor = (t: ShopExceptionType): CSSProperties => ({ ['--c' as string]: `var(${TYPE_META[t].cssVar})` })

function Svg({ inner, sw, size }: { inner: string; sw: number; size: number | string }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: inner }} />
}

/** Round badge — the small drawing, used on shop pills and in the location dropdown. */
export function ExceptionBadge({ type, size = 22, title }: { type: ShopExceptionType; size?: number; title?: string }) {
  return (
    <span title={title ?? TYPE_META[type].label} className="inline-grid place-items-center rounded-full flex-none"
      style={{ ...typeColor(type), width: size, height: size, color: 'var(--c)', background: 'color-mix(in srgb, var(--c) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--c) 40%, transparent)' }}>
      <span style={{ display: 'block', width: Math.round(size * 0.64), height: Math.round(size * 0.64) }}><Svg inner={TYPE_META[type].small} sw={2.4} size="100%" /></span>
    </span>
  )
}

/** Rounded-square tile — the fuller drawing, used on cards and rows. */
export function ExceptionTile({ type, size = 30 }: { type: ShopExceptionType; size?: number }) {
  return (
    <span className="inline-grid place-items-center rounded-lg flex-none"
      style={{ ...typeColor(type), width: size, height: size, color: 'var(--c)', background: 'color-mix(in srgb, var(--c) 14%, transparent)' }}>
      <span style={{ display: 'block', width: Math.round(size * 0.6), height: Math.round(size * 0.6) }}><Svg inner={TYPE_META[type].big} sw={1.9} size="100%" /></span>
    </span>
  )
}

/** A short row of badges for the pending exceptions of a shop, highest priority first. */
export function ExceptionBadges({ list, max = 5, size = 22 }: { list: ShopException[]; max?: number; size?: number }) {
  const types = TYPE_ORDER.filter((t) => list.some((e) => e.type === t))
  if (!types.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      {types.slice(0, max).map((t) => <ExceptionBadge key={t} type={t} size={size} />)}
      {types.length > max && <span className="text-[10px] font-mono text-inky">+{types.length - max}</span>}
    </span>
  )
}

/** Highest priority first: severity, then the type order. */
export const sortExceptions = (a: ShopException, b: ShopException) => b.severity - a.severity || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
