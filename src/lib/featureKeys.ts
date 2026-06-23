// Single source of truth for all assignable feature keys.
// Used by both the admin access panel and sidebar rendering logic.
// Never inline these strings — always reference FEATURE_KEYS.

export const FEATURE_KEYS = {
  inventory: {
    dashboard: 'inventory.dashboard',
    monthEnd: 'inventory.month_end',
    weekly: 'inventory.weekly',
    orders: 'inventory.orders',
    config: 'inventory.config',
    integrations: 'inventory.integrations',
    projects: 'inventory.projects',
  },
  outlier: {
    reports: 'outlier.reports',
  },
  calendar: {
    schedule: 'calendar.schedule',
    outlookSync: 'calendar.outlook_sync',
    outlookWrite: 'calendar.outlook_write',
  },
  platform: {
    featureRequests: 'platform.feature_requests',
    meetings: 'platform.meetings',
    tasks: 'platform.tasks',
    issues: 'platform.issues',
  },
  admin: {
    users: 'admin.users',
  },
} as const

// Flat map of all keys for iteration (admin panels, access assignment)
export const ALL_FEATURE_KEYS: string[] = [
  ...Object.values(FEATURE_KEYS.inventory),
  ...Object.values(FEATURE_KEYS.outlier),
  ...Object.values(FEATURE_KEYS.calendar),
  ...Object.values(FEATURE_KEYS.platform),
  ...Object.values(FEATURE_KEYS.admin),
]

// Human-readable labels for each key
export const FEATURE_KEY_LABELS: Record<string, string> = {
  'inventory.dashboard': 'Dashboard',
  'inventory.month_end': 'Month End Count',
  'inventory.weekly': 'Weekly Count',
  'inventory.orders': 'Orders',
  'inventory.config': 'Configuration',
  'inventory.integrations': 'Integrations',
  'inventory.projects': 'Projects',
  'outlier.reports': 'Operations Reports',
  'calendar.schedule': 'Calendar',
  'calendar.outlook_sync': 'Outlook Calendar Sync',
  'calendar.outlook_write': 'Outlook Write Access',
  'platform.feature_requests': 'Feature Requests',
  'platform.meetings': 'Meeting Notes',
  'platform.tasks': 'Tasks',
  'platform.issues': 'Issues',
  'admin.users': 'User Management',
}
