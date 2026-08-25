// Editable email templates + token rendering for the Tank Monitors email
// workflow (Offline monitors + Low VMI coverage). Templates are stored per
// company in platform.app_settings via useAppSetting; the draft is rendered to
// copyable fields the user pastes into Outlook.

export type TankEmailKind = 'offline' | 'lowvmi'

// Local (not UTC) YYYY-MM-DD for "today" — comm_date represents the calendar
// day someone was contacted, which is a local-time concept. Using
// toISOString() here rolls over at UTC midnight, i.e. mid-afternoon/evening
// in US timezones, so a comm logged this afternoon would stop matching
// "today" by evening even though it's still the same local day.
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Stable, location-qualified identity for a tank monitor — used to persist a
// per-monitor "ignore" list (a bare serial could theoretically collide across
// shops, so this always includes the location).
export function monitorIgnoreKey(m: { location_id: string | null; serial_rtu_id: string | null; system_tank_id: string | null; product_id: string | null }): string {
  return `${m.location_id ?? ''}|${m.serial_rtu_id || m.system_tank_id || m.product_id || ''}`
}

export interface TankEmailTemplate {
  subject: string
  to: string
  body: string
  magnetImage?: string | null // data URI, embedded in the rendered body
  vmiOnly?: boolean // when true (default), the draft only includes VMI/keepfill tanks
}

// Tokens the templates may reference. monitor_table + magnet_image are HTML
// blocks; the rest are plain text resolved per shop.
export const TANK_EMAIL_TOKENS: { token: string; label: string }[] = [
  { token: 'greeting', label: 'Good morning / afternoon (based on your local time)' },
  { token: 'shop_number', label: 'Shop number' },
  { token: 'shop_name', label: 'Shop name / city' },
  { token: 'area_manager', label: 'Area manager name' },
  { token: 'shop_email', label: 'Shop email' },
  { token: 'am_email', label: 'Area manager email' },
  { token: 'rd_email', label: 'Regional director email' },
  { token: 'monitor_table', label: 'Monitor table (product, serial, height, capacity)' },
  { token: 'magnet_image', label: 'Magnet photo (uploaded below)' },
]

// "Good morning," before noon local time, "Good afternoon," otherwise — used to
// fill the {{greeting}} token when a draft is copied.
export function greetingFor(d: Date = new Date()): string {
  return d.getHours() < 12 ? 'Good morning,' : 'Good afternoon,'
}

export const OFFLINE_DEFAULT: TankEmailTemplate = {
  subject: 'Shop {{shop_number}} - Offline Tank Monitor(s)',
  to: '{{shop_email}}, {{am_email}}',
  body: `{{greeting}}

Your tank monitor(s) with the following product(s) and serial number(s) are showing as offline:

{{monitor_table}}

Can you reactivate by rubbing the magnet attached to the monitor to the top of the monitor until the light turns on?

To reactivate, rub the magnet attached to the monitor to the top of the monitor until the light turns on, the light should flash while it searches for connection, go solid once connected, then turn off.

Below shows where to rub the magnet:

{{magnet_image}}

Thank you,`,
  magnetImage: null,
  vmiOnly: true,
}

export const LOWVMI_DEFAULT: TankEmailTemplate = {
  subject: 'Shop {{shop_number}} - Tank Monitor Coverage',
  to: '{{shop_email}}, {{am_email}}',
  body: `{{greeting}}

Our records show shop {{shop_number}} currently has limited tank monitor (VMI) coverage. The following bulk products are on managed inventory today:

{{monitor_table}}

Adding monitors to additional bulk products lets us keep you stocked automatically and reduces run-outs. Please let us know if any tanks are missing a monitor so we can schedule an install.

Thank you,`,
  magnetImage: null,
  vmiOnly: true,
}

export const TANK_EMAIL_DEFAULT: Record<TankEmailKind, TankEmailTemplate> = {
  offline: OFFLINE_DEFAULT,
  lowvmi: LOWVMI_DEFAULT,
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const TOKEN_RE = /\{\{(\w+)\}\}/g

// Plain-text render (subject / to lines) — drops HTML-only tokens.
export function renderText(tpl: string, values: Record<string, string>): string {
  return tpl.replace(TOKEN_RE, (_m, k) => values[k] ?? '')
}

// Rich-HTML body: literal text is escaped + newlines become <br>; HTML block
// tokens (monitor_table, magnet_image) are injected raw.
export function renderBodyHtml(
  tpl: string,
  values: Record<string, string>,
  htmlBlocks: Record<string, string>,
): string {
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(tpl))) {
    out += escapeHtml(tpl.slice(last, m.index)).replace(/\n/g, '<br>')
    const key = m[1]
    if (htmlBlocks[key] != null) out += htmlBlocks[key]
    else out += escapeHtml(values[key] ?? '')
    last = TOKEN_RE.lastIndex
  }
  out += escapeHtml(tpl.slice(last)).replace(/\n/g, '<br>')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#002745;line-height:1.45;">${out}</div>`
}

// Plain-text body: HTML block tokens fall back to a plain representation.
export function renderBodyPlain(
  tpl: string,
  values: Record<string, string>,
  plainBlocks: Record<string, string>,
): string {
  return tpl.replace(TOKEN_RE, (_m, k) =>
    plainBlocks[k] != null ? plainBlocks[k] : values[k] ?? '')
}

export interface TableCol { key: string; label: string }
export type TableRow = Record<string, string>

// HTML table styled to paste into Outlook with gridlines + banded rows. Empty
// cells render blank (not "—") so the caller can intentionally leave fields out.
export function tableHtml(cols: TableCol[], rows: TableRow[]): string {
  // Header cells are bold <td> (not <th>) — some email clients drop <th>
  // color. Text is nested in a legacy <font color> tag, not just inline CSS
  // — Outlook's Word-based rendering engine has a long-standing bug where it
  // drops/overrides inline `color` on table cells (especially once pasted
  // through Excel first), silently turning cream-on-navy into illegible
  // black-on-navy. <font color> is the one thing that reliably survives that
  // pipeline; the inline color stays too for clients that do respect it.
  const headCell = (t: string) =>
    `<td style="border:1px solid #002745;background:#002745;color:#F2F1E6;padding:5px 10px;text-align:left;font-weight:bold;"><font color="#F2F1E6">${escapeHtml(t)}</font></td>`
  const head = `<tr>${cols.map((c) => headCell(c.label)).join('')}</tr>`
  const body = rows
    .map((r, i) => {
      const bg = i % 2 ? '#F2F1E6' : '#FFFFFF'
      return `<tr>${cols
        .map((c) => `<td style="border:1px solid #4F7489;padding:3px 10px;background:${bg};color:#002745;">${escapeHtml(r[c.key] ?? '')}</td>`)
        .join('')}</tr>`
    })
    .join('')
  return `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#002745;"><tbody>${head}${body}</tbody></table>`
}

export function tablePlain(cols: TableCol[], rows: TableRow[]): string {
  const header = cols.map((c) => c.label).join('\t')
  return [header, ...rows.map((r) => cols.map((c) => r[c.key] ?? '').join('\t'))].join('\n')
}

// Resolve "word(s)" fragments in a rendered draft to the singular or plural form
// based on the item count — so "tank monitor(s)" reads "monitor" for one and
// "monitors" for many, with no dangling "(s)". Words ending in s/x/z/ch/sh get
// "es"; everything else gets "s".
export function pluralizeParens(text: string, count: number): string {
  return text.replace(/([A-Za-z]+)\(s\)/g, (_m, word: string) => {
    if (count === 1) return word
    return /(?:s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`
  })
}

export function magnetImageHtml(dataUri: string | null | undefined): string {
  if (!dataUri) return ''
  return `<img src="${dataUri}" alt="Rub magnet on top of monitor" style="max-width:340px;height:auto;border:1px solid #4F7489;" />`
}

// Default "skip a monitor if we already emailed about it recently" window.
export const DEFAULT_EMAIL_SKIP_DAYS = 5

// location_comms statuses (from exceptions.ts's EXCEPTION_STATUSES, shared
// across every comm type) that mean the shop/AM still owes a response — as
// opposed to 'Tentatively Closed' / 'Closed', which mean the comm is done.
export const OPEN_COMM_STATUSES = new Set([
  'Pending Shop/AM Response',
  'Pending RelaDyne Response',
  'Pending Procurement Action',
])

// Per-shop, per-serial: every monitor already covered by a STILL-OPEN comm,
// independent of how long ago it was sent. The skip-days window only holds a
// monitor out of the list for a few days; a comm nobody ever resolved should
// keep suppressing it indefinitely, not reappear (and get double-emailed)
// once it ages past that window.
export function buildPendingCommSet(
  rows: { location_id: string | null; products: unknown; status: string | null }[],
): Map<string, Set<string>> {
  const byLoc = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.location_id || !row.status || !OPEN_COMM_STATUSES.has(row.status)) continue
    const list = Array.isArray(row.products) ? (row.products as { serial?: string | null }[]) : []
    let set = byLoc.get(row.location_id)
    if (!set) { set = new Set(); byLoc.set(row.location_id, set) }
    for (const p of list) { if (p?.serial) set.add(p.serial) }
  }
  return byLoc
}

// A still-open comm logged with no specific serials (a legacy row, or one
// entered by hand outside the email flow — Location Comms lets someone add a
// row for a shop without picking individual monitors) can't say which
// serials it covers, but it almost certainly covers whatever's currently
// offline at that shop. Mirrors backfillTodayBlanket's blank-comm handling,
// but deliberately has NO time cutoff — the whole point of "pending" here is
// to keep suppressing a monitor past the skip-days window, so time-limiting
// this defeats that.
export function backfillPendingBlanket(
  pending: Set<string>,
  rows: { products: unknown; status: string | null }[],
  serials: (string | null | undefined)[],
): Set<string> {
  const hasOpenBlankComm = rows.some((r) => {
    if (!r.status || !OPEN_COMM_STATUSES.has(r.status)) return false
    const list = Array.isArray(r.products) ? r.products : []
    return list.length === 0
  })
  if (!hasOpenBlankComm) return pending
  const next = new Set(pending)
  for (const s of serials) { if (s) next.add(s) }
  return next
}

// Per-monitor last-emailed dates, derived from inventory.location_comms rows
// logged by the tank email workflow (each row's `products` holds the serials
// that email covered — see TankEmailModal.logAndNext). Returns location_id ->
// (serial -> last comm_date/updated_at, ISO). Rows with no products (e.g. logs
// from before this tracking existed) simply contribute nothing.
export function buildMonitorEmailLog(
  rows: { location_id: string | null; comm_date: string | null; updated_at: string; products: unknown }[],
): Map<string, Map<string, string>> {
  const byLoc = new Map<string, Map<string, string>>()
  for (const row of rows) {
    if (!row.location_id) continue
    const when = row.comm_date || row.updated_at
    if (!when) continue
    const list = Array.isArray(row.products) ? (row.products as { serial?: string | null }[]) : []
    if (!list.length) continue
    let forLoc = byLoc.get(row.location_id)
    if (!forLoc) { forLoc = new Map(); byLoc.set(row.location_id, forLoc) }
    for (const p of list) {
      if (!p?.serial) continue
      const prev = forLoc.get(p.serial)
      if (!prev || when > prev) forLoc.set(p.serial, when)
    }
  }
  return byLoc
}

// A recent "Offline Tank Monitor" comm logged with no specific serials
// attached (a legacy row, one logged by hand outside the email flow, or a
// batch send where every candidate was itself skip-filtered out) still
// almost certainly covers that shop's offline monitors as of when it was
// logged — we just can't say which serials specifically. Backfill: the most
// recent such blank-products comm within `windowDays` (default: the skip
// window, so a blank log stays effective for as long as a per-serial one
// would) fills in every given serial not already in the log, using that
// comm's date as its "last emailed" value.
//
// Originally this only matched a blank comm logged *today*, which meant the
// backfill silently stopped applying the day after — a shop genuinely
// emailed yesterday (with an empty products array) would look "never
// emailed" again by the next morning even though nothing about the shop had
// changed. Widening the match to a rolling window fixes that.
export function backfillTodayBlanket(
  log: Map<string, string>,
  rows: { comm_date: string | null; updated_at: string; products: unknown }[],
  serials: (string | null | undefined)[],
  windowDays: number = DEFAULT_EMAIL_SKIP_DAYS,
): Map<string, string> {
  const cutoff = Date.now() - windowDays * 86400000
  let mostRecent: string | null = null
  for (const r of rows) {
    const list = Array.isArray(r.products) ? r.products : []
    if (list.length > 0) continue
    const raw = r.comm_date || r.updated_at
    if (!raw) continue
    const iso = raw.length <= 10 ? `${raw}T00:00:00` : raw
    const t = new Date(iso).getTime()
    if (Number.isNaN(t) || t < cutoff) continue
    if (!mostRecent || iso > mostRecent) mostRecent = iso
  }
  if (!mostRecent) return log
  const next = new Map(log)
  for (const serial of serials) {
    if (serial && !next.has(serial)) next.set(serial, mostRecent!)
  }
  return next
}
