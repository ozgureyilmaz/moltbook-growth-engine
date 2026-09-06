# Hermes Publisher Setup

This runbook connects one claimed Hermes/Moltbook agent to the engine's
external publisher boundary. It does not change the engine into a Moltbook
writer. The publisher skill is the only component allowed to use the Moltbook
write credential.

## 0. Register and claim the agent

Choose the final Hermes agent name, then run the official registration request
from the Hermes host:

```bash
/usr/bin/curl --fail --silent --show-error --location \
  -X POST https://www.moltbook.com/api/v1/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"REPLACE_WITH_AGENT_NAME","description":"A research-oriented AI agent for evidence-backed discussions."}'
```

The response contains a claim URL and the new Moltbook API key. Open the claim
URL in the visible browser and complete the human claim step. Do not paste the
API key into chat, a prompt, a repository file, or a request/receipt. Store it
only through the engine's Keychain flow in the next step.

## 1. Fixed publisher config

Create `~/.hermes/data/moltbook-publisher.json` with the claimed agent name.
The file contains no credential:

```json
{
  "account": "REPLACE_WITH_CLAIMED_AGENT_NAME",
  "project_dir": "/Users/0x79de/Documents/ChatGPT/moltbook-growth-engine",
  "pending_dir": "/Users/0x79de/Documents/ChatGPT/moltbook-growth-engine/outbox/pending",
  "handoff_dir": "/Users/0x79de/Documents/ChatGPT/moltbook-growth-engine/outbox/handoff",
  "credential_service": "marx-moltbook-growth-engine",
  "credential_account": "moltbook-read-client",
  "contract_keychain_service": "marx-moltbook-growth-engine",
  "contract_keychain_account": "publisher-contract",
  "contract_key_id": "contract-v1",
  "allowed_domains": ["www.moltbook.com"],
  "max_actions_per_cycle": 5,
  "daily_comment_cap": 50,
  "comment_cooldown_seconds": 20,
  "request_timeout_seconds": 30
}
```

The publisher also creates a lock and daily-cap state file under
`outbox/handoff/`; keep both files on the same durable local filesystem as the
engine outbox.

The same Moltbook key may identify the claimed agent for reads and writes, but
the publisher contract secret must be separate. Store that contract secret in
Keychain with a hidden prompt; never paste it into chat or a file:

```bash
/usr/bin/security add-generic-password -U \
  -s marx-moltbook-growth-engine \
  -a publisher-contract \
  -w
```

## 2. Read-only validation

Run the publisher script with `--validate-only`. This reads pending action
files, validates the official target and action hash, and performs no network
request:

```bash
/opt/homebrew/bin/python3 \
  /Users/0x79de/.hermes/skills/automation/moltbook-deterministic-publisher/scripts/publish_moltbook_action.py \
  --config /Users/0x79de/.hermes/data/moltbook-publisher.json \
  --validate-only
```

Before any write, complete the engine read-only rehearsal:

```bash
cd /Users/0x79de/Documents/ChatGPT/moltbook-growth-engine
env PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:/Users/0x79de/.local/bin:/usr/bin:/bin \
  npm run cli -- doctor --live-read
env PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:/Users/0x79de/.local/bin:/usr/bin:/bin \
  npm run cli -- run --live-read --dry-run --limit 10 --actions 0
```

## 3. Publisher invocation

The deterministic script can be invoked once by the Hermes agent or attached
to a Hermes `cron create` job with `--no-agent --script`. Hermes accepts cron
scripts from `~/.hermes/scripts/`; the installed wrapper is
`moltbook_publisher.py`. Do not attach a model prompt that can rewrite or
regenerate the action.

```bash
env PATH=/Users/0x79de/.nvm/versions/node/v22.17.0/bin:/Users/0x79de/.local/bin:/usr/bin:/bin \
  hermes cron create "every 5m" \
  --name moltbook-deterministic-publisher \
  --script moltbook_publisher.py \
  --no-agent \
  --failure-deliver local
```

The script publishes only after the engine has been configured for
`authorized_autonomous`, the kill switch is cleared, the request and grant
signatures verify, and the pre-write exact-content readback succeeds. It never
calls Moltbook `/verify`.

## 4. Receipt and failure semantics

- `PUBLISHED` requires provider comment ID, exact GET content readback, and the
  claimed publisher account as the comment author.
- `VERIFICATION_REQUIRED` is terminal for that action; do not solve the
  challenge or retry automatically.
- `RECONCILIATION_REQUIRED` is terminal until an operator reconciles the
  provider state.
- The engine imports the signed receipt and acknowledges the outbox only after
  request, account, target, body, receipt, and contract signatures match.

## 5. Activation gate

Do not set `source.mode=authorized_autonomous`,
`publishing.enabled=true`, or `publisher_bridge.enabled=true` until the
claimed agent, publisher config, contract secret, Hermes service, read probe,
synthetic receipt cases, rollback owner, and pilot cap have been verified.
