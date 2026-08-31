// Static path → display label map for the Recent Pages carousel, mirroring
// the labels used in Sidebar.tsx's own nav definitions. Falls back to a
// title-cased last path segment for anything not listed here (e.g. deep
// dynamic routes like /orders-v2/draft/:id).
export const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/on-hand': 'On Hand',
  '/monthend': 'Month End Count',
  '/weekly': 'Weekly Count',
  '/orders': 'Orders',
  '/orders-v2': 'Orders v2',
  '/po-status': 'PO Status',
  '/projects': 'Projects',
  '/config': 'Inventory Config',
  '/global-config': 'Global Config',
  '/locations': 'Locations',
  '/location-lookup': 'Location Lookup',
  '/am-rd-lookup': 'AM/RD Lookup',
  '/tank-monitors': 'Tank Monitors',
  '/inventory-alerts': 'Inventory Alerts',
  '/exception-reporting': 'Exception Reporting',
  '/location-comms': 'Location Comms',
  '/dev-hub': 'Dev Hub',
  '/admin/users': 'Users',
  '/order-config': 'Order Config',
  '/order-history': 'Order History',
  '/feature-requests': 'Feature Requests',
  '/feature-requests/new': 'New Feature Request',
  '/feature-requests/manage': 'Manage Feature Requests',
  '/operations/outlier': 'Outlier Reporting',
  '/operations/outlier/am-dashboard': 'AM Dashboard',
  '/operations/outlier/leadership': 'Leadership',
  '/forms': 'Forms',
  '/forms/new': 'New Form',
  '/marketing-planner': 'Marketing Planner',
  '/customer-heatmap': 'Customer Heatmap',
  '/schedule': 'Calendar',
  '/tasks': 'Tasks',
  '/issues': 'Issues',
  '/meetings': 'Meeting Notes',
}

export function labelForPath(path: string): string {
  if (ROUTE_LABELS[path]) return ROUTE_LABELS[path]
  const prefixMatch = Object.keys(ROUTE_LABELS)
    .filter((p) => path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (prefixMatch) return ROUTE_LABELS[prefixMatch]
  const seg = path.split('/').filter(Boolean).pop() ?? 'Home'
  return seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Short 2-3 char badge for the carousel's round buttons (e.g. "Location
// Lookup" → "Loc"). Not hand-mapped per route — derived so any future route
// gets a reasonable badge for free.
export function shortForLabel(label: string): string {
  const firstWord = (label.match(/[A-Za-z0-9]+/) ?? [''])[0]
  return (firstWord.slice(0, 3) || '••').toUpperCase()
}
