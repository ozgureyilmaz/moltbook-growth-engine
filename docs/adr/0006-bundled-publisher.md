# ADR 0006: Clone-ready publisher process

## Decision

Distribute the deterministic Moltbook publisher under
`integrations/moltbook-publisher/`, outside discovery, analysis, generation and
evaluation. Invoke it through the existing signed outbox/request/receipt boundary.
The new `publisher_bridge.type: local_process` selects this transport; existing
`hermes_outbox` installations remain supported. Hermes can schedule the explicit
one-shot command but is not a prerequisite for a one-shot publication.

Each operator provisions their own claimed Moltbook account key and authorized
tracker token. Dedicated ignored local configuration and restricted local secret
storage are created by `setup:publish`; no credentials or runtime state ship in
Git. Checked-in configuration remains read-only with publication disabled.

The explicit `npm run publish` command runs preflight, obtains a bounded signed
clearance and invokes the tracked cycle. It re-engages the kill switch in cleanup.
It does not steal stale locks or automatically retry unknown outcomes. The
publisher consumes only action IDs selected by that invocation, verifies actual
account identity, rechecks the kill switch before writing, and records attempted
writes durably. Missing read-back remains reconciliation, never success.

## Compatibility

No action schema version or database migration is required. Signed publisher
metadata labels the local deterministic process explicitly. Existing Hermes
paths and Keychain setups remain available; local-process onboarding uses
environment secrets populated only in the relevant local subprocesses.

## Limitations

One host must own the publishing database/outbox/caps for any shared account.
Multiple independent clones cannot coordinate duplicate history. Native Windows
is not supported by the publisher's POSIX locks. A platform verification challenge
is reported and publication is left unverified; the integration does not solve
or bypass it. A verified end-to-end live publication still depends on the user's
account, source, tracker authorization and content passing QA.
