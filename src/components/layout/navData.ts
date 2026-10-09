// Navigation data shared by every nav layout (sidebar, mega menu, floating dock) and the nav search.

export interface NavItem {
  key: string
  label: string
  to: string | null
}

export const SECTION_ITEMS: Record<string, NavItem[]> = {
  inventory: [
    { key: 'dashboard', label: 'Dashboard', to: '/dashboard' },
    { key: 'on-hand', label: 'On Hand', to: '/on-hand' },
    { key: 'monthend', label: 'Month End Count', to: '/monthend' },
    { key: 'weekly', label: 'Weekly Count', to: '/weekly' },
    { key: 'orders', label: 'Orders', to: '/orders' },
    { key: 'orders-v2', label: 'Orders v2', to: '/orders-v2' },
    { key: 'po-status', label: 'Purchase Orders', to: '/po-status' },
    { key: 'projects', label: 'Projects', to: '/projects' },
    { key: 'config', label: 'Inventory Config', to: '/config' },
    { key: 'location-lookup', label: 'Location Lookup', to: '/location-lookup' },
    { key: 'custom-shop-config', label: 'Custom Shop Config', to: '/custom-shop-config' },
    { key: 'am-rd-lookup', label: 'AM/RD Lookup', to: '/am-rd-lookup' },
    { key: 'tank-monitors', label: 'Tank Monitors', to: '/tank-monitors' },
    { key: 'procurement-deck', label: 'Procurement Deck', to: '/procurement-deck' },
    { key: 'count-sheet', label: 'Count Sheet', to: '/count-sheet' },
    { key: 'inventory-alerts', label: 'Inventory Alerts', to: '/inventory-alerts' },
    { key: 'exception-reporting', label: 'Exception Reporting', to: '/exception-reporting' },
    { key: 'location-comms', label: 'Location Comms', to: '/location-comms' },
  ],
  'shop-tools': [
    { key: 'tank-links', label: 'Tank Calculator Links', to: '/tank-links' },
    { key: 'tank-review', label: 'Tank Count Review', to: '/tank-review' },
  ],
  droptop: [
    { key: 'customer-heatmap', label: 'Customer Heatmap', to: '/customer-heatmap' },
    { key: 'droptop-orders', label: 'Droptop Orders', to: '/droptop-orders' },
    { key: 'droptop-vehicles', label: 'Vehicles', to: '/droptop-vehicles' },
    { key: 'droptop-packages', label: 'Packages', to: '/droptop-packages' },
    { key: 'package-mapping', label: 'Package Mapping', to: '/package-mapping' },
    { key: 'pricing-audit', label: 'Pricing Audit', to: '/pricing-audit' },
    { key: 'product-sales-history', label: 'Product Sales History', to: '/product-sales-history' },
    { key: 'staffing-report', label: 'Staffing Report', to: '/staffing-report' },
  ],
  'data-connections': [
    { key: 'data-connections', label: 'Data Connections', to: '/data-connections' },
  ],
  reladyne: [
    { key: 'mmr', label: 'MMR', to: '/mmr' },
  ],
  'global-config': [
    { key: 'global-config', label: 'Global Config', to: '/global-config' },
  ],
  operations: [
    { key: 'outlier', label: 'Outlier Reporting', to: '/operations/outlier' },
    { key: 'outlier-am', label: 'AM Dashboard', to: '/operations/outlier/am-dashboard' },
    { key: 'outlier-leadership', label: 'Leadership', to: '/operations/outlier/leadership' },
  ],
  finance: [
    { key: 'grni', label: 'GRNI', to: '/grni' },
    { key: 'cogs-price-check', label: 'COGS Price Check', to: '/cogs-price-check' },
  ],
  accounting: [{ key: 'accounting-soon', label: 'Coming Soon', to: null }],
  marketing: [
    { key: 'marketing-planner', label: 'Marketing Planner', to: '/marketing-planner' },
    { key: 'menu-board', label: 'Menu Board', to: '/menu-board' },
  ],
}

export const SECTION_META: Record<string, { label: string }> = {
  inventory: { label: 'Inventory' },
  droptop: { label: 'Droptop' },
  'shop-tools': { label: 'Shop Tools' },
  'data-connections': { label: 'Data Connections' },
  reladyne: { label: 'RelaDyne' },
  'global-config': { label: 'Configuration' },
  operations: { label: 'Operations' },
  finance: { label: 'Finance' },
  accounting: { label: 'Accounting' },
  marketing: { label: 'Marketing' },
}

/**
 * Every top-level sidebar section that can be granted to a user through the
 * admin panel — i.e. all of them except `global-config`, which stays
 * admin/developer only. Derived from SECTION_ITEMS so a newly-added section
 * automatically becomes assignable (see UsersPage's ManageUserModal, which
 * also auto-creates the matching platform.departments row on save). The
 * `key` doubles as the department slug and the sidebar section key.
 */
export const ASSIGNABLE_SECTIONS: { key: string; label: string }[] =
  Object.keys(SECTION_ITEMS)
    .filter((k) => k !== 'global-config')
    .map((k) => ({ key: k, label: SECTION_META[k]?.label ?? k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))

export const UTILITY_ITEMS: NavItem[] = [
  { key: 'calendar', label: 'Calendar', to: '/schedule' },
  { key: 'tasks', label: 'Tasks', to: '/tasks' },
  { key: 'issues', label: 'Issues', to: '/issues' },
  { key: 'meetings', label: 'Meeting Notes', to: '/meetings' },
  { key: 'forms', label: 'Forms', to: '/forms' },
  { key: 'locations', label: 'Locations', to: '/locations' },
  { key: 'feature-requests', label: 'Feature Requests', to: '/feature-requests' },
]
