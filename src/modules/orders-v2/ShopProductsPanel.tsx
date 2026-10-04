// "Every product configured for this shop" — shown in the shop popup and in the inline shop expand — as the very same
// table the Review step uses (same columns, flags, conditional formatting, filters and quantity controls), instead of
// the older, separate shop-products table. A configured product with no draft line yet is a qty-0 candidate row;
// typing a quantity on it adds a real line (the caller's patchQty handles both, see OrdersV2Review's patchQtyOrAdd).
import { OrdersV2ReviewTable } from './OrdersV2ReviewTable'
import { useLineTagMap } from './useLineTagMap'
import { candidateLine } from './candidateLine'
import type { DraftLineRow } from './useOrdersV2'
import type { GenerationInput } from './types'

type TableProps = React.ComponentProps<typeof OrdersV2ReviewTable>
type BaseProps = Omit<TableProps, 'lines' | 'tagMap' | 'variant' | 'expanded' | 'onToggleExpand' | 'toolbarExtra'
  | 'onRowRef' | 'onLastRowKey' | 'isSeen' | 'jumpNonce' | 'quickFilters' | 'onQuickFiltersChange' | 'renderShopProducts'>

const NO_EXPANDED = new Set<string>()
const noop = () => {}

export function ShopProductsPanel({ locId, base, showConfigVmi, toolbarExtra }: {
  locId: string
  base: BaseProps
  showConfigVmi: boolean
  toolbarExtra?: React.ReactNode
}) {
  const { draft, shopRows, deliveryFor, thresholds, onHandAfterAtDelivery, groupMinimumStatus } = base
  const rows: { input?: GenerationInput; line?: DraftLineRow }[] = shopRows(locId)
  // Recomputed every render (a shop has ~20 products): line objects are replaced on every edit, so memoizing on them gains nothing.
  const lines: DraftLineRow[] = []
  for (const r of rows) {
    if (!showConfigVmi && (r.input?.rule.vmi_keepfill_enabled || r.line?.flags?.includes('vmi_keepfill'))) continue
    if (r.line) lines.push(r.line)
    else if (r.input) lines.push(candidateLine(r.input, draft.id, draft.order_date, deliveryFor(locId, draft.order_date)))
  }
  const tagMap = useLineTagMap(lines, thresholds, onHandAfterAtDelivery, groupMinimumStatus)
  if (lines.length === 0) return <p className="text-xs font-mono text-navy/75 py-4">No products to show for this shop.</p>
  return (
    <OrdersV2ReviewTable
      {...base}
      variant="shop"
      lines={lines}
      tagMap={tagMap}
      expanded={NO_EXPANDED}
      onToggleExpand={noop}
      toolbarExtra={toolbarExtra}
    />
  )
}
