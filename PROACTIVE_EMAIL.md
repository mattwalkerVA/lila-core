# Proactive email — design

> Status: **implemented**. Companion to
> [ADR-003](./ADR/ADR-003-proactive-email-ingest.md). This documents the
> design behind the shipped Gmail connector and the `important_inbound`
> category. Runtime code: `src/connectors/gmail/`, `connectors-gmail-sync`,
> `connectors-gmail-oauth`, `inbound-triage`. One change from the original
> design: triage runs via Anthropic tool-use (not free-form JSON) and tags
> each cluster with `is_scheduled` (genuine calendar event) and
> `is_delivery` (shipment/package) in addition to `action_needed`, so dated
> events flow to the agenda and deliveries get their own treatment.

## The ask, in one sentence

Three separate emails land about next week's kids' day-camp. The user
should not have to ask an AI to pull the details together. Lila notices
that the three are one thing, that the thing is dated and important, and
surfaces it — once, unprompted.

Everything in that sentence except *notices the three are one thing* and
*decides it's worth interrupting for* already exists in the runtime. This
design adds the missing two and reuses the rest.

## What already exists (and why this is mostly wiring)

The attention pipeline today is:

```
captures ─► memory-consolidate ─► working_memory ─► memory-proactive-scan ─► proactive_events ─► proactive-deliver ─► APNs
 (typed     (Sonnet, nightly)     (one row/user)    (Sonnet, chained)        (queue)             (cron, 5 min)
  rows)
```

- `proactive_events` already carries `category`, `body`, `source_ids`,
  `anchor_message`, `scheduled_for`, `delivered_at`, `suppressed_reason`
  (see `supabase/functions/proactive-deliver/index.ts`).
- `proactive-deliver` already enforces the ≤3/day hard cap, per-category
  caps, quiet hours, per-category preference flags, and APNs token
  hygiene. A new category is a row in `CATEGORY_PRIORITY` plus a cap rule
  plus a preference flag — nothing structural.
- Tapping a push already anchors the one continuous conversation with the
  candidate's `source_ids` (`conversation-anchor`). The camp cluster's
  source messages drop straight into that mechanism.
- We already have **two** connector patterns to copy:
  - iOS pushes data in — `connectors-calendar-sync` (EventKit → `events`).
  - Server-side OAuth pull — `src/connectors/google-calendar/`
    (`auth.ts` refresh→access, `fetch.ts` paginated pull, `sync.ts`
    map + idempotent reconcile).

So the new surface area is: a Gmail pull, a place to put messages, a pass
that turns messages into *clusters with a judgment*, and one new
proactive category. The rest is reuse.

## Ingestion: server-side Gmail pull on a cron

We pull from Gmail server-side rather than having iOS push email in. The
iOS-push pattern (calendar) only runs when the app is open; "Lila should
do it" means it runs whether or not the app is open. This mirrors
`src/connectors/google-calendar/` and is the model the ROADMAP already
anticipates for the first non-Apple connector.

New connector tree `src/connectors/gmail/`:

- **`auth.ts`** — `refresh_token → access_token`, same shape as the
  calendar connector's `exchangeRefreshToken`. The difference is multi-user
  (below): the refresh token comes from `connector_accounts`, not env.
- **`fetch.ts`** — Gmail REST. Two calls:
  1. `users.messages.list` with a server-side query that does the cheap
     filtering Gmail gives us for free:
     `q = "is:unread (category:primary OR category:updates) newer_than:14d -category:promotions -category:social"`.
     Page through `nextPageToken`.
  2. `users.messages.get` (`format=metadata` for headers + snippet on the
     first pass; `format=full` only for messages that survive the
     importance prefilter — see Privacy). Use `historyId` as an
     incremental cursor so each run processes deltas, not the whole inbox.
- **`sync.ts`** — `mapMessages()` + `reconcile()` into `inbound_messages`,
  idempotent on `(user_id, connector, external_id)`, exactly like the
  calendar `reconcile`. Re-running is a no-op.

New edge function `connectors-gmail-sync/` — service-role, cron-fired
~every 15 minutes (alongside `proactive-calendar-imminent`). It loops over
users with a connected Gmail account, runs the pull, then chains
`inbound-triage` (below) the way `memory-consolidate` chains
`memory-proactive-scan`.

OAuth scope is **read-only** (`gmail.readonly`). Lila never sends, never
deletes, never marks read. One-way mirror.

## Storage: three tables (owned by the lila-ios migration tree)

Per `supabase/config.toml`, migrations live in the iOS repo. These are the
shapes this design needs; the migration is an iOS-side task (see split
below). All three are RLS-scoped by `user_id` like every other table.

### `connector_accounts`

Per-user OAuth state. The calendar connector's single-refresh-token-in-env
model (see its `auth.ts` comment) does not survive multi-user; email needs
real per-user token storage.

| column | notes |
| --- | --- |
| `user_id` | FK, RLS key |
| `provider` | `'gmail'` |
| `refresh_token` | **encrypted at rest** (pgsodium / Vault), never returned to a client |
| `scopes` | granted scope list |
| `history_id` | incremental sync cursor |
| `status` | `connected` / `revoked` / `error` |
| `connected_at`, `last_synced_at` | observability |

### `inbound_messages`

One row per Gmail message we keep.

| column | notes |
| --- | --- |
| `user_id`, `connector`, `external_id` | unique together; `external_id` = Gmail message id |
| `thread_id` | Gmail thread id — a strong, free clustering prior |
| `from_addr`, `from_name`, `to_addrs` | headers |
| `subject`, `snippet` | always stored |
| `received_at` | header date |
| `labels` | Gmail labels incl. `IMPORTANT`, category tabs |
| `body_text` | nullable; populated only when the message passes the prefilter; retention-purged (see Privacy) |
| `importance` | prefilter output: `drop` / `keep` / `maybe` |
| `cluster_id` | nullable FK to `inbound_clusters` |
| `triaged_at` | set by the triage pass |

### `inbound_clusters`

The unit the user actually sees. The three camp emails collapse to **one**
row here.

| column | notes |
| --- | --- |
| `user_id` | RLS key |
| `cluster_key` | stable hash (e.g. normalized sender-domain + subject-stem + thread set) so re-runs update rather than duplicate |
| `title` | "Summer day-camp — next week" |
| `summary` | distilled, ≤2 sentences, Lila's voice |
| `urgency` | `0–1` |
| `due_at` | nullable; the date the cluster hinges on, if any |
| `action_needed` | bool — does the user owe a reply/decision/payment |
| `message_ids` | the source `inbound_messages` rows → become `source_ids` |
| `status` | `open` / `surfaced` / `resolved` / `dismissed` |
| `first_seen_at`, `last_message_at` | |

## The new pass: `inbound-triage`

A Sonnet pass chained after `connectors-gmail-sync`, structurally a twin of
`memory-proactive-scan`. It is the one genuinely new piece of reasoning.

**Prefilter first (cheap).** Before any Sonnet call, drop with rules +
Gmail's own signals: anything in `category:promotions`/`category:social`,
bulk `List-Unsubscribe` senders, no-reply marketing. This keeps the Sonnet
window small and the cost bounded. Survivors get `format=full` bodies
fetched and `importance='keep'`.

**Then cluster + judge (Sonnet).** Over the recent kept-message window plus
existing open clusters, the prompt:

1. Groups related messages into clusters. `thread_id` is the strong prior;
   beyond it, same sender-org + overlapping subject/topic within a few days
   merges (the three camp emails are often three threads, not one — so
   thread id alone is not enough, which is exactly why this needs a model).
2. For each cluster emits: `title`, `summary` (≤2 sentences, voice rules
   from `_shared/voice.ts`), `urgency 0–1`, `due_at` (only if a concrete
   date is *in the text* — never invented, same hard rule the consolidator
   lives under), `action_needed`, and `message_ids` as receipts.
3. Updates existing clusters by `cluster_key` instead of duplicating, so a
   fourth camp email next day folds into the same cluster rather than
   re-alerting.

Output is written to `inbound_clusters` / `inbound_messages.cluster_id`. No
push decision is made here — triage *describes*; the threshold below
*decides*.

## Two surfaces, one threshold

I'm setting the threshold deliberately against the system's "default is
silence" bar. A cluster reaches **one of two** surfaces:

### Home screen (the quiet default)

Open clusters are fed into `memory-consolidate`'s `loadInputs` as
`recent_activity` items (`kind: 'inbound_cluster'`, `record: {table:
'inbound_clusters', id}`). The consolidator then decides, under its
existing rules, whether the cluster earns a `focus_item` (time-bound) or a
`people_thread` (someone owes a reply). Receipts trace back to the message
rows. **Most important email surfaces here and nowhere else.** No
interruption.

### Push — `important_inbound` (the high bar)

A new proactive category, generated by `inbound-triage` (or a thin scan
after it) into `proactive_events`, but **only** when a cluster is *both
important and time-sensitive*:

- `action_needed = true`, **and**
- `due_at` is present and within the user's **`important_inbound_horizon_days`**
  (default **14**; stored in `notification_preferences`), **and**
- the cluster has not already been surfaced.

The 14-day default is deliberate: camps, travel, and other prep-heavy things
arrive with lead time, and a push on day-of-email is more useful than silence
followed by a scramble. Users who want a tighter window (only same-week
urgencies) can lower it; users who plan further out can raise it. This is the
same planning-horizon intuition as the `today / current / horizon` layer
concept in the task system — the threshold moves with the user's style, not
with a fixed calendar rule.

The camp case clears this: three messages, a concrete date next week, an
implied "be ready / register / pack" action → one push. A monthly
newsletter, a FYI with no date, a thread the user is already replying to →
home screen only, no push. When in doubt, no push. This matches the
`proactive_scan` prompt's "most days the answer is nothing."

Delivery wiring (small, in `proactive-deliver`):

```ts
const CATEGORY_PRIORITY = {
  high_confidence: 0,
  important_inbound: 1,   // new — time-sensitive email beats the brief
  morning_brief: 2,
  forgotten: 3,
  drift: 4,
}
```

- Per-category cap: ≤1/day (`dailyByCat.important_inbound >= 1` →
  `rate_limit_important_inbound`), under the existing ≤3/day hard cap.
- Preference flags in `notification_preferences`:
  - `important_inbound_enabled` — **default on**, user-toggleable. Disabling
    stops the push but not home-screen surfacing.
  - `important_inbound_horizon_days` — **default 14**, integer. Controls how
    far in advance a dated, action-needed cluster earns a push. The threshold
    check is `due_at <= now + horizon_days * 86400_000`.
- Quiet hours, token hygiene, and the hard cap are inherited unchanged.

## Worked example — the camp emails

Two runs of the same scenario, showing why the 14-day default matters.

### Scenario A — emails arrive day-of (June 5, camp June 9)

```
Fri Jun 5  09:12  "Camp Cedar — Week of June 9: drop-off & what to bring"
Fri Jun 5  14:40  "Camp Cedar: signed waiver still needed for [kid]"
Fri Jun 5  16:05  "Reminder: Camp Cedar payment balance due Fri Jun 6"
```

1. `connectors-gmail-sync` pulls all three. Prefilter keeps them.
2. `inbound-triage` clusters into one row:
   `title: "Camp Cedar — week of Jun 9"`,
   `summary: "Three notes from Camp Cedar: what to bring, a missing signed
   waiver, and a balance due Fri Jun 6."`,
   `urgency: 0.9`, `due_at: 2026-06-06`, `action_needed: true`.
3. Threshold: action needed + `due_at` (Jun 6) is 1 day out — well within
   the 14-day horizon → emits one `important_inbound` push.
4. Push: *"Camp Cedar needs three things before the 9th — a signed waiver
   and the balance by Friday."* (≤140 chars).
5. Tap → conversation anchored with all three messages as receipts.
6. Cluster also surfaces as home-screen `focus_item` at next consolidation.

### Scenario B — emails arrive with lead time (May 25, same camp)

```
Mon May 25  10:00  "Camp Cedar — Week of June 9: drop-off & what to bring"
Mon May 25  14:40  "Camp Cedar: signed waiver still needed for [kid]"
Tue May 26  08:05  "Camp Cedar payment due Fri Jun 6"
```

With a hardcoded 7-day window, these would silently route to the home screen
only — `due_at` Jun 6 is 12 days out, outside 7. **With the 14-day horizon
(default), they push on May 25**: same cluster, same urgency, same action
items — just caught early enough to act on.

The user gets the push on May 25. A fourth camp email on June 3 folds into
the cluster by `cluster_key` and does **not** re-alert (already `surfaced`).

## Privacy and trust — the new surface

Email bodies are the most sensitive data this system has touched. New
rules, beyond the existing RLS/scopedSupabase guarantees:

- **Read-only scope.** `gmail.readonly`. Lila cannot send, delete, or
  modify mail.
- **Minimize body storage.** Always store headers + `snippet`. Fetch and
  store full `body_text` only for prefilter survivors. Purge `body_text`
  on a retention window (e.g. 30 days) once the cluster summary exists —
  the distilled `inbound_clusters.summary` is what we keep long-term, not
  raw mail.
- **Encrypt refresh tokens** in `connector_accounts` (pgsodium/Vault),
  never returned to any client. Revocation flips `status` and drops the
  token.
- **One-way.** No connector verb writes back to Gmail, ever. This is a
  deliberate non-capability, like read-only calendar.
- **Untrusted content.** Email bodies are attacker-controlled text going
  into a Sonnet prompt. The triage prompt treats message bodies as data,
  not instructions, and never executes actions from them — it only
  classifies and summarizes. (The conversation tool-use loop stays gated
  to its existing low-risk substrate verbs; inbound content cannot reach
  it without the user.)

## Evals

Extend the working-memory golden harness (`src/eval/`) with inbound
goldens:

- **The camp fixture** — three messages must collapse to exactly one
  cluster, with the correct `due_at` and exactly one push candidate.
- **The no-alert fixtures** — newsletter, dateless FYI, a thread the user
  is already answering → zero push candidates, home-screen-only or nothing.
- **Receipts** — every cluster and every push candidate carries
  `source_ids` resolving to real `inbound_messages` rows (same
  non-negotiable as consolidation).
- **Idempotency** — re-running triage on the same inbox produces no new
  clusters and no second push.

## Work split

### lila-core (this repo)

1. `src/connectors/gmail/` — `auth.ts`, `fetch.ts`, `sync.ts` (+ tests),
   mirroring `src/connectors/google-calendar/`.
2. `supabase/functions/connectors-gmail-sync/` — service-role cron puller,
   chains triage.
3. `supabase/functions/inbound-triage/` + `_shared/prompts/inbound_triage.ts`
   — cluster + judge pass (voice-imported, prompt-cached system).
4. `supabase/functions/connectors-gmail-oauth/` — code→refresh-token
   exchange, writes `connector_accounts`.
5. `memory-consolidate/loadInputs` — fold open clusters into
   `recent_activity`.
6. `proactive-deliver` — add `important_inbound` to priority, cap, and
   preference handling.
7. Eval goldens above.

### lila-ios (separate repo, owns migrations)

1. Migration for `connector_accounts`, `inbound_messages`,
   `inbound_clusters`, and the `important_inbound_enabled` column.
2. Google OAuth connect flow (request `gmail.readonly`, hand the code to
   `connectors-gmail-oauth`).
3. Settings toggle for the `important_inbound` category.
4. Rendering: clusters as home-screen bullets with tap-to-expand to source
   messages; push tap → anchored conversation (already wired by payload).

## Roadmap fit

This is a **1.1** connector (ROADMAP already names Gmail as deferred to
1.1+ and the first non-Apple OAuth connector as next). It does not touch
the locked 1.0 ADRs: no pgvector (ADR-001) and one continuous conversation
(ADR-002) both hold — clusters anchor into the *same* thread. The new
decision is recorded in [ADR-003](./ADR/ADR-003-proactive-email-ingest.md).

## Open questions for review

1. **Body retention window** — 30 days proposed; could be shorter (7) or
   metadata-only with bodies never persisted (re-fetch on tap). Tighter is
   safer but costs a live Gmail call at conversation time.
2. **Prefilter aggressiveness** — start with Gmail category tabs + unread,
   or add a Haiku metadata classifier from day one? Tabs are free and
   decent; Haiku is a known pattern (capture-classify) if tabs prove noisy.
3. **Cron cadence** — 15 min matches calendar-imminent. Tighter (5 min)
   only matters for same-hour deadlines, which are rare for the email case.
4. **Triage vs. consolidation ownership** — keep triage a separate chained
   function (proposed, clean separation) or fold clustering into the
   nightly consolidation pass (fewer functions, but couples email latency
   to the nightly cycle and weakens same-day surfacing).
5. **Horizon default and range** — 14 days proposed as default for
   `important_inbound_horizon_days`. Range: should 7 be the floor (never
   push for things more than a month out) or should users be able to set
   21/30 for longer-lead planning styles? The first dial to tune after
   launch.
