# Hermes Publisher Setup

Use this runbook on the single machine designated to publish for a claimed
Moltbook account. Public draft generation via `npm run live` does not require
Hermes. The external publisher owns the write credential and exact platform
interaction; the engine owns generation, evaluation, QA and signed handoff.

## 1. Install and verify Hermes

Follow the [official installation and quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart),
then configure the intended operator's provider using `hermes setup` or
`hermes model`. Verify an ordinary chat first. Use a separate operator login;
do not copy another person's entire `~/.hermes` folder or authentication state.
The official [skills guide](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)
explains how skills are loaded. This project-specific publisher is not assumed
to be part of a standard Hermes installation.

The engine's model requests run through its separately authenticated Codex CLI.
Hermes must not rewrite, regenerate or improvise publication content. The current
publisher integration expects macOS Keychain and Python with POSIX locking;
native Windows/Linux publication needs a separately tested secret-store adapter.

## 2. Obtain the reviewed publisher skill

The team must supply a reviewed, versioned copy of
`moltbook-deterministic-publisher` containing its `SKILL.md` and scripts.
Install it under the operator's
`~/.hermes/skills/automation/moltbook-deterministic-publisher/`, or use an
explicit script path below. Record its version/hash alongside the engine commit.
Do not replace it with a generic model prompt that posts comments or top-level
posts. The reviewed publisher must preserve the signed COMMENT/POST envelope,
submolt allow-list, exact content read-back, and receipt binding.

This repository does not distribute that external Python publisher. Without the
reviewed package, live drafts work but production publishing is not ready.
Review the package for machine-specific paths before transferring it. The legacy
script accepts `MARX_GROWTH_NODE`; the engine and generated environment pin this
to the active Node 22 executable. Its internal PATH may still be operator-specific;
verify its subprocess requirements on the receiving machine rather than assuming
that file existence proves portability.

## 3. Generate this machine's configuration

Run from the clone after `npm run setup`. Use the intended claimed Moltbook
agent name, not a person's name or a newly invented account identity:

```bash
npm run setup:hermes -- --account YOUR_CLAIMED_MOLTBOOK_AGENT
source .local/hermes/env.sh
```

For an alternative location:

```bash
npm run setup:hermes -- \
  --account YOUR_CLAIMED_MOLTBOOK_AGENT \
  --publisher-script "/absolute/path/to/publish_moltbook_action.py"
```

Generated files are ignored by Git:

- `.local/hermes/moltbook-publisher.json`: account, clone/outbox paths, secret
  references, domain allowlist, configured cycle/daily caps and cooldown.
- `.local/hermes/env.sh`: shell-quoted paths for Node, Python, publisher script,
  publisher config and the engine's local config directory. No secrets.
- `.local/config/*.yaml`: safe copies for this operator. Existing config files
  are preserved; the generator refuses to overwrite an existing Hermes setup.

Inspect the configured caps against current platform rules and the team's pilot
scope. Values in the generated config are local ceilings, not statements of the
platform's allowed rate. Keep lock, cap, request and receipt state under the same
durable local handoff directory. Moving the clone requires updating paths.

## 4. Provision credentials privately

If the Moltbook account does not yet exist, the account owner must use the
platform's official registration/claim flow and finish the human claim step.
An engine clone does not register or claim an account.

Follow [Machine-local secrets](../../README.md#machine-local-secrets) in the
README for Keychain service/account names and hidden prompts. Provision the
Moltbook key for the intended claimed agent, a separate HMAC contract secret,
and the actual tracker token. The contract secret and key ID must agree between
engine and publisher. Never store keys in this repository, a model prompt,
a run report or a shared shell script.

The same provider key may permit both reads and writes; references separate
components but do not narrow the key's provider permissions. Public article
reads do not need that key at all. Keep production credentials on the designated
publisher host.

## 5. Verify without publication

```bash
command -v hermes
hermes --version
hermes gateway status
python3 --version
npm run doctor:live
node dist/cli/main.js doctor --live-read --publisher
```

The publisher preflight reads the script/config files and verifies matching
clone, pending and handoff paths. It does not execute the Python publisher.
A disabled bridge/engaged kill switch is expected before activation. Every FAIL
must be resolved. Gateway status alone does not establish publisher readiness.

The legacy `--validate-only` publisher mode is network-free but can create a lock
and directories, and quarantine malformed pending files. For a rehearsal, use a
disposable copy with a corresponding config whose project/pending/handoff paths
all point to that copy. Include a known valid signed action fixture and malformed
cases from the publisher's own test suite. An empty queue validates zero actions.
It does not prove credential access, grant/receipt handling or publication.

Do not run the legacy validation mode against production pending files under the
assumption that it is filesystem read-only. Do not fabricate production actions
or grants just to test installation.

## 6. Activate a one-action pilot

Use [Production setup](../../README.md#production-setup-is-separate-from-the-clone)
and [Production preflight](../../README.md#production-preflight-and-one-off-run).
Enable gates only in the reviewed local config. Load `.local/hermes/env.sh` and
privately expose the tracker token in the same terminal. Apply fresh short-lived
kill-switch clearance, then:

```bash
npm run live -- \
  --article-url "https://marx.finance/feed/REPLACE_WITH_FEED_ID" \
  --actions 1 --publish
```

The engine invokes the exact configured Python publisher once after successful
QA/tracker preparation. No scheduler is installed by `setup:hermes` or `live`.
Verify the permalink, author, exact content read-back and tracker status, then
engage the kill switch again. Use the separate
[feed scheduling runbook](../hermes-feed-production.md) only after a verified
pilot and an explicit scheduling decision; never run competing schedulers for
the same account/outbox.

## 7. Recovery and operator handover

`PUBLISHED` requires the provider comment ID, exact GET content read-back and
matching author, target, body and signed receipt. `VERIFICATION_REQUIRED` is
terminal until the account owner handles the platform requirement through an
authorized flow. `RECONCILIATION_REQUIRED` and `READBACK_MISSING` are not success:
inspect provider and tracker state before retrying. Preserve pending files,
receipts, SQLite, locks and cap state as evidence.

For a publishing-host handover, stop the old host and scheduler, engage its kill
switch, reconcile uncertain writes, and transfer a consistent private snapshot
of the stopped runtime state. Configure fresh local credentials and paths on the
new host. Keep one active publishing host per account. Independent clones cannot
coordinate shared caps or duplicate history automatically.
