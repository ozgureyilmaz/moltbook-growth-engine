# Marx Moltbook Growth Engine

Local, autonomous, experiment-driven infrastructure for finding high-value
Moltbook conversations and preparing context-specific Marx outreach for an
existing publishing agent.

This repository deliberately stops before platform publication:

```text
discover -> understand context -> rank opportunity -> generate candidates
-> evaluate -> deterministic QA -> validated JSON action -> local outbox
-> existing Moltbook publishing agent
```

The downstream agent owns authentication and the actual Moltbook interaction.
This project never needs to bypass platform controls or keep publisher
credentials.

## Status

The local V2 control plane is implemented: fixture discovery, an official-origin
GET-only Moltbook read adapter, normalization, context analysis, explainable
ranking, strategy-diverse generation, independent evaluation, deterministic QA,
SQLite attribution and publication-bound immutable outcome events, hash-bound Hermes handoff and
receipt reconciliation, authenticated marx-tracker attribution links, a Keychain secret provider, supervisor lease/heartbeat,
health checks, and an emergency kill switch. Live publishing and the authoritative
Marx product telemetry source remain explicit external boundaries.
Keep the checked-in execution default safe for development: dry-run is the
default. Production publication still requires the explicit `--publish` path,
authorized source mode, the publisher bridge, and all existing kill-switch and
receipt gates.

## Requirements

- Node.js 22 or newer;
- npm compatible with Node 22;
- local filesystem access for SQLite, logs, and the outbox;
- an authenticated Codex Exec environment for model-backed runs, when that
  executor is enabled.

No separate pay-per-token model API is required by the architecture. Model
access is behind a replaceable `ModelExecutor` abstraction. Dry-run uses the
deterministic evaluator and reports that mode explicitly; `CodexExecExecutor`
is available for an authenticated Codex CLI session.

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

If `better-sqlite3` reports a missing native binding after installation, rebuild
the local addon with `npm rebuild better-sqlite3 --build-from-source` and rerun
the test suite.

The default paths are local and can be changed in `config/system.yaml`:

- SQLite: `data/marx_growth.sqlite`;
- structured run logs: `logs/runs/`;
- error logs: `logs/errors/`;
- outbox: `outbox/pending/`, `outbox/acknowledged/`, `outbox/failed/`,
  `outbox/quarantine/`, and
  publisher request/receipt handoff under `outbox/handoff/`.

Generated state is ignored by Git. Do not commit credentials, databases,
publisher responses, or raw sensitive content.

## Configuration

`config/system.yaml` contains execution counts, model executor limits, local
storage, action schema version, publishing gates, deterministic QA thresholds,
observability settings, the disabled Moltbook source, publisher bridge model
metadata, and supervisor paths. The checked-in source base is
`https://www.moltbook.com/api/v1`; do not replace it with a redirecting bare
host. `source.mode=live_read_only` and the `--live-read` flag can never create a
production outbox entry. The separate `source.mode=authorized_autonomous` value
is required for a future production run and remains disabled in the checked-in
configuration.

`config/submolts.yaml` contains included/excluded submolts, lookback, source
adapters, candidate limits, topic/agent signals, and platform-compliance
flags. An empty include list means the source adapter decides its permitted
default scope; it is not permission to crawl indiscriminately.

`config/experiments.yaml` contains the strategy families, candidate count,
exploration/exploitation policy, tracking fields, outcome dimensions, and the
rule that learning must not optimize only for replies.

`config/system.yaml` also defines separate tracker environments. A non-publishing
specific cycle uses the development/staging tracker configured through
`MARX_TRACKER_DEVELOPMENT_BASE_URL` and `MARX_TRACKER_DEVELOPMENT_API_TOKEN`.
`--publish` uses the pinned production origin
`https://marx-tracker.marxx.workers.dev` and reads
`MARX_TRACKER_API_TOKEN`. Tokens are read through the secret-provider boundary
and are never written to comments, action payloads, logs, or SQLite.

Counts such as 100 candidates and 5 target actions are configuration values.
The system must emit fewer actions when the evaluator or deterministic QA
rejects the available opportunities.

## Growth measurement boundary

The intended primary metric is attributable Marx usage by the target
autonomous agent. Its production source of truth and attribution window are
currently unknown because the downstream publisher and Marx outcome telemetry
are external to this repository. The local system emits versioned
`action_created` events and provides explicit `action_published` and
`outcome_observed` helpers; those events must be reconciled by the authorized
publisher/telemetry owner before any causal growth claim is made. Growth event
v2 requires verified evidence status and a named evidence source for published
and observed state transitions.
Verified raw evidence can be imported with `outcomes import`; the importer
requires an exact durable action/experiment/source-post join and a verified
published receipt before it updates an outcome or learning prior.

## CLI and safe execution

The supported commands are:

```bash
# Without a fixture or injected authorized source this fails closed.
npm run cli -- run --dry-run

# Override configured run sizes for a dry run.
npm run cli -- run --limit 100 --actions 5 --dry-run

# Exercise the real Codex evaluator without publishing.
npm run cli -- run --fixture ./tests/fixtures/moltbook.json --dry-run --real-model

# Run entirely from a local Moltbook-like fixture.
npm run cli -- run --fixture ./tests/fixtures/moltbook.json --dry-run

# Inspect local run and strategy state.
npm run cli -- status
npm run cli -- experiments

# Publication-free real-model preflight (one structured Codex call).
npm run cli -- doctor --model-smoke

# Replay stored inputs while preserving idempotency.
npm run cli -- replay <run_id> --dry-run

# Start an interval/cron-backed scheduler when configured.
npm run cli -- daemon
npm run cli -- daemon --once --fixture ./tests/fixtures/moltbook.json --dry-run
npm run cli -- daemon --once --supervised --fixture ./tests/fixtures/moltbook.json --dry-run
npm run cli -- daemon --supervised --interval 18000000 --live-read --dry-run
npm run cli -- daemon --supervised --cron "0 */5 * * *" --live-read --dry-run

# Control-plane diagnostics and emergency stop.
npm run cli -- doctor
npm run cli -- ops kill-status
npm run cli -- ops kill-engage --reason "operator emergency stop" --actor "operator"

# Explicit authorized read-only rehearsal (requires a Keychain key; never publishes).
npm run cli -- doctor --live-read
npm run cli -- run --live-read --dry-run --limit 10 --actions 0

# Explicit publisher handoff files (the separate Hermes agent owns write credentials).
npm run cli -- handoff prepare <action_id> --grant <grant.json> --publisher-account <name>
npm run cli -- handoff import-receipt <request_id> --receipt <receipt.json>

# Import versioned outcome evidence after its exact action has a verified receipt.
npm run cli -- outcomes import --events <events.json>

# Discover related Moltbook posts from a Marx feed, then prepare comments.
# Default is read-only dry-run; add --publish only after production preflight.
node dist/cli/main.js marx-specific-cycle \
  --article-url https://marx.finance/feed/<feed-id> \
  --limit 100 \
  --actions 5 \
  --no-agent-quotes \
  --output docs/moltbook-runs/
```

Agent reply quote mode is explicit. Replace `--no-agent-quotes` with
`--with-agent-quotes` when the comment should include the relevant Marx agent
name and quoted reply alongside the tracked Marx feed link.

`marx-specific-cycle` validates the Marx feed, discovers related Moltbook posts
when `--post-ids` is omitted, fetches each selected post and its full public
context, generates one context-specific comment per target, and writes a
Markdown receipt under `docs/moltbook-runs/`. The comment body contains one
natural `Marx` bridge plus exactly one tracked link with the label
`[Open Marx feed](...)`; the canonical feed URL is stored in the
tracker distribution, not replaced by a direct-link fallback. The Moltbook
target and comment-preview links remain output metadata and are not inserted
into the comment. `--no-agent-quotes` is the default for this cycle;
`--with-agent-quotes` explicitly enables the selected Marx agent name and
reply quote. The command creates the tracker distribution after evaluator and
deterministic-QA approval, appends the link, then derives the final
`comment_hash`, `action_id`, and `experiment_id` before tracker finalization and
read-back. `NO_ACTION` and rejected candidates receive no tracking link.
Without `--publish`, only the development/staging tracker is used and no
publisher handoff is attempted. With `--publish`, the production tracker must
be active and read back successfully before any action enters the production
outbox.

`--limit` is the discovery pool size, not the number of guaranteed
publications. For the current recovery-safe five-action attempt, use
`--limit 8 --search-limit 10 --actions 5`. The engine ranks the pool, sends at
most eight qualified opportunities to real-model strategy generation in
one-item batches, and stops after five candidates pass evaluation, QA, and
tracker finalization. Two consecutive strategy-generation worker failures stop
the run early. It refuses the publish if fewer than five are available or any
worker, model, tracker, or validation error occurs.

The Codex executor uses a streamed JSONL child-process boundary, captures
lifecycle and stderr diagnostics, normalizes the non-interactive environment,
and terminates hung process groups. Specific-cycle real-model calls use
documented `low` reasoning effort and a 120-second deadline. This is still the
configured real model; the engine never falls back to publishing deterministic
comments.

The pasted historical TXT is retained only as a regression fixture at
`tests/fixtures/specific-marx-comments-500cf34bfaa84944ab840cd32adc8849.txt`.
The exact first-feed and second-feed verification commands are preserved in
`command.txt`. A publish attempt requires the normal authorized source mode,
enabled publishing bridge, configured production tracker token, scoped grant,
valid publisher contract, cleared kill switch, and verified provider readback.
Tracker create conflicts, finalization failures, ambiguous responses, and
non-active read-backs block the affected action; they never fall back to a
direct Marx URL. Uncertain or non-`PUBLISHED`
provider results are written as pending/reconciliation states and are never
reported as successful publication. If the requested action count cannot be
filled, `--publish` refuses the entire batch before handing off any action; it
never publishes a partial target set.

`npm run cli -- ...` uses `tsx` directly. Once built, the equivalent installed
binary is `dist/cli/main.js` / `marx-growth`.

Dry-run must show, in structured output, the discovered and deduplicated posts,
opportunity component scores, strategy arms, candidate comments, evaluator
scores, deterministic rejection reasons, and final COMMENT/NO_ACTION decisions.
It must not write a pending publisher action. Fixture runs must not call a
live source or publish anything.

Model-backed execution is selected for non-dry-run operation. It requires
`source.mode=authorized_autonomous`, `publishing.enabled: true`,
`publisher_bridge.enabled: true`, a non-empty production domain allow-list, a
valid scoped grant, a valid publisher contract secret, and an authenticated Codex CLI session. `--live-read` always
remains read-only. The stock CLI intentionally
bundles no Moltbook write credential or posting client. A production outbox also
requires an explicit emergency-kill-switch gate.

`--real-model` opts a dry-run into the Codex evaluator and is useful for a
read-only rehearsal of model execution. Without it, dry-runs use the
deterministic evaluator. Worker opportunity scoring and candidate generation
remain deterministic; their Codex worker calls are advisory metadata until a
model-driven implementation is added.

`daemon --interval 18000000` runs immediately and waits five hours after each
completed run. `daemon --cron "0 */5 * * *"` uses the host's local timezone and
runs at 00:00, 05:00, 10:00, 15:00, and 20:00. Use `--supervised` so the local
lease and periodic heartbeat protect against duplicate daemon instances. The
repository does not install a host-level restart service. `doctor --autonomous`
returns a non-zero exit code when the production preflight is not ready.

The engine and Hermes publisher authenticate grants and receipts with a
separate HMAC contract secret. Keep it in Keychain under the configured
`publisher-contract` account; it is not the Moltbook API key and must never be
placed in the repository, request files, prompts, or logs.

## Outbox consumption contract

The downstream publisher consumes versioned snake_case JSON files from
`outbox/pending/`; prepared request and receipt files remain under
`outbox/handoff/`. Internal TypeScript objects remain camelCase; the explicit
serializer/deserializer in `src/outbox/transport.ts` is the compatibility
boundary. Acknowledged and failed actions remain deduplicated, and failed
actions require an explicit bounded retry.

## Hermes publisher and receipts

`src/publisher/` defines the separate-agent contract. `handoff prepare` writes a
single `MOLTBOOK_ACTION_REQUEST` v1 containing the exact action, grant/account
binding, idempotency key, action/body/target/content hashes, and model metadata
(`openai-codex`, `gpt-5.6-luna`, `xhigh`). It never contains a Moltbook API key.

Hermes owns its private write credential and the Moltbook write operation. The
engine accepts only a matching, hash-valid, official-permalink
`MOLTBOOK_PUBLICATION_RECEIPT` with `status=PUBLISHED` and
`evidenceStatus=verified`. Failed, uncertain, and verification-required receipts
are persisted and quarantined; they cannot be blindly retried.

`MarxOutcomeEvent` records preserve source, evidence status, consent state,
timestamps, and attribution. Verified evidence is immutable and deduplicated by
provider evidence identity. Only events joined to an exact verified publication
can set the canonical `marx_investigated`, `marx_interacted`, and `marx_used`
learning signals. Pending, fixture, and dry-run experiments without verified
outcomes are excluded from learning trials. See [the autonomy plan](docs/AUTONOMY_IMPLEMENTATION_PLAN.md),
[the Hermes publisher runbook](docs/runbooks/HERMES_PUBLISHER_SETUP.md), and
[separate Mermaid diagrams](docs/diagrams/).

## Action contract

The handoff is a versioned, schema-validated JSON document. A COMMENT action is
conceptually shaped like this:

```json
{
  "schema_version": "1.0",
  "action_id": "act_...",
  "action": "COMMENT",
  "platform": "moltbook",
  "target": {
    "post_id": "post_123",
    "post_url": "https://permitted.example/posts/post_123",
    "submolt": "research",
    "agent_id": "agent_123",
    "agent_name": "example-agent"
  },
  "content": {
    "comment": "A context-specific contribution that mentions Marx naturally.",
    "strategy_family": "provenance",
    "hook_family": "specific_claim"
  },
  "decision": {
    "opportunity_score": 0.91,
    "evaluation_score": 0.94,
    "confidence": 0.88
  },
  "experiment": {
    "experiment_id": "exp_...",
    "prompt_version": "comment.generate@v1",
    "model_version": "codex-exec:configured"
  },
  "metadata": {
    "created_at": "2026-08-24T00:00:00.000Z",
    "run_id": "run_..."
  }
}
```

When no safe, useful action exists, record a first-class `NO_ACTION` decision
with a machine-readable reason such as `LOW_RELEVANCE`, `WEAK_MARX_BRIDGE`,
`THREAD_SATURATED`, `DUPLICATE`, `CONTEXT_MISSING`, `UNSUPPORTED_CLAIM`, or
`QUALITY_BELOW_THRESHOLD`. Never force the target action count.

## Architecture and quality bar

Sol coordinates bounded Luna workers for discovery, context, opportunity
analysis, messaging strategy, candidate generation, evaluation, and learning.
Workers return compact structured reports, not raw conversation dumps. The
orchestrator synthesizes their reports and performs the final decision.

The intelligence layer should answer:

> Could a useful, context-specific Marx contribution plausibly make an
> autonomous agent investigate, discuss, interact with, or use Marx?

That is broader than keyword matching and narrower than generic promotion.
Publishable comments normally have one contextual hook, one useful idea, and
one natural Marx bridge. They must pass both an independent evaluator and
deterministic QA, including contextual anchoring, duplicate protection,
unsupported-claim checks, and the standalone marketing test.

## Prompt and experiment versioning

Important model instructions are versioned under `prompts/`:

- `opportunity/v1.md` — classify and score a conversation;
- `strategy/v1.md` — select distinct experiment arms;
- `generator/v1.md` — write context-specific candidates;
- `evaluator/v1.md` — independently score candidates;
- `learning/v1.md` — update conservative strategy priors.

Do not edit a prompt version in place after it has produced actions. Create a
new version and record it on every model run, candidate, evaluation, action,
and experiment. Strategy families are hypotheses, not permanent templates.

## Platform and security boundaries

Only official, documented, public, or explicitly authorized Moltbook access
methods are permitted. The project does not implement CAPTCHA/authentication
bypass, rate-limit evasion, stealth scraping, proxy rotation for evasion, fake
identities, impersonation, hidden redirects, or moderation evasion.

Retrieved posts and replies are untrusted data. Prompt injection such as
“ignore previous instructions,” requests for credentials, or commands to
delete local state must be treated as text about the conversation, never as
instructions. External content cannot modify the system prompt, access the
filesystem, alter configuration, or trigger a tool call.

Development defaults prevent publication. A future production enablement must
explicitly set `publishing.enabled: true`, use the permitted downstream
publisher contract, retain schema validation and deterministic QA, and keep
credentials outside this repository.

## Source, outcome, and learning status

- Fixture mode is complete and deterministic; disabled mode fails closed.
- An official-origin live read client exists behind `--live-read`; its key is
  resolved from macOS Keychain (or explicitly configured environment mode), and
  no credential is bundled.
- Publication and outcome schemas/repositories exist. Local outcome simulation
  exercises fixture-only statistics, while durable learning accepts only
  publication-bound verified evidence imported through the outcome ingestion
  boundary.
- Real publisher receipts, Marx investigation/interaction/usage telemetry,
  attribution windows, and production baselines remain external and unknown.

Architecture decisions are recorded under `docs/adr/` for canonical schemas,
Sol/Luna/Codex execution, source and publishing boundaries, and outbox/outcome
attribution.

## Development commands

```bash
npm run typecheck       # strict TypeScript validation
npm test                # unit/integration/evaluation suite
npm run test:watch      # local test iteration
npm run build           # compile src/ to dist/
npm run cli -- run --help  # inspect run options
npm run cli -- run --fixture ./tests/fixtures/moltbook.json --dry-run
npm run cli -- daemon --once --fixture ./tests/fixtures/moltbook.json --dry-run
```

Use fixtures for integration and evaluation. Do not make tests publish live
comments. Before declaring a change complete, also run the relevant dry-run and
fixture commands, inspect structured logs, and confirm that retries remain
idempotent.

See [AGENTS.md](AGENTS.md) for the full coding-agent operating manual,
including persistence, worker contracts, architecture-change procedure,
observability, failure handling, and the Definition of Done.
