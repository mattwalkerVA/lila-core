// POST /connectors-google-calendar-sync
// Service-role only. Cron-fired every 30 minutes.
//
// For each user with a connected Google Calendar account:
//   1. Exchange refresh_token → access_token.
//   2. Fetch events from the primary calendar (past 14d + next 30d).
//   3. Upsert into the events table via connectors-calendar-sync logic.
//   4. Tombstone events that have been deleted from Google Calendar.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse } from '../_shared/http.ts'
import { hasServiceRole } from '../_shared/http.ts'
import { exchangeRefreshToken } from '../../../src/connectors/gmail/auth.ts'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const CONNECTOR = 'google_calendar'

interface GCalEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  location?: string
  description?: string
  attendees?: Array<{ email: string; displayName?: string }>
  status?: string
}

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!hasServiceRole(auth)) throw new HttpError(403, 'service-role only')

  const { data: accounts, error: acctErr } = await adminSupabase
    .from('connector_accounts')
    .select('user_id, refresh_token, oauth_client_id')
    .eq('provider', CONNECTOR)
    .eq('status', 'connected')
  if (acctErr) throw new HttpError(500, `load accounts: ${acctErr.message}`)
  if (!accounts || accounts.length === 0) return jsonResponse({ users: 0 })

  const webClientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
  const webClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

  const results = await Promise.allSettled(
    (accounts as Array<{ user_id: string; refresh_token: string; oauth_client_id: string | null }>)
      .map((acct) => {
        const clientId = acct.oauth_client_id ?? webClientId
        const clientSecret = acct.oauth_client_id ? null : webClientSecret
        return syncUser(acct.user_id, acct.refresh_token, clientId, clientSecret)
      }),
  )

  const ok = results.filter((r) => r.status === 'fulfilled').length
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason?.message ?? 'unknown')
  if (errors.length > 0) console.error('google-calendar-sync errors:', errors)

  return jsonResponse({ users: accounts.length, ok, failed: errors.length, errors })
}))

async function syncUser(
  userId: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string | null,
) {
  const { token } = await exchangeRefreshToken(clientId, clientSecret, refreshToken)

  const now = new Date()
  const timeMin = new Date(now.getTime() - 14 * 86400_000).toISOString()
  const timeMax = new Date(now.getTime() + 30 * 86400_000).toISOString()

  const events = await fetchAllEvents(token, timeMin, timeMax)

  if (events.length === 0) {
    await advanceSyncTime(userId)
    return { user_id: userId, upserted: 0 }
  }

  const mapped = events
    .filter((e) => e.status !== 'cancelled' && (e.start?.dateTime || e.start?.date))
    .map((e) => ({
      user_id: userId,
      connector: CONNECTOR,
      external_id: e.id,
      title: e.summary ?? '(no title)',
      start_at: e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`,
      end_at: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null),
      location: e.location ?? null,
      notes: e.description ?? null,
      attendees: e.attendees?.map((a) => a.displayName ?? a.email) ?? null,
    }))

  // Upsert events in batches of 100.
  for (let i = 0; i < mapped.length; i += 100) {
    const chunk = mapped.slice(i, i + 100)
    const { error } = await adminSupabase
      .from('events')
      .upsert(chunk, { onConflict: 'user_id,connector,external_id' } as any)
    if (error) throw new Error(`events upsert: ${error.message}`)
  }

  // Tombstone events deleted from Google (not in the fetched window but exist in DB).
  const fetchedIds = new Set(mapped.map((e) => e.external_id))
  const { data: existing } = await adminSupabase
    .from('events')
    .select('id, external_id')
    .eq('user_id', userId)
    .eq('connector', CONNECTOR)
    .is('resolved_at', null)
    .gte('start_at', timeMin)
    .lte('start_at', timeMax)

  const toTombstone = (existing ?? []).filter((r: any) => !fetchedIds.has(r.external_id))
  if (toTombstone.length > 0) {
    await adminSupabase
      .from('events')
      .update({ resolved_at: now.toISOString() })
      .in('id', toTombstone.map((r: any) => r.id))
  }

  await advanceSyncTime(userId)
  return { user_id: userId, upserted: mapped.length }
}

async function fetchAllEvents(token: string, timeMin: string, timeMax: string): Promise<GCalEvent[]> {
  const all: GCalEvent[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`${CAL_BASE}/calendars/primary/events`)
    url.searchParams.set('timeMin', timeMin)
    url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`google calendar ${res.status}: ${text}`)
    }
    const json = (await res.json()) as { items?: GCalEvent[]; nextPageToken?: string }
    all.push(...(json.items ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)

  return all
}

async function advanceSyncTime(userId: string) {
  await adminSupabase
    .from('connector_accounts')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', CONNECTOR)
}
