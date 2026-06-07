# Lila Core

**The runtime that powers the attention layer.** Memory, model routing,
scheduling, proactive execution. Open source.

Two layers between a person and the rest of their tools have been missing
this whole time — the layer that holds the model of what matters, and the
layer that acts on it without being asked. Lila Core builds both.

For the full thinking behind this project, see [`MANIFESTO.md`](./MANIFESTO.md).
For a concrete look at what the system produces, see
[`WORKING_MEMORY_EXAMPLE.md`](./WORKING_MEMORY_EXAMPLE.md). For the
implementation deep-dive, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
For the production hardening path, see
[`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md) and
[`EVALS.md`](./EVALS.md).

[lila.sh](https://lila.sh) is this engine. [lila.surf](https://lila.surf)
is the consumer iOS app — the reference surface — built on top of it.

## Two primitives

```text
  surfaces            runtime              memory
  iOS                 consolidator         working_memory
  web         ───►    model router   ───►  postgres
  ...                 scheduler            + semantic recall
                      proactive ops        + source receipts
                          ▲
                          │
                       cron + on-demand
```

### 1. Memory that actually persists

Salience-scored, source-stamped, nightly-consolidated working memory.
Not a chat app's bolted-on "memory feature" that forgets what matters
and remembers what doesn't. A real substrate: classify on capture,
shape into typed records, distill into long-term facts, consolidate
into a structured working-memory snapshot, anchor every surfaced
bullet back to its source rows.

See [`prompts/working-memory/`](./prompts/working-memory/) and
[`supabase/functions/memory-consolidate/`](./supabase/functions/memory-consolidate/).

### 2. Attention itself

The runtime that uses that memory to notice without being asked.
Working memory becomes the home screen — focus items, a date-sorted
agenda, and proactive suggestions Lila infers from what she can see.
Tapping a bullet anchors a conversation, where Lila can act on the
substrate through tools (create/resolve tasks, dismiss email clusters,
fetch full email bodies, correct memory) rather than just describing
what to do. A proactive scan runs after every consolidation and
queues push candidates that get delivered on the user's clock — not
the engagement-loop's. No streaks. No daily-active manipulation. The
model is the product.

See [`supabase/functions/conversation-*`](./supabase/functions/),
[`supabase/functions/memory-proactive-scan/`](./supabase/functions/memory-proactive-scan/),
and [`supabase/functions/proactive-*`](./supabase/functions/).

## Repository layout

```text
prompts/working-memory/
  system.md              Voice. Stable.
  consolidate.md         Reference structure prompt (TypeScript copy lives in supabase/functions/_shared/prompts/).
  schema.json            JSON Schema for the consolidation output.
  sample-input.json      Synthetic week of activity for prompt iteration.

supabase/
  config.toml                          Edge Functions config. Functions deploy via `supabase functions deploy`.
  functions/_shared/
    voice.ts                           Single source of truth for Lila's voice; every Sonnet prompt imports it.
    client.ts                          Anthropic client + model identifiers.
    scopedSupabase.ts                  RLS-safe wrapper that auto-scopes by user_id.
    http.ts                            CORS, JSON, error mapping.
    json.ts                            Robust JSON extraction from model responses.
    apns.ts                            APNs HTTP/2 helper for the proactive layer.
    tools/index.ts                     Conversation tool-use verbs (create/resolve task, dismiss cluster, fetch email body, correct memory).
    prompts/
      classify.ts                      Capture type classifier (Haiku).
      shape_task.ts / shape_note.ts /
      shape_memory.ts / shape_bookmark.ts
      extract_tasks.ts                 Pull embedded actions out of long captures.
      consolidation.ts                 Working-memory consolidation.
      conversation.ts                  Streaming conversation system prompt.
      proactive_scan.ts                Generates push candidates after consolidation.
      morning_brief.ts                 Body of the optional morning brief push.
      inbound_triage.ts                Clusters Gmail messages + judges urgency (1.1).
  functions/
    capture-classify/                  POST /capture/classify          (Haiku)
    capture-shape/                     POST /capture/shape             (Sonnet)
    capture-distill-memory/            POST /capture/distill-memory
    capture-extract-tasks/             POST /capture/extract-tasks
    capture-summarize-url/             POST /capture/summarize-url
    memory-consolidate/                POST /memory/consolidate        (also builds agenda_items + suggestions)
    memory-refresh/                    POST /memory/refresh            (manual trigger)
    memory-proactive-scan/             POST /memory/proactive-scan     (chained from consolidate)
    memory-retrieve/                   POST /memory/retrieve           (semantic recall for conversation)
    conversation-send/                 POST /conversation/send         (SSE streaming; tool-use loop)
    conversation-anchor/               POST /conversation/anchor       (seed from a tapped bullet)
    connectors-calendar-sync/          POST /connectors/calendar/sync  (called from iOS EventKit)
    connectors-gmail-sync/             Cron, every 15 min — server-side Gmail pull (1.1).
    connectors-gmail-oauth/            POST /connectors/gmail/oauth    — code→token exchange (1.1).
    connectors-google-calendar-sync/   Cron, every 30 min — server-side Google Calendar pull (1.1).
    connectors-google-calendar-oauth/  POST — Google Calendar code→token exchange (1.1).
    inbound-triage/                    POST /inbound-triage            — cluster + judge Gmail messages (1.1).
    push-register/                     POST /push/register             (APNs token)
    push-test/                         POST /push/test                 (dev only)
    account-delete/                    POST /account/delete            (full user-data deletion)
    proactive-deliver/                 Cron, every 5 min — drains proactive_events queue.
    proactive-morning-brief/           Cron, hourly — generates morning brief candidates.
    proactive-calendar-imminent/       Cron, every 15 min — scans for events 15-30 min ahead.

src/                                   Two primitives, named.
  memory/                              Persistence, salience, source receipts, consolidation. Local CLI for prompt iteration.
  attention/                           Noticing, scheduling, proactive surfacing. Runtime lives in supabase/functions/proactive-*; this directory documents the conceptual home.
  connectors/
    google-calendar/                   Google Calendar OAuth connector (1.1).
    gmail/                             Gmail OAuth connector — auth, fetch, sync (1.1).
scripts/                               Local CLI helpers — `wm:consolidate*`. Useful for prompt-tuning.
src/eval/                              Golden-set checks for working-memory regressions.
ADR/                                   Architecture Decision Records — short writeups of non-obvious choices.
```

The CLI scripts in `src/memory/` and `scripts/` predate the Edge Functions and
exist for prompt iteration without round-tripping through the deployed
runtime. **In production, the Edge Functions are the runtime.** The 1.0
spec is explicit: no Railway, no long-running Node processes outside of
Edge Functions.

## Stack

- TypeScript / Deno (Edge Functions runtime)
- Node 20+ for the local CLI scripts
- `@anthropic-ai/sdk` — Claude calls with prompt caching on the system prompt
- `@supabase/supabase-js` — RLS-aware reads and writes
- APNs HTTP/2 for the proactive layer

## Run a function locally

```bash
supabase functions serve capture-shape \
  --env-file ./.env.local \
  --no-verify-jwt   # local testing only
```

`./.env.local` should set `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`. For the proactive
worker also set `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`,
`APNS_BUNDLE_ID`. For the Gmail connector (1.1) also set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Output contract

`working_memory` rows are one-row-per-user (jsonb columns + `generated_at`).
Each bullet carries `source_ids: [{table, id}, …]` — the receipts the
iOS tap-to-expand sheet resolves against the underlying source rows.
A reader can always trace a surfaced bullet back to the captures it
came from. See [`WORKING_MEMORY_EXAMPLE.md`](./WORKING_MEMORY_EXAMPLE.md).

## Evals

Working-memory regressions are checked with a deterministic golden set:

```bash
npm run eval:wm
```

The evaluator catches missing or hallucinated receipts, too-fresh quiet
items, second-person copy, banned voice phrases, structural drift, and
scenario-specific expectations. See [`EVALS.md`](./EVALS.md).

## Connectors

**1.0 — Apple Calendar via EventKit only.** iOS pushes events in;
`connectors-calendar-sync` reconciles them into the `events` table.

**1.1 — Gmail (server-side pull).** The connector code and edge functions
are implemented in this repo (`src/connectors/gmail/`,
`connectors-gmail-sync`, `connectors-gmail-oauth`, `inbound-triage`).
Activation requires the lila-ios migrations (`connector_accounts`,
`inbound_messages`, `inbound_clusters`) and the iOS OAuth connect flow.
Triage clusters messages and tags each one (`is_scheduled`, `is_delivery`,
`action_needed`) so dated events flow to the agenda, deliveries get their
own treatment, and only genuine action items compete for focus.
See [`PROACTIVE_EMAIL.md`](./PROACTIVE_EMAIL.md) and
[`ADR/ADR-003`](./ADR/ADR-003-proactive-email-ingest.md).

**1.1 — Google Calendar (server-side pull).** Implemented alongside Gmail
(`src/connectors/google-calendar/`, `connectors-google-calendar-sync`,
`connectors-google-calendar-oauth`). Native iOS OAuth (reversed-client-ID
redirect, no client secret); the same iOS Google client serves both Gmail
and Calendar scopes. Events reconcile into the `events` table on a 30-minute
cron, deduped on `(user_id, connector, external_id)` like Apple Calendar.

Reminders remain deferred to 1.1+.

## Reading order, if you're forking

1. [README](./README.md) — the category claim.
2. [MANIFESTO](./MANIFESTO.md) — the longer essay it points to.
3. [ARCHITECTURE](./ARCHITECTURE.md) — runtime, schema, and the prompt split.
4. [CASE_STUDY](./CASE_STUDY.md) — one synthetic user's first day, end-to-end.
5. [WORKING_MEMORY_EXAMPLE](./WORKING_MEMORY_EXAMPLE.md) — what the model emits.
6. [ROADMAP](./ROADMAP.md) — what's on, what's off.

## License

MIT. See [`LICENSE`](./LICENSE). Issues open. PRs may be slow to merge
while 1.0 is shipping; see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
