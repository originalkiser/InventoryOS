// Types + editable config for Location Communications.

export interface CommProduct {
  product_id: string
  configured: boolean
  on_hand: number | null
  days_of_supply: number | null
  orderable: boolean
  eta: string | null
}

export interface LocationComm {
  id: string
  company_id: string
  location_id: string | null
  comm_date: string | null
  contact_method: string | null
  email_subject: string | null
  who_contacted: string | null
  comm_type: string | null
  products: CommProduct[] | null
  action_taken: string | null
  exception_report_id: string | null
  status: string | null
  notes: string | null
  metadata: Record<string, unknown> | null
  updated_by: string | null
  last_change_source: string | null
  created_at: string
  updated_at: string
}

export interface CommsConfig {
  contactMethods: string[]
  whoContacted: string[]
  commTypes: string[]
  actionTaken: string[]
}

export const DEFAULT_COMMS_CONFIG: CommsConfig = {
  contactMethods: ['Phone', 'Email', 'Text', 'In Person', 'Teams'],
  whoContacted: ['Procurement', 'Area Manager', 'Shop Manager'],
  commTypes: ['Product Request', 'Exception Reporting'],
  actionTaken: ['Ad Hoc Order', 'Ordering on Next Order'],
}

export const isEmailMethod = (m: string | null | undefined) => (m ?? '').toLowerCase().includes('email')
