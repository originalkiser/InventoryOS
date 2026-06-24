export const TABLE_KEYS = {
  issues:        'inventory.issues',
  projects:      'inventory.projects',
  tasks:         'inventory.tasks',
  meetingNotes:  'inventory.meeting_notes',
  counts:        'inventory.monthly_counts',
  countProducts: 'inventory.count_products',
  locations:     'core.locations',
  vendors:       'core.vendors',
  orderSessions: 'inventory.order_sessions',
} as const

export type TableKey = typeof TABLE_KEYS[keyof typeof TABLE_KEYS]
