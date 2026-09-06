# ADR 0005: Authorized read, external Hermes write, and local operations control plane

- Status: accepted for local implementation; live activation remains blocked
- Date: 2026-08-27

## Context

The growth engine needs an authorized Moltbook read path, a separate publisher
agent, publication receipts, Marx outcome telemetry, and unattended operation.
The repository must not absorb write credentials or platform posting behavior.

## Decision

1. Use a Node `fetch` adapter with the documented official API base
   `https://www.moltbook.com/api/v1`. It is GET-only, denies redirects, validates
   envelopes, drops deleted/spam content, and uses bounded status-aware retries.
2. Resolve the read credential through a `SecretProvider`; macOS Keychain is the
   default and environment lookup is an explicit alternative. Secret values
   never enter logs, prompts, SQLite, or handoff files.
3. Keep Moltbook writes in a separate Hermes agent. The engine emits a v1
   action request with a scoped account/grant and action/body/target/content
   hashes. Grants and receipts carry an HMAC contract signature resolved from
   a separate Keychain secret in production. The engine accepts only a
   signature- and hash-valid verified receipt. Uncertain and
   verification-required results are quarantined rather than retried blindly.
4. Store raw outcome events immutably in SQLite, deduplicate verified provider
   evidence, and require an exact verified-publication attribution join before
   strategy learning can set Marx investigation/interaction/usage signals.
5. Gate unattended operation with a missing-state-is-engaged kill switch,
   singleton lease, heartbeat, signal-aware shutdown, and health/doctor checks.
   A host service manager may restart the process, but is not installed by the
   repository.
6. Keep `live_read_only` and `authorized_autonomous` as distinct source modes.
   The `--live-read` flag cannot produce a production outbox entry or publisher
   request. Prepared publisher artifacts remain inside `outbox/handoff/`.

## Consequences

- Fixture and live-read dry-run remain usable without write credentials.
- Pending, fixture, and dry-run experiments without verified outcomes do not
  influence durable strategy priors.
- The first live write still requires an external publisher deployment,
  explicit account/grant/pilot configuration, receipt reconciliation, and a
  separately confirmed kill-switch clearance.
- Hash and evidence validation is stricter than the legacy action/publication
  schema; legacy files remain readable only through the existing action
  transport and cannot bypass the new handoff boundary.
- Platform endpoint, account, telemetry, attribution-window, and operational
  ownership details remain external facts to verify during setup.
