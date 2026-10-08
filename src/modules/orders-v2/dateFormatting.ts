// User conditional formatting for the Review table's Last Ordered / Last Delivered dates (Order Settings → User Order Settings).
// Per user AND per vendor: each date column has its own rules — "within the last N days" or "more than N days ago", a color the user picks,
// and whether that color fills the cell's background or colors its text. The first matching rule wins.
import { useCallback, type CSSProperties } from 'react'
import { useProfilePref } from '@/hooks/useProfilePrefs'

export interface DateCfRule { id: string; op: 'within' | 'older'; days: number; color: string; apply: 'background' | 'text' }
export interface DateCfConfig { ordered: DateCfRule[]; delivered: DateCfRule[] }
export type DateCfByVendor = Record<string, DateCfConfig>
export const OV2_DATE_CF_KEY = 'ov2_date_cf'
export type DateCfField = keyof DateCfConfig

export const newDateCfRule = (): DateCfRule => ({ id: Math.random().toString(36).slice(2, 9), op: 'within', days: 7, color: '#E67E22', apply: 'background' })

const MS_DAY = 86400000
/** Whole days between an ISO date and today (positive = in the past). */
export function daysAgoFrom(iso: string, todayIso: string): number {
  return Math.round((new Date(`${todayIso}T00:00:00`).getTime() - new Date(`${iso.slice(0, 10)}T00:00:00`).getTime()) / MS_DAY)
}

export function matchDateRule(rules: DateCfRule[] | undefined, iso: string | null | undefined, todayIso: string): DateCfRule | null {
  if (!iso || !rules?.length) return null
  const ago = daysAgoFrom(iso, todayIso)
  if (!Number.isFinite(ago)) return null
  return rules.find((r) => (r.op === 'within' ? ago <= r.days : ago > r.days)) ?? null
}

/** Inline style for a matched rule: the chosen color fills the background (softened so the text stays readable) or colors the text. */
export function dateRuleStyle(rule: DateCfRule | null): CSSProperties | undefined {
  if (!rule) return undefined
  if (rule.apply === 'text') return { color: rule.color, fontWeight: 700 }
  const hex = /^#[0-9a-f]{6}$/i.test(rule.color) ? `${rule.color}59` : rule.color
  return { background: hex, borderRadius: 4, padding: '1px 5px', display: 'inline-block' }
}

/** The signed-in user's formatting for one vendor's Last Ordered / Last Delivered cells. */
export function useDateCf(vendorId: string | null | undefined) {
  const [all] = useProfilePref<DateCfByVendor>(OV2_DATE_CF_KEY, {})
  const cfg = vendorId ? all?.[vendorId] : undefined
  const todayIso = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
  const styleFor = useCallback((field: DateCfField, iso: string | null | undefined) => dateRuleStyle(matchDateRule(cfg?.[field], iso, todayIso)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, todayIso])
  return { styleFor, active: !!(cfg && (cfg.ordered?.length || cfg.delivered?.length)) }
}
