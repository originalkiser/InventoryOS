// Shared "Cause" taxonomy for Location Comms and Issues — optional, records
// why something happened (a vendor, procurement, or the shop itself) with a
// more specific sub-reason. Fixed here rather than a config-editable list
// like comms_config/exception_config — say if you want it made editable
// through a settings screen later.
export const CAUSE_CATEGORIES = ['Vendor Issue', 'Procurement Team Issue', 'Shop Issue'] as const
export type CauseCategory = typeof CAUSE_CATEGORIES[number]

export const CAUSE_SUBCAUSES: Record<string, string[]> = {
  'Vendor Issue': ['Vendor out of product', 'Truck issues'],
  'Procurement Team Issue': ['Missed order'],
  'Shop Issue': ['Selling wrong product ID', 'Wrong Case Type on Hand', 'Inaccurate On Hands'],
}
