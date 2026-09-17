// Shared types/helpers for Franchise Menu Board sharing (2026-09-18
// request) — a separate, confirmed-once pricing snapshot per franchise
// shop, distinct from the regular menu_board_shares system (see
// migration 20260930z_franchise_menu_shares.sql's own header comment for
// why). Used by FranchiseTab, FranchiseMenuForm, FranchiseConfirmModal,
// and the public PublicFranchiseMenuBoardPage.

export const FZMENU_BASE_URL = 'https://fzmenu.sboc.app/'

// The 5 canonical board packages, in board display order — key names match
// core.locations' own price columns 1:1 so auto-populating from a location
// row is a direct property lookup, not a remapping.
export const FRANCHISE_PACKAGE_KEYS = [
  'rp',
  'premium_full_synthetic_hm',
  'premium_full_synthetic',
  'premium_hm',
  'economy',
] as const
export type FranchisePackageKey = typeof FRANCHISE_PACKAGE_KEYS[number]

export const FRANCHISE_PACKAGE_LABELS: Record<FranchisePackageKey, string> = {
  economy: 'Economy',
  premium_hm: 'Premium High Mileage',
  premium_full_synthetic: 'Premium Full Synthetic',
  premium_full_synthetic_hm: 'Premium Full Synthetic High Mileage',
  rp: 'Valvoline Restore & Protect',
}

export interface FranchiseFees {
  shopSupplyFee: number | null
  disposalFee: number | null
  oilInflationSurcharge: number | null
}

/** The price actually shown on the board for one package — base as entered/imported, plus the 3 fees if the toggle says to fold them in. */
export function effectivePackagePrice(base: number | null, fees: FranchiseFees, feesIncluded: boolean): number | null {
  if (base == null) return null
  if (!feesIncluded) return base
  return base + (fees.shopSupplyFee ?? 0) + (fees.disposalFee ?? 0) + (fees.oilInflationSurcharge ?? 0)
}

export const FRANCHISE_FOOTER_NOTE = 'Menu pricing includes a shop supply and/or disposal fee.'
