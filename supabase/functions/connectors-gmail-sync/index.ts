// POST /connectors-gmail-sync
// Service-role only. Cron-fired every 15 minutes.
//
// For each user with a connected Gmail account:
//   1. Exchange refresh_token → access_token.
//   2. Pull new message IDs via historyId cursor (falls back to query on first run).
//   3. Fetch metadata; run prefilter.
//   4. Fetch full body only for prefilter survivors.
//   5. Reconcile into inbound_messages.
//   6. Advance the historyId cursor.
//   7. Chain inbound-triage for this user.
//
// Errors for individual users are logged but don't fail the whole run —
// one revoked token should not block everyone else.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse } from '../_shared/http.ts'
import { exchangeRefreshToken } from '../../../src/connectors/gmail/auth.ts'
import {
  listNewMessageIds,
  fetchMessageMeta,
  fetchMessageFull,
  extractBodyText,
} from '../../../src/connectors/gmail/fetch.ts'
import { mapMessage, passesPrefilter, reconcile } from '../../../src/connectors/gmail/sync.ts'

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '__never__')) {
    throw new HttpError(403, 'service-role only')
  }

  const { data: accounts, error: acctErr } = await adminSupabase
    .from('connector_accounts')
    .select('user_id, refresh_token, history_id')
    .eq('provider', 'gmail')
    .eq('status', 'connected')
  if (acctErr) throw new HttpError(500, `load accounts: ${acctErr.message}`)
  if (!accounts || accounts.length === 0) return jsonResponse({ users: 0 })

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

  const results = await Promise.allSettled(
    (
      accounts as Array<{
        user_id: string
        refresh_token: string
        history_id: string | null
      }>
    ).map((acct) => syncUser(acct, clientId, clientSecret)),
  )

  const ok = results.filter((r) => r.status === 'fulfilled').length
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason?.message ?? 'unknown')
  if (errors.length > 0) console.error('gmail-sync user errors:', errors)

  return jsonResponse({ users: accounts.length, ok, failed: errors.length })
}))

async function syncUser(
  acct: { user_id: string; refresh_token: string; history_id: string | null },
  clientId: string,
  clientSecret: string,
) {
  const { token } = await exchangeRefreshToken(clientId, clientSecret, acct.refresh_token)

  const { messageIds, newHistoryId } = await listNewMessageIds(token, acct.history_id)

  if (messageIds.length === 0) {
    if (newHistoryId && newHistoryId !== acct.history_id) {
      await advanceCursor(acct.user_id, newHistoryId)
    }
    return { user_id: acct.user_id, new_messages: 0 }
  }

  // Fetch metadata for all new message IDs in parallel (bounded batch).
  const metaBatch = await Promise.all(messageIds.map((id) => fetchMessageMeta(token, id)))

  // Two buckets: messages that pass the prefilter get full bodies; others are
  // recorded as importance='drop' with metadata only (no body storage).
  const survivors = metaBatch.filter(passesPrefilter)
  const dropped = metaBatch.filter((m) => !passesPrefilter(m))

  const keptMapped = await Promise.all(
    survivors.map(async (meta) => {
      const full = await fetchMessageFull(token, meta.id)
      return mapMessage(full, extractBodyText(full), true)
    }),
  )
  const droppedMapped = dropped.map((meta) => mapMessage(meta as any, null, false))

  await reconcile(adminSupabase, acct.user_id, [...keptMapped, ...droppedMapped])

  if (newHistoryId) await advanceCursor(acct.user_id, newHistoryId)

  // Chain inbound-triage now that new messages are in the DB.
  await triggerInboundTriage(acct.user_id)

  return { user_id: acct.user_id, new_messages: messageIds.length, kept: survivors.length }
}

async function advanceCursor(userId: string, historyId: string) {
  await adminSupabase
    .from('connector_accounts')
    .update({ history_id: historyId, last_synced_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', 'gmail')
}

async function triggerInboundTriage(userId: string) {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/inbound-triage`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!res.ok) {
    console.error(`inbound-triage trigger failed for ${userId}: ${res.status}`)
  }
}
