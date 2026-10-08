// Wording for the shop exceptions: one line per item, a one-line summary for tables, and the email a person copies when they log one.
import { TYPE_META, type ExceptionItem, type ShopException } from './shopExceptionTypes'

const fmtN = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 })
const sgn = (n: number) => `${n > 0 ? '+' : ''}${fmtN(n)}`
const dShort = (iso: string | null | undefined) => {
  if (!iso) return '—'
  try { return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return iso }
}
export { dShort as exceptionDate }

/** One line describing a single item (a product, a PO, ...). */
export function itemLine(type: ShopException['type'], it: ExceptionItem): string {
  switch (type) {
    case 'zero_sales': return `${it.product_id} · ${it.days} day${it.days === 1 ? '' : 's'}, ${fmtN(it.qty)} qt sold at 0 (since ${dShort(it.first)})`
    case 'adj_positive':
    case 'adj_negative': return `${it.product_id} · ${dShort(it.date)} · ${sgn(it.qty)} qt`
    case 'po_late': return `${it.po} · ${it.supplier ?? 'PO'} · expected ${dShort(it.expected)} · ${it.days_late} day${it.days_late === 1 ? '' : 's'} late`
    case 'duplicate_case': return `${it.family}: ${(it.members as { product_id: string; on_hand: number }[]).map((m) => `${m.product_id} ${fmtN(m.on_hand)}`).join(' + ')} (${fmtN(it.diff)} qt apart)`
  }
}

/** A short summary for tables and tooltips. */
export function exceptionSummary(e: ShopException): string {
  const n = e.items.length
  switch (e.type) {
    case 'zero_sales': {
      const qty = e.items.reduce((s, i) => s + Number(i.qty ?? 0), 0), days = Math.max(0, ...e.items.map((i) => Number(i.days ?? 0)))
      return `${n} product${n === 1 ? '' : 's'} sold at 0 · ${fmtN(qty)} qt · up to ${days} day${days === 1 ? '' : 's'}`
    }
    case 'adj_positive':
    case 'adj_negative': return `${n} adjustment${n === 1 ? '' : 's'} · ${sgn(e.items.reduce((s, i) => s + Number(i.qty ?? 0), 0))} qt`
    case 'po_late': return `${n} PO${n === 1 ? '' : 's'} · oldest ${Math.max(0, ...e.items.map((i) => Number(i.days_late ?? 0)))} days late`
    case 'duplicate_case': {
      const close = e.items.filter((i) => i.severity === 3).length
      return `${n} product famil${n === 1 ? 'y' : 'ies'}${close ? ` · ${close} within 40 qts` : ''}`
    }
  }
}

const ASK: Record<ShopException['type'], string> = {
  zero_sales: 'These products are selling while the system shows nothing on hand. Please confirm whether any of them was received but not receipted, and run a physical count on each today so the system on hand matches the shelf.',
  adj_positive: 'These products were adjusted UP by a large amount. Please tell me what the adjustments were for (a missed receipt, a recount, a transfer in) so we can confirm they are right.',
  adj_negative: 'These products were adjusted DOWN by a large amount. Please tell me what the adjustments were for (waste, a spill, a transfer out, a miscount) so we can confirm they are right.',
  po_late: 'These purchase orders should have been delivered by now with nothing received. Please check whether the deliveries arrived and were not receipted, or let me know so we can follow up with the supplier.',
  duplicate_case: 'These products are on hand under more than one case type. Please check whether the same stock is being counted under both, and correct whichever one is wrong.',
}

export function emailFor(e: ShopException, shop: { num: string; name: string }): { to: string; subject: string; body: string } {
  const meta = TYPE_META[e.type]
  const lines = e.items.map((i) => `  - ${itemLine(e.type, i)}`).join('\n')
  return {
    to: `Store ${shop.num} manager`,
    subject: `Inventory exception: ${meta.label} - Store ${shop.num} ${shop.name}`,
    body: `Hi team,\n\nOur daily inventory review flagged the following at Store ${shop.num} (${shop.name}):\n\n${meta.label}\n${lines}\n\n${ASK[e.type]}\n\nPlease reply once this is resolved, or let me know if there is context I am missing.\n\nThanks`,
  }
}
