export interface MarketingCampaignTemplate {
  id: string
  company_id: string
  name: string
  category: string
  description: string | null
  is_active: boolean
  sort_order: number
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  campaign_template_tasks?: MarketingCampaignTemplateTask[]
}

export interface MarketingCampaignTemplateTask {
  id: string
  campaign_template_id: string
  name: string
  description: string | null
  is_required: boolean
  default_status: string
  is_active: boolean
  sort_order: number
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export interface MarketingMonthlyPlan {
  id: string
  company_id: string
  location_id: string
  plan_month: number
  plan_year: number
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  campaign_assignments?: MarketingCampaignAssignment[]
}

export interface MarketingCampaignAssignment {
  id: string
  monthly_plan_id: string
  campaign_template_id: string | null
  campaign_name_snapshot: string
  campaign_category_snapshot: string
  status: string
  sort_order: number
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  campaign_tasks?: MarketingCampaignTask[]
}

export interface MarketingCampaignTask {
  id: string
  campaign_assignment_id: string
  template_task_id: string | null
  task_name_snapshot: string
  task_description_snapshot: string | null
  status: 'not_started' | 'in_progress' | 'complete' | 'blocked' | 'not_applicable'
  is_required: boolean
  sort_order: number
  notes: string | null
  completed_at: string | null
  completed_by: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

/** Lightweight location shape used across marketing module */
export interface MarketingLocation {
  id: string
  /** Location code identifier, e.g. "001" — DB column is `name` */
  name: string
  /** Human-readable city/label — DB column is `shop_city` */
  shop_city: string | null
  region: string | null
  active: boolean
  metadata: Record<string, string | null> | null
}

/** Helper to read a metadata field off a MarketingLocation */
export function locMeta(loc: MarketingLocation, key: string): string {
  return loc.metadata?.[key] ?? ''
}

export type TaskStatus = 'not_started' | 'in_progress' | 'complete' | 'blocked' | 'not_applicable'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  complete: 'Complete',
  blocked: 'Blocked',
  not_applicable: 'N/A',
}

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  not_started: 'inky',
  in_progress: 'sky',
  complete: 'green',
  blocked: 'red',
  not_applicable: 'inky',
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export const CAMPAIGN_CATEGORIES = [
  'Direct Mail',
  'Digital',
  'CRM',
  'Signage',
  'Operations',
  'Local Marketing/Other',
  'Competition Support',
  'Other',
]

export function calcProgress(tasks: { status: string }[]): { done: number; total: number; pct: number } {
  const applicable = tasks.filter((t) => t.status !== 'not_applicable')
  const done = applicable.filter((t) => t.status === 'complete').length
  const total = applicable.length
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
}

/** Default campaign templates seeded from the 2026 Site Support Tracker */
export const DEFAULT_TEMPLATES: Array<{
  name: string
  category: string
  description: string
  tasks: Array<{ name: string; description: string }>
}> = [
  {
    name: 'Direct Mail',
    category: 'Direct Mail',
    description: 'Monthly direct mail campaign setup and optimization',
    tasks: [
      { name: 'On ACQ Order w/ Budget', description: 'Confirm direct mail acquisition order is placed with budget allocated' },
      { name: 'Offers/messaging reviewed', description: 'Review and approve offers and messaging for the month' },
      { name: 'Map added', description: 'Confirm map is added to direct mail piece' },
      { name: 'Routes reviewed', description: 'Review mail routes for coverage and efficiency' },
      { name: 'Response rates reviewed', description: 'Analyze prior month response rates and adjust strategy' },
      { name: 'DM tests added', description: 'Set up A/B tests for direct mail pieces' },
      { name: 'ACQ budget boosted', description: 'Confirm acquisition budget has been boosted if needed' },
    ],
  },
  {
    name: 'Digital',
    category: 'Digital',
    description: 'Monthly digital marketing order and optimization',
    tasks: [
      { name: 'On monthly order', description: 'Confirm digital marketing is on the monthly order' },
      { name: 'Response rates reviewed', description: 'Review digital campaign response rates' },
      { name: 'Shared budget reviewed', description: 'Review shared digital budget allocation' },
      { name: 'Budget boosted', description: 'Confirm digital budget has been boosted if needed' },
    ],
  },
  {
    name: 'CRM',
    category: 'CRM',
    description: 'Monthly CRM campaign setup and data management',
    tasks: [
      { name: 'Active / historical data loaded', description: 'Confirm active and historical customer data is loaded in CRM' },
      { name: 'Response rates reviewed', description: 'Review CRM campaign response rates' },
      { name: 'Promo text/email scheduled', description: 'Schedule promotional texts and emails for the month' },
      { name: 'Data collection reviewed', description: 'Review data collection processes and completeness' },
    ],
  },
  {
    name: 'Signage',
    category: 'Signage',
    description: 'On-site signage review and approval',
    tasks: [
      { name: 'Signage reviewed', description: 'Review all current on-site signage for compliance and accuracy' },
      { name: 'On-site promo approved', description: 'Approve any on-site promotional materials' },
    ],
  },
  {
    name: 'Operations',
    category: 'Operations',
    description: 'Monthly operational marketing tasks',
    tasks: [
      { name: 'Google listing reviewed', description: 'Review and update Google Business listing' },
      { name: 'Field contacted for context', description: 'Contact field team for local market context' },
      { name: 'Camera audits reviewed', description: 'Review camera audit footage for marketing insights' },
    ],
  },
  {
    name: 'Local Marketing / Other',
    category: 'Local Marketing/Other',
    description: 'Local marketing initiatives and miscellaneous campaigns',
    tasks: [
      { name: 'AI Call Center offers', description: 'Review and set up AI call center promotional offers' },
      { name: 'Autopen campaigns', description: 'Set up autopen campaigns for the month' },
      { name: 'Billboard reviewed', description: 'Review billboard placement and messaging' },
      { name: 'Local marketing initiatives', description: 'Execute planned local marketing initiatives' },
    ],
  },
  {
    name: 'Competition Support',
    category: 'Competition Support',
    description: 'Competitor monitoring and response',
    tasks: [
      { name: 'Competitor Pricing/Promos Confirmed', description: 'Confirm and document competitor pricing and promotions' },
      { name: 'Opening date/proximity to SBOC reviewed/confirmed', description: 'Review competitor opening dates and proximity to our locations' },
      { name: 'Competitor Match Signage In Place and/or Ordered', description: 'Ensure competitive match signage is in place or ordered' },
    ],
  },
]
