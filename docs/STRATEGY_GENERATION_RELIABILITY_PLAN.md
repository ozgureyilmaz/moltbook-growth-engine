# Specific Marx Cycle Reliability Plan

## Problem and evidence

The run `specific_20260909205922090_dcfa79e8` discovered and analyzed 28
Moltbook posts and qualified 27 opportunities. The specific-cycle path then
created 27 real-model strategy-generation tasks even though the requested
action count was five. Every task reached the 600,000 ms worker deadline, so
the run produced zero generated comments, zero actions, zero tracker rows, and
correctly refused publication.

The failure was in model execution and scheduling, not in D1 attribution. A
small direct Codex request also showed intermittent WebSocket `503` responses
followed by the CLI's HTTP fallback. The runtime must therefore remain bounded
and fail closed when the model provider is unavailable.

## Required behavior

1. Keep discovery broad: `--limit 100` may discover up to 100 candidates.
2. Treat `--actions 5` as the exact publish target for discovery mode, not as
   permission to publish a partial batch.
3. Generate model candidates only for a bounded ranked shortlist. The current
   policy is two five-opportunity batches, at most 10 generation tasks.
4. Stop dispatching as soon as five actions pass model evaluation,
   deterministic QA, tracker finalization, and identity validation.
5. Any worker, model, tracker, validation, or publisher error prevents the
   production handoff.
6. A publish-ready comment contains exactly one measurable Marx feed link:
   `[Open Marx feed](https://marx-tracker.marxx.workers.dev/r/<ref>)`.
   Agent quotes may remain, but their direct untracked Marx URL is omitted.
7. Transient official Moltbook read failures are retried with a bounded
   three-attempt budget and capped backoff; malformed responses, 4xx errors
   other than 429, and exhausted retries remain terminal failures.

## Implemented design

- `src/orchestrator/shortlist.ts` creates deterministic, ranked generation
  batches and enforces the task budget.
- `src/orchestrator/sol.ts` processes batches lazily and stops after the
  requested action count. Explicit `--post-ids` runs remain bounded to the
  explicit target set.
- Specific-cycle real-model calls now use a recovery-safe single-worker profile,
  a non-repository working directory, documented `low` reasoning effort, a
  120-second task deadline, one-item strategy batches, and an eight-task budget.
  Two consecutive failed strategy batches stop the run before it spends the
  full discovery pool on a known-unavailable model boundary. This is still the
  configured real model; it does not fall back to deterministic comments.
- `src/models/codex.ts` now uses a streamed child-process runner by default. It
  consumes Codex JSONL lifecycle events, surfaces early `error`/`turn.failed`
  events, normalizes the non-interactive terminal environment, bounds stdout
  and stderr, and terminates the child process group on timeout.
- Strategy-generation model attempts are persisted through the existing
  `model_runs` contract, including Codex failure kind and lifecycle metadata
  when available.
- `src/generation/model.ts` sends only bounded post, reply, conversation, and
  Marx-evidence context to the model.
- `src/article/workflow.ts` retries transient Moltbook search failures before
  building the related-target pool.
- `src/specific-cycle/output.ts` reports run errors separately from quality
  no-action reasons.

## Attribution and metrics contract

For every action that reaches publish preparation:

1. The engine creates a cryptographically random 128-bit `ref` through the
   production `marx-tracker` Worker.
2. The Worker stores the distribution in its external D1 `distributions`
   table as `pending`.
3. The tracked URL is appended to the final comment before `commentHash`,
   `actionId`, and `experimentId` are derived.
4. Finalization stores the action/experiment identity and comment hash in D1,
   then reads the distribution back as `active`.
5. The engine stores the same attribution chain in local SQLite,
   `tracking_distributions`, including `ref`, source post, feed, run,
   opportunity, candidate, action, experiment, comment hash, click flag, and
   redirect timestamps/count.
6. The production outbox and downstream publisher are reached only after the
   exact action-count and zero-error gates pass.

Later clicks are authoritative in the external D1 `attribution_events` table
and are read through the tracker summary endpoint. The local SQLite row is the
engine-side attribution snapshot; it is not a live mirror unless a later
summary refresh is run.

## Verification sequence

Run from the repository root with Node 22:

```bash
PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:$PATH npm run typecheck
PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:$PATH npm test -- --run
PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:$PATH npm run build
PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:$PATH npm run cli -- doctor --live-read --publisher --autonomous

# Publication-free real-model preflight; this performs one structured Codex call.
PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:$PATH npm run cli -- doctor --model-smoke
```

Before a live publish, the terminal that launches the command must have
`MARX_TRACKER_API_TOKEN` configured without printing its value. The kill-switch
clearance must be current, and `doctor --model-smoke` must pass. The final
command is:

```bash
/Users/0x79de/.nvm/versions/node/v22.17.0/bin/node dist/cli/main.js marx-specific-cycle \
  --article-url https://marx.finance/feed/810828fbfe9d4dcea36b8a61bf3e0b80 \
  --limit 8 \
  --search-limit 10 \
  --actions 5 \
  --with-agent-quotes \
  --real-model \
  --publish \
  --output docs/moltbook-runs/
```

Before returning to production, complete the direct Codex smoke test and a
one-post real-model development/staging run. Completion requires a final
JSON/Markdown receipt showing five action IDs, five active production tracking
records, five verified publisher receipts, and zero run errors. A dry-run, a
pending outbox entry, or an active tracker row without a verified Moltbook
receipt is not a successful publication result.
