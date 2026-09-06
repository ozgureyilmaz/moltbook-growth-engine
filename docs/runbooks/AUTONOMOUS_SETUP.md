# Autonomous Setup Runbook (one step at a time)

Plan status: proposed — confirm with Marx growth decision owner.

This runbook is intentionally staged. Complete one current step, verify its
output, then move to the next. Never send a secret in chat.

1. **Baseline:** from the repository root, run `npm install && npm run typecheck && npm test && npm run build`.
2. **Read-only health:** run `npm run cli -- doctor` and confirm configuration, runtime directory, and an engaged kill switch are visible.
3. **Browser authorization:** in the side browser, open the official Moltbook owner dashboard at `https://www.moltbook.com/login`; authenticate only in the visible browser and confirm the intended read agent/account.
4. **Keychain storage:** in Terminal, run `/usr/bin/security add-generic-password -U -s marx-moltbook-growth-engine -a moltbook-read-client -w` and enter the read key only at the hidden prompt.
5. **Read probe:** run `npm run cli -- doctor --live-read`; a successful result proves the configured GET read path only.
6. **Live-read rehearsal:** run `npm run cli -- run --live-read --dry-run --limit <bounded-limit> --actions 0`; inspect the structured log and confirm no outbox pending file was created.
7. **Hermes bridge rehearsal:** configure the separate Hermes publisher privately, provision the separate contract secret in Keychain, use a signed synthetic grant/receipt, and exercise the `outbox/handoff/` request path with wrong-account, signature mismatch, duplicate, failed, verification-required, reconciliation-required, and kill-switch cases.
8. **Outcome rehearsal:** import synthetic versioned events with `npm run cli -- outcomes import --events <events.json>` only after the matching synthetic verified receipt exists; wrong-post, unpublished, replayed-evidence, and pre-publication events must fail.
9. **Pilot authorization:** proposed — confirm with Marx growth decision owner: define account, submolt allowlist, caps, telemetry source, authenticated receipt origin, publisher-side kill-switch recheck, rollback responder, and clearance before setting `source.mode=authorized_autonomous` or attempting a first live write.

The engine's default emergency state is engaged. `npm run cli -- ops kill-engage
--reason "..." --actor "..."` is always available. Clearing requires a
time-bounded JSON clearance file and should be done only after the decision
owner confirms the pilot contract.
