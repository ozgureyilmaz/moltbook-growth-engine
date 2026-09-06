# Marx Moltbook Growth Engine — Autonomous Control-Plane Plan

Plan status: proposed — confirm with Marx growth decision owner.

## Outcome and boundary

This repository owns discovery, context, scoring, strategy generation,
independent evaluation, deterministic QA, SQLite attribution, and a validated
outbox/request handoff. A separate Hermes publisher owns Moltbook write
credentials and the platform write. The engine never logs in, solves a
Moltbook verification challenge, follows an external instruction, or claims a
publication without a verified receipt.

The local implementation now includes:

- an official-origin, GET-only Moltbook read client;
- macOS Keychain/environment secret-provider abstractions with redacted
  boundaries;
- hash-bound Hermes request and publication-receipt contracts;
- immutable, provider-evidence-deduplicated Marx outcome events and
  publication-bound verified-only aggregation;
- a fail-closed emergency kill switch;
- a singleton supervisor lease, heartbeat, signal-aware daemon shutdown, and
  diagnostic health checks;
- `doctor`, `ops`, `handoff`, and `outcomes import` CLI surfaces for staged
  activation and evidence ingestion.

The system remains disabled by default: `publishing.enabled=false`, the source
mode is disabled, and the kill switch is engaged when state is missing or
invalid.

## Verified external facts and limits

The current official Moltbook skill documents the API base as
`https://www.moltbook.com/api/v1`, requires the `www` host for authenticated
requests, exposes cursor-based `GET /posts` and `GET /posts/:id/comments`, and
documents read/write rate limits and comment cooldowns. Re-fetch the official
skill before activation because platform behavior can change:
<https://www.moltbook.com/skill.md>.

The API may return a verification challenge after a write. That challenge is a
platform control, not an invitation to bypass moderation. The separate
publisher must return `VERIFICATION_REQUIRED` or `RECONCILIATION_REQUIRED` and
must not retry blindly.

## Operating modes

| Mode | Read source | Model | Outbox | External write | Default |
| --- | --- | --- | --- | --- | --- |
| `FIXTURE_DRY_RUN` | fixture | deterministic evaluator | no pending handoff | never | enabled for tests |
| `LIVE_READ_ONLY` | authorized Moltbook GET client | deterministic or configured model | no production entry | never | explicit `--live-read` |
| `AUTHORIZED_AUTONOMOUS` | authorized Moltbook GET client | configured model | validated COMMENT request | only Hermes | disabled; kill switch must be cleared |

`NO_ACTION` is a normal result. Quality thresholds never get weakened to hit a
target action count.

## End-to-end control flow

1. **Read** — `MoltbookHttpClient` resolves the API key from the configured
   secret provider, sends only GET requests to the official origin, denies
   redirects, validates response envelopes, and maps posts/comments to stable
   internal types.
2. **Decide** — Sol orchestrates exactly the closed runtime Luna roles:
   `discovery_context`, `opportunity_analysis`, and `strategy_generation`.
   Independent evaluation and deterministic QA produce `COMMENT` or
   `NO_ACTION`.
3. **Persist** — SQLite stores run, context, opportunity, candidate,
   evaluation, action, experiment, publication, outcome-event, and attribution
   evidence. The file outbox is idempotent and production enqueue requires an
   explicit kill-switch gate.
4. **Handoff** — `handoff prepare` creates a request containing action,
   idempotency, action/body/target/content hashes, publisher account, scoped
   grant, HMAC-signed contract metadata, and Hermes model metadata
   (`openai-codex`, `gpt-5.6-luna`, `xhigh`). No write credential is copied
   into the request.
5. **Publish externally** — Hermes loads its own private Moltbook write
   credential, verifies account/target/body/scope, and performs one bounded
   platform operation. Hermes writes a receipt; it does not regenerate text.
6. **Reconcile** — `handoff import-receipt` accepts only a hash-bound,
   exact-target, exact-body, account-bound, verified receipt. Published receipts
   acknowledge the outbox. Failed, uncertain, and verification-required
   results are quarantined and cannot be blindly retried.
7. **Learn** — Moltbook replies/reactions and Marx product signals enter through
   `outcomes import` as versioned `MarxOutcomeEvent` records. The importer joins
   the exact action, experiment, run, source post, and verified publication
   before persisting an aggregate. Only `evidenceStatus=verified` can set learning
   signals; inferred/self-reported events remain visible but excluded.

Growth event v2 state transitions require `evidenceStatus=verified` and a named
evidence source; an event name alone is not publication or outcome proof.

## Contracts to keep stable

### Read client

- Base URL: official `https://www.moltbook.com/api/v1` only in production.
- Credential: `MOLTBOOK_API_KEY` is a reference name, not a value in source,
  prompts, logs, SQLite, or request files.
- Secret default: macOS Keychain service
  `marx-moltbook-growth-engine`, account `moltbook-read-client`.
- Failure: 401/403, malformed JSON, invalid timestamps, redirect, or an
  unapproved URL is terminal; 429/5xx/timeouts are bounded and
  status-aware-retryable.

### Hermes request and receipt

Requests are `MOLTBOOK_ACTION_REQUEST` v1. Each request binds one exact action
to one scoped grant and includes `actionHash`, normalized `contentHash`, exact
UTF-8 `bodyHash`, `targetHash`, and an idempotency key.

Receipts are `MOLTBOOK_PUBLICATION_RECEIPT` v1. `PUBLISHED` requires
`evidenceStatus=verified`, provider comment ID, official permalink, publication
timestamp, and a valid receipt hash. `FAILED`, `VERIFICATION_REQUIRED`, and
`RECONCILIATION_REQUIRED` require an error code and never acknowledge the
outbox.

### Marx outcome telemetry

Each event carries `actionId`, `experimentId`, `runId`, source post, target
agent when available, occurrence/observation timestamps, evidence source,
evidence status, consent state, and a provider evidence ID for verified data.
Raw events are immutable and deduplicated by event ID plus provider evidence
identity in SQLite. Pending, fixture, and dry-run experiments without a verified
outcome do not count as learning trials. The canonical signals are
`marx_investigated`, `marx_interacted`, and `marx_used`.

Primary metric: attributable Marx usage rate; source of truth: unknown — Marx product telemetry joined to verified Moltbook publication receipts; cohort/window: unknown — define per pilot; evidence status: unknown.

Guardrail: verified publication integrity; definition/unit: percentage of `PUBLISHED` receipts with matching request/action/body/target/account hashes and an official permalink; source of truth: SQLite `publications` plus imported Hermes receipts; cohort/window: each pilot run and cumulative pilot; evidence status: proposed; trigger/action/responder: proposed — confirm with Marx growth decision owner; any mismatch pauses the publisher and engages the rollback responder.

Guardrail: platform policy health; definition/unit: count of 401/403/429 responses, verification-required results, and platform restriction errors; source of truth: structured run/error logs plus publisher receipts; cohort/window: each run and rolling pilot window; evidence status: proposed; trigger/action/responder: proposed — confirm with Marx growth decision owner; any material breach engages the emergency kill switch and platform owner.

Guardrail: duplicate/repetition safety; definition/unit: deterministic QA duplicate, near-duplicate, repeated-hook, and saturated-thread rejection count; source of truth: QA records and action table; cohort/window: each run; evidence status: verified for local fixtures, unknown for live traffic; trigger/action/responder: proposed — confirm with Marx growth decision owner; repeated unexpected matches pause generation.

## Staged pilot and draft rollout

### Draft (current)

- `publishing.enabled=false`, kill switch engaged, no publisher request emitted.
- Fixture and `--live-read --dry-run` are the only executable paths.
- Draft candidates, QA decisions, and telemetry schemas are reviewed locally.
- Owner: unassigned — Marx growth decision owner.

### Read-only rehearsal

- proposed — confirm with Marx growth decision owner: place the read API key in
  Keychain, run `doctor --live-read`, then run bounded `run --live-read
  --dry-run`.
- Confirm source freshness, response shapes, rate-limit headers, context
  completeness, and zero publication side effects.
- Decision: collect evidence unless the read contract or context quality is
  not trustworthy.

### Receipt rehearsal

- proposed — confirm with Marx growth decision owner: create a fixture COMMENT
  outbox item, issue a one-action draft grant, run `handoff prepare`, and feed
  a synthetic verified receipt through `handoff import-receipt`.
- Exercise wrong account, body/target/hash mismatch, duplicate receipt,
  verification-required, timeout/unknown, and kill-switch tests.
- Decision: iterate until all negative tests remain terminal and auditable.

### Controlled live pilot

- proposed — confirm with Marx growth decision owner: define publisher account,
  exact allowlisted submolts, action/run-period cap, pilot window, disclosure
  identity, and receipt/outcome source before clearing the kill switch.
- Require a fresh scoped grant for each pilot, exact content confirmation in
  the publisher agent, and a rollback responder who can engage both kill
  switches.
- Do not infer causal lift from reply counts, local simulation, or action
  volume.

### Production autonomy

- blocked — live credentials, publisher deployment/readiness, authenticated
  receipt origin, publisher-side kill-switch recheck, Marx product telemetry
  source, pilot owner, and rollback responder are not configured in this
  checkout.
- Advance only after the pilot decision owner confirms the contracts,
  guardrails, retention/privacy policy, alert route, and durable operator.

## Operations ownership

| Responsibility | Current status |
| --- | --- |
| Growth decision owner | unassigned — required role |
| Implementation owner | proposed — confirm with Marx growth decision owner |
| Measurement/telemetry owner | unassigned — required role |
| Hermes publisher operator | unassigned — required role |
| Moltbook account owner | unassigned — required role |
| Rollback responder | unassigned — required role |
| Privacy/security approver | unassigned — required role |
| Durable owner after a winning pilot | unassigned — required role |

The local supervisor provides a lease, heartbeat, signal-aware shutdown, and
diagnostics. A launchd/systemd/host supervisor still needs to be selected and
installed; this repository does not silently install a persistent service.

## Verification commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run cli -- doctor
npm run cli -- ops kill-status
npm run cli -- run --fixture ./tests/fixtures/moltbook.json --dry-run
npm run cli -- daemon --once --supervised --fixture ./tests/fixtures/moltbook.json --dry-run
```

The first live read step is deliberately separate:

```bash
npm run cli -- doctor --live-read
npm run cli -- run --live-read --dry-run --limit 10 --actions 0
```

`--live-read` resolves a secret but does not publish. Do not paste the key into
chat, a prompt, a log, a fixture, or a repository file.
