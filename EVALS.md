# Evals

Lila's highest-risk failure mode is not a bad answer. It is a bad memory:
something unsourced, too fresh to be "quiet", phrased like a coach, or carried
forward after the underlying record changed.

The eval layer starts with working memory because the home screen is the
product. Conversation, proactive delivery, and retrieval evals should use the
same pattern once those surfaces have enough real traffic.

## Working-memory eval

Run:

```bash
npm run eval:wm
```

This executes deterministic golden cases in
[`src/eval/golden/working-memory.ts`](./src/eval/golden/working-memory.ts)
against the evaluator in
[`src/eval/working-memory.ts`](./src/eval/working-memory.ts).

The evaluator checks:

- structural validity against the same constraints as the consolidation
  schema;
- source receipts that actually exist in the input context or previous
  working memory;
- no second-person home-screen copy;
- banned voice phrases and corporate language;
- quiet items are at least 10 days old;
- scenario-specific expectations, such as required focus phrases and required
  source receipts.

The point is not to prove that the model is "good." It is to catch regressions
that make Lila feel fake.

## Golden set policy

Add a case when any of these happens:

- a real user report exposes a bad surfaced bullet;
- a prompt change alters prioritization;
- a model identifier changes;
- retrieval starts feeding conversation or consolidation;
- a connector adds a new source type.

Do not add broad cases. Add small cases with one load-bearing failure mode.
Good cases look like: "quiet item too fresh", "person thread without an actual
exchange", "deadline invented from vague capture", "carried-forward source
receipt preserved."

## Production targets

Before 1.0 App Store submission:

- `npm run test` and `npm run eval:wm` pass on every release candidate.
- Every committed golden case has a one-sentence reason to exist.
- Any manual prompt/model test that fails gets reduced into a golden case
  before the prompt is edited again.

Before Memory v2:

- Add retrieval recall checks: every retrieved source in a golden query must
  be present by `recall@20`.
- Add context precision checks after reranking lands.
- Track prompt version, model id, latency, token count, parse success, and eval
  score for every consolidation run.
