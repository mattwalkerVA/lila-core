// POST /proactive-morning-brief
// Service-role only. Hourly cron picks up every user whose
// morning_brief_enabled = true and whose local morning_brief_time is
// within the next ~10 minutes. Generates a brief body via Sonnet and
// inserts it into proactive_events with category='morning_brief'.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, hasServiceRole } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { morningBriefSystem, morningBriefUser } from '../_shared/prompts/morning_brief.ts'
import { parseJsonObject } from '../_shared/json.ts'
import { formatLocalTime12, localToday } from '../_shared/time.ts'

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!hasServiceRole(auth)) {
    throw new HttpError(403, 'service-role only')
  }

  // Find users due for a brief in the next ~10 minutes.
  const now = new Date()
  const { data: candidates } = await adminSupabase
    .from('notification_preferences')
    .select('user_id, morning_brief_time, push_token')
    .eq('morning_brief_enabled', true)
  if (!candidates || candidates.length === 0) return jsonResponse({ scheduled: 0 })

  // Each user's brief time is in their local zone — load timezones up front
  // so the window check compares against local wall-clock, not UTC.
  const userIds = candidates.map((c) => c.user_id)
  const { data: tzProfiles } = await adminSupabase
    .from('profiles')
    .select('id, timezone')
    .in('id', userIds)
  const tzByUser = new Map<string, string>(
    (tzProfiles ?? []).map((p: any) => [p.id, p.timezone ?? 'UTC']),
  )

  let scheduled = 0
  for (const c of candidates) {
    if (!c.push_token) continue
    const tz = tzByUser.get(c.user_id) ?? 'UTC'
    if (!isWithinWindow(now, c.morning_brief_time, tz)) continue

    // Look up profile + working memory + today's events.
    const [{ data: profile }, { data: wm }, { data: events }] = await Promise.all([
      adminSupabase.from('profiles').select('first_name, timezone').eq('id', c.user_id).single(),
      adminSupabase.from('working_memory').select('greeting_context, focus_items, people_threads, quiet_items').eq('user_id', c.user_id).maybeSingle(),
      adminSupabase.from('events')
        .select('title, start_at, end_at, attendees, location')
        .eq('user_id', c.user_id)
        .gte('start_at', new Date(now.getTime() - 1 * 3600_000).toISOString())
        .lte('start_at', new Date(now.getTime() + 24 * 3600_000).toISOString())
        .order('start_at', { ascending: true }),
    ])

    const firstName = profile?.first_name ?? 'there'
    const r = await anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 512,
      system: [{ type: 'text', text: morningBriefSystem(firstName), cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: morningBriefUser(JSON.stringify(wm ?? {}, null, 2), JSON.stringify(events ?? [], null, 2), `${localToday(tz)} ${formatLocalTime12(now.toISOString(), tz)}`),
      }],
    })
    const text = (r.content[0] as any).text as string
    const parsed = parseJsonObject<{ body: string; anchor_message: string; source_ids: any[] }>(text)

    await adminSupabase.from('proactive_events').insert({
      user_id: c.user_id,
      category: 'morning_brief',
      body: parsed.body,
      source_ids: parsed.source_ids ?? [],
      anchor_message: parsed.anchor_message ?? null,
      scheduled_for: now.toISOString(),
    })
    scheduled++
  }

  return jsonResponse({ scheduled })
}))

// True if `now` is within ~10 minutes after the user's brief time, compared
// in the user's own timezone. The hourly cron sweeps every user once per
// hour and catches them in their local window.
function isWithinWindow(now: Date, briefTime: string | null, tz: string): boolean {
  if (!briefTime) return false
  const [h, m] = briefTime.split(':').map(Number)
  // "HH:MM" wall-clock in the user's zone.
  const local = now.toLocaleTimeString('sv-SE', {
    timeZone: tz || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
  })
  const [nh, nm] = local.split(':').map(Number)
  const nowMin = nh * 60 + nm
  const target = h * 60 + (m ?? 0)
  const diff = nowMin - target
  return diff >= 0 && diff <= 10
}
