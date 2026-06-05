// Maps Gmail messages into rows in inbound_messages and reconciles
// against what's already there. Idempotent on (user_id, connector, external_id).
//
// Two-pass: the cheap prefilter runs on metadata before any body is fetched.
// Only prefilter survivors get body_text populated and importance='keep'.
// Re-running on the same inbox is a no-op for messages that haven't changed.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GmailMessageMeta, GmailMessageFull } from './fetch.ts'
import { getHeader } from './fetch.ts'

export const CONNECTOR = 'gmail'

// Drops messages Gmail already classified as low-signal.
// Returns true if the message should get a full-body fetch and Sonnet attention.
export function passesPrefilter(msg: GmailMessageMeta): boolean {
  const labels = msg.labelIds ?? []
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) return false
  if (labels.includes('SENT') || labels.includes('SPAM') || labels.includes('TRASH')) return false
  // Bulk senders include List-Unsubscribe; transactional senders from real
  // people do not. This is the single most effective cheap signal.
  if (getHeader(msg, 'List-Unsubscribe')) return false
  return true
}

export interface MappedMessage {
  external_id: string
  thread_id: string
  from_addr: string | null
  from_name: string | null
  to_addrs: string[]
  subject: string | null
  snippet: string | null
  received_at: string | null
  labels: string[]
  body_text: string | null
  importance: 'keep' | 'drop'
}

export function mapMessage(
  msg: GmailMessageFull,
  bodyText: string | null,
  kept: boolean,
): MappedMessage {
  const fromRaw = getHeader(msg, 'From') ?? ''
  const { name: fromName, addr: fromAddr } = parseFrom(fromRaw)
  const toRaw = getHeader(msg, 'To') ?? ''
  const toAddrs = toRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const dateStr = getHeader(msg, 'Date')
  const receivedAt = dateStr
    ? new Date(dateStr).toISOString()
    : msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : null

  return {
    external_id: msg.id,
    thread_id: msg.threadId,
    from_addr: fromAddr,
    from_name: fromName,
    to_addrs: toAddrs,
    subject: getHeader(msg, 'Subject'),
    snippet: msg.snippet ?? null,
    received_at: receivedAt,
    labels: msg.labelIds ?? [],
    body_text: bodyText,
    importance: kept ? 'keep' : 'drop',
  }
}

function parseFrom(raw: string): { name: string | null; addr: string | null } {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (match) {
    return {
      name: match[1].replace(/^"|"$/g, '').trim() || null,
      addr: match[2].trim(),
    }
  }
  const addr = raw.trim()
  return { name: null, addr: addr || null }
}

export interface SyncOutcome {
  inserted: number
  updated: number
  unchanged: number
}

export async function reconcile(
  client: SupabaseClient,
  userId: string,
  mapped: MappedMessage[],
): Promise<SyncOutcome> {
  if (mapped.length === 0) return { inserted: 0, updated: 0, unchanged: 0 }

  const externalIds = mapped.map((m) => m.external_id)
  const { data: existing, error: selectError } = await client
    .from('inbound_messages')
    .select('id, external_id, importance, body_text')
    .eq('user_id', userId)
    .eq('connector', CONNECTOR)
    .in('external_id', externalIds)
  if (selectError) throw new Error(`select inbound_messages: ${selectError.message}`)

  const existingByExtId = new Map<
    string,
    { id: string; importance: string; body_text: string | null }
  >()
  for (const row of (existing ?? []) as Array<{
    id: string
    external_id: string
    importance: string
    body_text: string | null
  }>) {
    existingByExtId.set(row.external_id, row)
  }

  const toInsert: Array<MappedMessage & { user_id: string; connector: string }> = []
  const toUpdate: Array<{ id: string; patch: { body_text: string | null; importance: string } }> =
    []
  let unchanged = 0

  for (const m of mapped) {
    const ex = existingByExtId.get(m.external_id)
    if (!ex) {
      toInsert.push({ ...m, user_id: userId, connector: CONNECTOR })
      continue
    }
    if (ex.importance === m.importance && ex.body_text === m.body_text) {
      unchanged++
      continue
    }
    toUpdate.push({ id: ex.id, patch: { body_text: m.body_text, importance: m.importance } })
  }

  if (toInsert.length > 0) {
    const { error } = await client.from('inbound_messages').insert(toInsert)
    if (error) throw new Error(`insert inbound_messages: ${error.message}`)
  }
  for (const u of toUpdate) {
    const { error } = await client
      .from('inbound_messages')
      .update(u.patch)
      .eq('id', u.id)
    if (error) throw new Error(`update inbound_message ${u.id}: ${error.message}`)
  }

  return { inserted: toInsert.length, updated: toUpdate.length, unchanged }
}
