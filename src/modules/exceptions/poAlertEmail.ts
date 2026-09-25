// Editable email template for the Late PO Receipt Alerts email workflow —
// same shape as Tank Monitors' own offline/low-VMI email flow
// (src/modules/locations/tankEmail.ts), reusing its generic render/table
// helpers directly rather than duplicating them (renderText/renderBodyHtml/
// renderBodyPlain/tableHtml/tablePlain/pluralizeParens/greetingFor/
// localDateStr all take plain {key: value} data, nothing tank-specific).
// One template only (unlike Tank Monitors' offline/lowvmi pair) — there's
// only one kind of "call out this late PO" email here.
export type { TableCol, TableRow } from '@/modules/locations/tankEmail'
export { renderText, renderBodyHtml, renderBodyPlain, tableHtml, tablePlain, pluralizeParens, greetingFor, localDateStr, escapeHtml } from '@/modules/locations/tankEmail'

export interface PoAlertEmailTemplate {
  subject: string
  to: string
  body: string
}

export const PO_ALERT_EMAIL_TOKENS: { token: string; label: string }[] = [
  { token: 'greeting', label: 'Good morning / afternoon (based on your local time)' },
  { token: 'shop_number', label: 'Shop number' },
  { token: 'shop_name', label: 'Shop name / city' },
  { token: 'area_manager', label: 'Area manager name' },
  { token: 'shop_email', label: 'Shop email' },
  { token: 'am_email', label: 'Area manager email' },
  { token: 'supplier_name', label: 'Supplier (e.g. RelaDyne)' },
  { token: 'po_table', label: 'Table of this shop\'s late PO(s) — PO #, expected delivery, days late' },
]

export const PO_ALERT_EMAIL_DEFAULT: PoAlertEmailTemplate = {
  subject: 'Shop {{shop_number}} - Purchase Order Not Received',
  to: '{{shop_email}}, {{am_email}}',
  body: `{{greeting}}

Our records show the following purchase order(s) from {{supplier_name}} should have already been delivered to shop {{shop_number}}, but we have no record of any receipt activity on them:

{{po_table}}

Can you confirm whether this shipment has actually arrived? If it has, please log the receipt in the system. If it hasn't, let us know so we can follow up with {{supplier_name}}.

Thank you,`,
}
