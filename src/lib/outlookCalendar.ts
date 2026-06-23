// Outlook Calendar integration via Microsoft Graph API.
// All functions are gated behind FEATURE_KEYS.calendar.outlookSync.
// Full implementation activates once Azure OAuth is live (Phase 9).

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export interface OutlookEvent {
  id: string
  subject: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  attendees: Array<{
    emailAddress: { name: string; address: string }
    status: { response: string }
  }>
  location?: { displayName: string }
  isOnlineMeeting: boolean
  onlineMeetingUrl?: string
  bodyPreview: string
}

export interface GraphSubscription {
  id: string
  expirationDateTime: string
  clientState: string
}

async function graphGet<T>(accessToken: string, path: string): Promise<T | null> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) return null
  const json = await res.json()
  return json as T
}

export async function fetchOutlookEvents(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<OutlookEvent[]> {
  const result = await graphGet<{ value: OutlookEvent[] }>(
    accessToken,
    `/me/calendarView?startDateTime=${startDate}&endDateTime=${endDate}&$select=id,subject,start,end,attendees,location,isOnlineMeeting,onlineMeetingUrl,bodyPreview&$orderby=start/dateTime&$top=100`,
  )
  return result?.value ?? []
}

export async function fetchTodayEvents(accessToken: string): Promise<OutlookEvent[]> {
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString()
  return fetchOutlookEvents(accessToken, start, end)
}

export async function getActiveEvent(accessToken: string): Promise<OutlookEvent | null> {
  const events = await fetchTodayEvents(accessToken)
  const now = Date.now()
  const thirtyMin = 30 * 60 * 1000
  return (
    events.find((e) => {
      const start = new Date(e.start.dateTime).getTime()
      const end = new Date(e.end.dateTime).getTime()
      return start <= now && end >= now
    }) ??
    events.find((e) => {
      const start = new Date(e.start.dateTime).getTime()
      return start >= now - thirtyMin && start <= now
    }) ??
    null
  )
}

export async function fetchEventById(
  accessToken: string,
  eventId: string,
): Promise<OutlookEvent | null> {
  return graphGet<OutlookEvent>(accessToken, `/me/events/${eventId}`)
}

export async function registerCalendarSubscription(
  accessToken: string,
  notificationUrl: string,
): Promise<GraphSubscription> {
  const expiration = new Date(Date.now() + 4230 * 60 * 1000).toISOString()
  const clientState = crypto.randomUUID()
  const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'created,updated,deleted',
      notificationUrl,
      resource: 'me/events',
      expirationDateTime: expiration,
      clientState,
    }),
  })
  if (!res.ok) throw new Error('Failed to register calendar subscription')
  return res.json()
}

export async function renewSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<GraphSubscription> {
  const expiration = new Date(Date.now() + 4230 * 60 * 1000).toISOString()
  const res = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expirationDateTime: expiration }),
  })
  if (!res.ok) throw new Error('Failed to renew subscription')
  return res.json()
}

export async function deleteSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<void> {
  await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}
