# Roadmap

`lila-core` evolves alongside the iOS app. Anything below 1.1 is locked.
Anything below 1.2 is intent, not commitment.

## 1.0 — what's here

- Two primitives running end-to-end: memory persistence (consolidation,
  source receipts, working memory) and attention (proactive scan, morning
  brief, calendar imminent).
- 23 Edge Functions covering capture, memory, conversation, connectors,
  push.
- Working memory renders three surfaces: focus items, a date-sorted
  agenda (`agenda_items`, built mechanically), and proactive suggestions
  (`suggestions`, model-generated).
- Connectors: Apple Calendar (EventKit), Google Calendar (server-side
  pull, native iOS OAuth), and Gmail (server-side pull + triage).
- One conversation per user, ever (DB-enforced).
- Conversation tool-use loop for low-risk substrate actions (create/resolve
  task, dismiss cluster, fetch email body, correct memory), with audit
  receipts persisted on assistant messages.
- Working-memory golden-set eval harness for source receipts, quiet-item
  age, voice drift, and structural regressions.
- Forward-compatible vector(1024) columns; lexical retrieval wired behind
  a feature flag, vector backfill scripted.

## 1.1 — next

- **Drift category notifications.** Schema is already present; delivery
  is gated until the crisis-content sub-brief lands. Drift surfaces
  emotional patterns ("you've been quiet about Susanna for 9 days"), so
  the prompt design has higher stakes than any other category.
- **Tool use expansion.** The loop exists for low-risk substrate verbs.
  Next is undo, snooze, richer update summaries, and eval coverage for
  tool-selection mistakes.
- **Inbound eval goldens.** The Gmail connector shipped without a golden
  set for triage (clustering, `is_scheduled`/`is_delivery`/`action_needed`
  classification, no-alert fixtures). Add these to match the working-memory
  harness's coverage.
- **Vector retrieval over conversation history.** Lexical retrieval and the
  `memory_accesses` audit log are wired behind `LILA_MEMORY_RETRIEVAL_ENABLED`;
  vector backfill is scripted. Next: flip vector search on by default in
  `conversation-send` once `conversation_messages` volume warrants it.

## 1.2 — likely

- **Reminders + Things connector** for users who already track tasks
  there. Read-only sync into `tasks` so consolidation sees them.
- **Reflection prompts.** Lila proposes a reflection on a Sunday evening
  if the week had specific things worth marking down. Generated at the
  same moment as proactive candidates; surfaced in the home screen
  rather than as a push.
- **Web client.** Same protocol, different UI. Specifically not a chat
  interface — the home screen renders identically to iOS, conversation
  is also a pulled-up surface. The `lila-core` HTTP/SSE protocol is the
  contract; clients conform.

## Held — not on the roadmap

- **Engagement features.** Streaks, badges, daily check-ins, "you
  haven't opened Lila in 3 days" pushes. These are explicitly off the
  table in the spec and stay off here.
- **Marketing pushes.** Feature announcements, "tap to try X." Same.
- **Multi-modal capture.** Images, audio storage. The voice capture in
  iOS 1.0 is text transcription only; audio is never stored.
- **Multi-thread conversation.** One thread, forever. The constraint is
  load-bearing for the model's coherence; multiple threads make Lila
  legible at the cost of making her shallow.

## Working in this repo

If you're forking, the cleanest read is:

1. [README](./README.md) — the category claim.
2. [MANIFESTO](./MANIFESTO.md) — the longer essay it points to.
3. [ARCHITECTURE](./ARCHITECTURE.md) — the runtime, schema, and prompt split.
4. [CASE_STUDY](./CASE_STUDY.md) — one synthetic user's first day,
   end-to-end.
5. [`prompts/working-memory/`](./prompts/working-memory/) — the
   highest-leverage prompt in the system, in markdown for iteration.

Open issues and PRs welcome. The single-author posture of `CONTRIBUTING.md`
holds through 1.0; if that changes, this file changes first.
