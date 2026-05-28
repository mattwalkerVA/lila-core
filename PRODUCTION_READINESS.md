# Production Readiness

This is the build order that keeps Lila aligned with the manifesto: memory
first, attention second, surface polish only where it makes those two visible.

## P0 — Ship What Already Exists

- Tool-use loop deployed in `conversation-send`.
- iOS renders tool-call chips under assistant replies.
- `conversation_messages.tool_calls` migration applied.
- Real device test: "done" in conversation sets `tasks.resolved_at`, renders
  a chip, and persists the audit trail.
- App Store candidate build uses `MARKETING_VERSION=1.0.0`.

## P1 — Trust And Evals

- Working-memory golden set has 30 deterministic cases and runs locally with
  `npm run eval:wm`.
- Prompt/model changes require a before/after eval note.
- `consolidation_runs` stores prompt version, model id, latency, tokens,
  output, input hash, and parse status. Eval score is the next CI-backed
  addition.
- Source-expansion UI is now "why this surfaced" and can resolve receipts
  across captures, tasks, notes, reflections, messages, events, bookmarks,
  memories, and conversation history.
- Conversation tool calls get undo affordances for low-risk substrate edits.

## P2 — Memory v2

Do not start with GraphRAG. Start with boring context engineering:

- Backfill embeddings into existing `vector(1024)` columns.
- Add lexical search over captures, tasks, notes, reflections, messages,
  bookmarks, memories, events, and conversation messages.
- Add adaptive routing in `conversation-send`:
  - fast path: working memory + recent thread;
  - recall path: lexical/vector retrieval + source receipts;
  - hard path: multi-hop retrieval only when query classification requires it.
- Add recall evals before adding a reranker.
- Add reranking only when `recall@50` is high and `context_precision@10` is
  weak.

Current state: lexical retrieval and `memory_accesses` audit logging are wired
behind `LILA_MEMORY_RETRIEVAL_ENABLED`; vector backfill is scripted but should
run only after the embedding provider and rate limits are confirmed.

## P3 — The Product Gets Strange In The Right Way

- **What Changed:** a morning delta between yesterday's and today's working
  memory. New, resolved, resurfaced. Quiet text, not a dashboard.
- **People Threads:** per-person surface with unresolved loops, last mention,
  and source trail.
- **Attention Ledger:** private audit of why Lila sent, suppressed, or skipped
  proactive candidates.
- **Memory Editor:** sparse list of remembered facts with correct/forget
  controls.
- **Sunday Reflection:** generated weekly synthesis on the home screen, never a
  push by default.

## Explicit Non-Moves

- No engagement mechanics.
- No "AI-powered" copy.
- No graph layer until ordinary retrieval fails a concrete multi-hop eval.
- No visually loud dashboard. If a feature cannot be expressed as quiet prose
  plus receipts, it probably does not belong on the first screen.
