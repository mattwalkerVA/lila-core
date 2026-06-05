// Pulls Gmail messages via REST.
//
// Two-pass design: cheap metadata-only list first (headers + snippet),
// then format=full only for messages that survive the caller's prefilter.
// This bounds full-body fetches to what actually needs Sonnet attention.
//
// Uses historyId as an incremental cursor so each run processes only new
// messages. On first run (no historyId), falls back to a date-bounded
// query and seeds the cursor from the profile endpoint.

export interface GmailMessageMeta {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string  // ms since epoch, as string
  payload?: {
    headers?: Array<{ name: string; value: string }>
  }
}

export interface GmailMessageFull extends GmailMessageMeta {
  historyId?: string
  payload?: GmailMessageMeta['payload'] & {
    mimeType?: string
    body?: { data?: string }
    parts?: GmailPart[]
  }
}

export interface GmailPart {
  mimeType: string
  body?: { data?: string }
  parts?: GmailPart[]
}

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const PAGE_SIZE = 100

async function gmailGet(url: URL | string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`gmail ${res.status}: ${text}`)
  }
  return res.json()
}

export async function listNewMessageIds(
  accessToken: string,
  historyId: string | null,
): Promise<{ messageIds: string[]; newHistoryId: string | null }> {
  if (historyId) return listViaHistory(accessToken, historyId)
  return listViaQuery(accessToken)
}

async function listViaHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; newHistoryId: string | null }> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  let newHistoryId: string | null = null

  do {
    const url = new URL(`${API_BASE}/history`)
    url.searchParams.set('startHistoryId', startHistoryId)
    url.searchParams.set('historyTypes', 'messageAdded')
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const json = (await gmailGet(url, accessToken)) as {
      history?: Array<{
        messagesAdded?: Array<{ message: { id: string } }>
      }>
      nextPageToken?: string
      historyId?: string
    }
    newHistoryId = json.historyId ?? null
    for (const h of json.history ?? []) {
      for (const added of h.messagesAdded ?? []) ids.add(added.message.id)
    }
    pageToken = json.nextPageToken
  } while (pageToken)

  return { messageIds: Array.from(ids), newHistoryId }
}

async function listViaQuery(
  accessToken: string,
): Promise<{ messageIds: string[]; newHistoryId: string | null }> {
  // Gmail does the cheap filtering for free: drop promotions/social before
  // we even see the message. Unread + primary/updates covers what matters.
  const q = 'is:unread (category:primary OR category:updates) newer_than:14d -category:promotions -category:social'
  const ids: string[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`${API_BASE}/messages`)
    url.searchParams.set('q', q)
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const json = (await gmailGet(url, accessToken)) as {
      messages?: Array<{ id: string }>
      nextPageToken?: string
    }
    for (const m of json.messages ?? []) ids.push(m.id)
    pageToken = json.nextPageToken
  } while (pageToken)

  // Seed the historyId cursor from the profile so subsequent runs are incremental.
  let newHistoryId: string | null = null
  try {
    const profile = (await gmailGet(`${API_BASE}/profile`, accessToken)) as { historyId?: string }
    newHistoryId = profile.historyId ?? null
  } catch {
    // Non-fatal; next run will re-query until a cursor is established.
  }

  return { messageIds: ids, newHistoryId }
}

// Fetch metadata only (headers + snippet). Cheap — no body transfer.
export async function fetchMessageMeta(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageMeta> {
  const url = new URL(`${API_BASE}/messages/${messageId}`)
  url.searchParams.set('format', 'metadata')
  // Request only the headers we actually use to keep response size small.
  for (const h of ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe']) {
    url.searchParams.append('metadataHeaders', h)
  }
  return gmailGet(url, accessToken) as Promise<GmailMessageMeta>
}

// Fetch full message with body. Only called for prefilter survivors.
export async function fetchMessageFull(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageFull> {
  const url = new URL(`${API_BASE}/messages/${messageId}`)
  url.searchParams.set('format', 'full')
  return gmailGet(url, accessToken) as Promise<GmailMessageFull>
}

// Extract plain-text body from a full message. Prefers text/plain;
// falls back to stripping tags from text/html.
export function extractBodyText(msg: GmailMessageFull): string | null {
  if (!msg.payload) return null
  const plain = findPart(msg.payload, 'text/plain')
  if (plain) return decodeBase64url(plain)
  const html = findPart(msg.payload, 'text/html')
  if (html) return stripHtml(decodeBase64url(html))
  return null
}

function findPart(
  payload: NonNullable<GmailMessageFull['payload']>,
  mimeType: string,
): string | null {
  if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data
  for (const part of payload.parts ?? []) {
    const found = findPart(part as NonNullable<GmailMessageFull['payload']>, mimeType)
    if (found) return found
  }
  return null
}

function decodeBase64url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return decodeURIComponent(
    Array.from(binary)
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  )
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getHeader(msg: GmailMessageMeta, name: string): string | null {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  )
}
