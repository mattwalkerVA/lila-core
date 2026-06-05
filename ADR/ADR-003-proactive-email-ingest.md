# ADR-003 — Proactive email ingest via server-side Gmail pull

**Status:** Proposed · **Date:** 2026-06

## Context

The product promise is that Lila does work the user didn't ask for. The
sharpest version of that promise is email: a parent gets three separate
messages about next week's day-camp and should not have to open an
assistant and ask it to assemble the details. Lila should notice that the
three messages are one thing, that the thing is dated and important, and
surface it once — unprompted.

Gmail was deferred past 1.0 (README, ROADMAP, ARCHITECTURE "What's not in
1.0"). The attention pipeline that would carry email — consolidation,
`proactive_events`, the delivery worker with its rate limits, the
tap-to-anchor conversation — already exists and is connector-agnostic. The
question this ADR settles is *how email enters the system and how
aggressively it surfaces*, not whether the downstream machinery exists.

Two ingestion patterns already live in the repo: iOS pushes data in
(`connectors-calendar-sync`, EventKit) and a server-side OAuth pull
(`src/connectors/google-calendar/`). The full design is in
[PROACTIVE_EMAIL.md](../PROACTIVE_EMAIL.md); this ADR records the load-
bearing decisions.

## Decision

1. **Ingest by server-side Gmail pull on a cron**, modeled on the
   google-calendar connector, *not* by having iOS post mail in. A new
   `connectors-gmail-sync` service-role function pulls deltas (Gmail
   `historyId` cursor) every ~15 minutes and reconciles into a new
   `inbound_messages` table.

2. **Read-only.** OAuth scope is `gmail.readonly`. No connector verb ever
   sends, deletes, or modifies mail. A one-way mirror is a deliberate
   non-capability.

3. **A model decides what's one thing.** A new chained Sonnet pass,
   `inbound-triage`, groups related messages into `inbound_clusters`
   (thread id is a prior, not the answer — the camp case is three threads),
   and emits a per-cluster judgment: summary, urgency, `due_at` (only if
   present in the text), and whether action is owed.

4. **Two surfaces, one high threshold.** Clusters default to the **home
   screen** via consolidation (no interruption). A cluster earns a push —
   the new `important_inbound` proactive category — only when it is *both*
   action-needed *and* dated within ~7 days. The push category inherits the
   ≤3/day hard cap, gets a ≤1/day sub-cap, and a default-on but toggleable
   preference flag. When in doubt, no push.

5. **Per-user encrypted OAuth state.** Refresh tokens live in a new
   `connector_accounts` table, encrypted at rest — not the single-token-
   in-env model the dogfood calendar connector used.

## Why

- **"Lila should do it" means the app being closed can't matter.** The
  iOS-push pattern only runs when the app is open. A server-side pull runs
  on its own clock. That is the difference between a feature the user
  triggers and one that triggers itself.

- **Clustering is the actual new problem, and it's a model problem.** Three
  camp emails arrive as separate threads from overlapping senders. Rules
  and `thread_id` don't collapse them; judgment does. Putting a Sonnet pass
  where the novelty is — and reusing the existing queue/delivery/anchor
  rails for everything else — keeps the new surface area small.

- **Email is the most sensitive data the system has touched, so the bar
  for interrupting must be higher than the inbox's own.** Most important
  mail is important but not urgent. Routing the default to the silent home
  screen and reserving push for *dated, action-needed* clusters keeps faith
  with "the default is silence" while still catching the camp case, which
  genuinely is urgent. Read-only scope, body-storage minimization with a
  retention window, and encrypted tokens bound the blast radius.

## Consequences

- New tables (`connector_accounts`, `inbound_messages`, `inbound_clusters`)
  and a `notification_preferences.important_inbound_enabled` column. Per
  `config.toml`, the migration is authored in the lila-ios repo.
- New lila-core surface: `src/connectors/gmail/`, the `connectors-gmail-sync`
  and `inbound-triage` functions, a `connectors-gmail-oauth` exchange, a
  `loadInputs` change in consolidation, and three lines of category wiring
  in `proactive-deliver`.
- A new trust boundary. Email bodies are attacker-controlled text entering
  a prompt; triage treats them as data, never instructions, and the
  conversation tool-use loop stays gated to its existing low-risk verbs.
- ADR-001 (no pgvector) and ADR-002 (one continuous conversation) are
  untouched: clustering is recency-windowed and prompted, and clusters
  anchor into the same single thread.

## Revisit when

- Clustering precision plateaus on category tabs + Sonnet and the next
  obvious lever is embeddings over message bodies (intersects ADR-001).
- A second mail provider (or a non-mail inbound source) lands and the
  `inbound_messages` / `inbound_clusters` shapes need to generalize beyond
  Gmail.
- Users report the `important_inbound` threshold is either too quiet
  (missed a real deadline) or too loud (pushed a dateless FYI) — the
  threshold in decision #4 is the first dial to turn.
