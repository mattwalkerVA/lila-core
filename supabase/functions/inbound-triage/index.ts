// POST /inbound-triage
// Body: { user_id }
// Service-role only. Chained from connectors-gmail-sync after new messages
// are reconciled into inbound_messages.
//
// What this does:
//   1. Load recent untriaged messages with importance='keep'.
//   2. Load existing open clusters as folding context.
//   3. Run Sonnet: cluster related messages + judge each cluster.
//   4. Upsert inbound_clusters on (user_id, cluster_key).
//   5. Update inbound_messages.cluster_id + triaged_at.
//   6. For clusters that meet the push threshold, emit proactive_events.
//
// Triage describes; the threshold decides. No push decision in the prompt.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, hasServiceRole, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { inboundTriageSystem, inboundTriageUser } from '../_shared/prompts/inbound_triage.ts'

interface Body {
  user_id: string
}

interface TriageCluster {
  cluster_key: string
  title: string
  summary: string
  urgency: number
  due_at: string | null
  action_needed: boolean
  message_ids: string[]  // Gmail external IDs
}

const DEFAULT_HORIZON_DAYS = 14

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!hasServiceRole(auth)) {
    throw new HttpError(403, 'service-role only')
  }
  const body = await readJson<Body>(req)
  if (!body.user_id) throw new HttpError(400, 'user_id required')
  const userId = body.user_id

  // Load untriaged kept messages from the last 14 days, newest first,
  // capped at 30 per run. The sync cron calls triage after every sync,
  // so a backlog drains over successive runs without overflowing context.
  const since = new Date(Date.now() - 14 * 86400_000).toISOString()
  const { data: newMessages, error: msgErr } = await adminSupabase
    .from('inbound_messages')
    .select('id, external_id, thread_id, from_addr, from_name, subject, snippet, body_text, received_at, labels')
    .eq('user_id', userId)
    .eq('importance', 'keep')
    .is('triaged_at', null)
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(30)
  if (msgErr) throw new HttpError(500, `load messages: ${msgErr.message}`)
  if (!newMessages || newMessages.length === 0) return jsonResponse({ clusters: 0, pushed: 0 })

  // Load existing open clusters as folding context for the model.
  const { data: openClusters } = await adminSupabase
    .from('inbound_clusters')
    .select('cluster_key, title, summary, urgency, due_at, action_needed, status, last_message_at')
    .eq('user_id', userId)
    .in('status', ['open', 'surfaced'])
    .order('last_message_at', { ascending: false })
    .limit(20)

  // Load user profile for voice rendering and horizon preference.
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('first_name')
    .eq('id', userId)
    .single()
  const firstName = profile?.first_name ?? 'there'

  const { data: pref } = await adminSupabase
    .from('notification_preferences')
    .select('important_inbound_enabled, important_inbound_horizon_days')
    .eq('user_id', userId)
    .single()
  const horizonDays: number = (pref as any)?.important_inbound_horizon_days ?? DEFAULT_HORIZON_DAYS
  const inboundEnabled: boolean = (pref as any)?.important_inbound_enabled ?? true

  // Truncate body_text before sending to the model — first 600 chars is
  // enough for triage; full bodies balloon the context and can truncate the
  // JSON response against max_tokens.
  const messagesForModel = (newMessages as Array<Record<string, unknown>>).map((m) => ({
    ...m,
    body_text: typeof m.body_text === 'string' && m.body_text.length > 600
      ? m.body_text.slice(0, 600) + '…'
      : m.body_text,
  }))

  // Use tool_use so output goes through Anthropic's constrained JSON decoder —
  // this eliminates parse fragility from unicode characters or control chars
  // that models occasionally emit in free-form JSON output.
  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: [{ type: 'text', text: inboundTriageSystem(firstName), cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'report_triage',
      description: 'Report the triage results for the provided messages.',
      input_schema: {
        type: 'object' as const,
        properties: {
          clusters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cluster_key: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                urgency: { type: 'number' },
                due_at: { type: 'string', nullable: true },
                action_needed: { type: 'boolean' },
                message_ids: { type: 'array', items: { type: 'string' } },
              },
              required: ['cluster_key', 'title', 'summary', 'urgency', 'due_at', 'action_needed', 'message_ids'],
            },
          },
        },
        required: ['clusters'],
      },
    }],
    tool_choice: { type: 'tool', name: 'report_triage' },
    messages: [{
      role: 'user',
      content: inboundTriageUser(
        JSON.stringify(messagesForModel, null, 2),
        JSON.stringify(openClusters ?? [], null, 2),
      ),
    }],
  })
  const toolUse = r.content.find((c: any) => c.type === 'tool_use')
  if (!toolUse) throw new HttpError(500, 'triage: no tool_use in response')
  const clusters: TriageCluster[] = Array.isArray((toolUse as any).input?.clusters)
    ? (toolUse as any).input.clusters
    : []

  if (clusters.length === 0) {
    await markTriaged(userId, newMessages.map((m: any) => m.id), null)
    return jsonResponse({ clusters: 0, pushed: 0 })
  }

  // Build a lookup of Gmail external_id → DB row id for the new messages.
  const dbIdByExternalId = new Map<string, string>()
  for (const m of newMessages as Array<{ id: string; external_id: string }>) {
    dbIdByExternalId.set(m.external_id, m.id)
  }

  const now = new Date()
  const horizonMs = horizonDays * 86400_000
  let pushed = 0

  for (const cluster of clusters) {
    // Resolve the DB message IDs from the Gmail external IDs the model returned.
    const dbMessageIds = cluster.message_ids
      .map((eid) => dbIdByExternalId.get(eid))
      .filter((id): id is string => !!id)

    const lastMessageAt = resolveLastMessageAt(
      newMessages as Array<{ external_id: string; received_at: string | null }>,
      cluster.message_ids,
    )

    // Upsert the cluster. On conflict (same user+key), update fields so a
    // new message folding into an existing cluster updates it in-place.
    const { data: upserted, error: upsertErr } = await adminSupabase
      .from('inbound_clusters')
      .upsert(
        {
          user_id: userId,
          cluster_key: cluster.cluster_key,
          title: cluster.title,
          summary: cluster.summary,
          urgency: cluster.urgency,
          due_at: cluster.due_at ?? null,
          action_needed: cluster.action_needed,
          message_ids: dbMessageIds,
          last_message_at: lastMessageAt,
          // first_seen_at is set only on insert (handled by DB default or we preserve it)
        },
        { onConflict: 'user_id,cluster_key' },
      )
      .select('id, status')
      .single()
    if (upsertErr) {
      console.error(`upsert cluster ${cluster.cluster_key}: ${upsertErr.message}`)
      continue
    }

    const clusterId = (upserted as any)?.id as string
    const clusterStatus = (upserted as any)?.status as string

    // Link messages to the cluster and mark them triaged.
    if (dbMessageIds.length > 0) {
      await adminSupabase
        .from('inbound_messages')
        .update({ cluster_id: clusterId, triaged_at: now.toISOString() })
        .eq('user_id', userId)
        .in('id', dbMessageIds)
    }

    // Push threshold: action_needed + dated within horizon + not already surfaced.
    if (
      inboundEnabled &&
      cluster.action_needed &&
      cluster.due_at &&
      clusterStatus === 'open' &&
      withinHorizon(cluster.due_at, now, horizonMs)
    ) {
      const pushBody = buildPushBody(cluster)
      const sourceIds = dbMessageIds.map((id) => ({ table: 'inbound_messages', id }))
      const { error: pushErr } = await adminSupabase.from('proactive_events').insert({
        user_id: userId,
        category: 'important_inbound',
        body: pushBody,
        source_ids: sourceIds,
        anchor_message: buildAnchorMessage(cluster),
        scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString(),
      })
      if (pushErr) {
        console.error(`insert proactive_event for ${cluster.cluster_key}: ${pushErr.message}`)
      } else {
        // Mark surfaced so a re-run of triage doesn't re-alert.
        await adminSupabase
          .from('inbound_clusters')
          .update({ status: 'surfaced' })
          .eq('id', clusterId)
        pushed++
      }
    }
  }

  // Mark any new messages not assigned to a cluster as triaged (they were
  // dropped by the model as not worth clustering — still need triaged_at
  // set so they don't show up in the next run's untriaged set).
  const assignedExternalIds = new Set(clusters.flatMap((c) => c.message_ids))
  const unassignedDbIds = (newMessages as Array<{ id: string; external_id: string }>)
    .filter((m) => !assignedExternalIds.has(m.external_id))
    .map((m) => m.id)
  if (unassignedDbIds.length > 0) {
    await markTriaged(userId, unassignedDbIds, null)
  }

  return jsonResponse({ clusters: clusters.length, pushed })
}))

function withinHorizon(dueDateStr: string, now: Date, horizonMs: number): boolean {
  const due = Date.parse(dueDateStr)
  if (Number.isNaN(due)) return false
  return due >= now.getTime() && due <= now.getTime() + horizonMs
}

function resolveLastMessageAt(
  messages: Array<{ external_id: string; received_at: string | null }>,
  externalIds: string[],
): string {
  const idSet = new Set(externalIds)
  const dates = messages
    .filter((m) => idSet.has(m.external_id) && m.received_at)
    .map((m) => m.received_at as string)
  dates.sort()
  return dates[dates.length - 1] ?? new Date().toISOString()
}

// Build a ≤140-char push body in Lila's voice from the cluster summary.
function buildPushBody(cluster: TriageCluster): string {
  const text = cluster.summary.split('.')[0]  // first sentence
  return text.length <= 140 ? text : text.slice(0, 137) + '...'
}

function buildAnchorMessage(cluster: TriageCluster): string {
  return `Pulled up: ${cluster.title}. ${cluster.summary}`
}

async function markTriaged(userId: string, dbIds: string[], clusterId: string | null) {
  if (dbIds.length === 0) return
  await adminSupabase
    .from('inbound_messages')
    .update({
      triaged_at: new Date().toISOString(),
      ...(clusterId ? { cluster_id: clusterId } : {}),
    })
    .eq('user_id', userId)
    .in('id', dbIds)
}
