// Shared market color palette — used by both Map & Routes (MapRoutesTab)
// and Customer Heatmap so the same market renders in the same color on
// both pages. Map & Routes additionally overlays a diagonal/horizontal
// stripe pattern on its own pins/polygons once markets outnumber the
// palette, which only matters for that page's own background-fill pins —
// the solid color this exports is the piece both pages need to agree on.
//
// Consistency depends on both pages building `allMarkets` the same way —
// the full company-wide, alphabetically-sorted list of distinct markets,
// not just whatever's visible in the current filtered view — since the
// color is assigned by index into this list.
export const MARKET_PALETTE = [
  '#002745', '#C0392B', '#E67E22', '#2ECC71',
  '#4F7489', '#9B59B6', '#1ABC9C', '#E91E63',
  '#FF5722', '#3F51B5', '#00BCD4', '#FFC107',
]

export function getMarketSolidColor(market: string, allMarkets: string[]): string {
  if (!market) return '#4F7489'
  const idx = allMarkets.indexOf(market)
  return MARKET_PALETTE[idx % MARKET_PALETTE.length]
}
