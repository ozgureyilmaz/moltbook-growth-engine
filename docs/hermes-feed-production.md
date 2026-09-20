# Marx feed checks through Hermes

The one-shot entrypoint is:

```bash
node dist/cli/main.js marx-feed-cycle --limit 8 --search-limit 10 --actions 5 --with-agent-quotes
```

It reads the official public `GET https://marx.finance/api/posts?sort=new&page=N`
endpoint, validates every page in the available listing, and records feed IDs in
the configured SQLite database. It then selects one pending feed, passes its
canonical URL to `marx-specific-cycle --article-url ... --real-model`, and records
the run ID and output path. It does not use a model to find or choose URLs.

The first successful check baselines the currently available feed. Only later
unseen IDs become pending work. To include the most recent existing feed on the
very first check, pass `--bootstrap latest`; this option has no effect after
initialization. A failed/incomplete check does not initialize or advance state.
Pins, reply changes, and reordered IDs do not cause a completed feed to run again.
Multiple new feeds remain queued and are processed oldest first, one per tick.
An empty first listing is a valid baseline; subsequently visible IDs are new.

The API's public listing defines visibility; the engine cannot detect posts the
API does not expose. It scans every available page up to `config/feed.yaml`'s
`max_pages`, and fails if the bound is exceeded, a page is malformed, totals
change mid-scan, or IDs repeat. It retries the read at the next scheduled tick.

## Separate check and execution commands

```bash
# Check and enqueue only: no model, tracker, Moltbook discovery, or publication.
node dist/cli/main.js marx-feed-check

# Read durable queue status without network calls.
node dist/cli/main.js marx-feed-status

# Check again, then run one pending feed through existing discovery/draft/QA.
node dist/cli/main.js marx-feed-cycle --limit 8 --search-limit 10 --actions 5
```

All commands use `MARX_GROWTH_DB` or `storage.database_path`, and the same
`MARX_GROWTH_CONFIG_DIR` as existing commands. Keep one canonical production DB.
`--feed-config <path>` overrides polling config only. The migration is additive
(version 5: stream, queue, resolution audit); existing action/outbox schemas and
prompts are unchanged. Use a separate temporary DB for smoke tests so they do not
consume the production baseline or pending feeds.

If an existing local config directory predates this feature, copy the reviewed
`config/feed.yaml` there or pass `--feed-config config/feed.yaml` explicitly.
Missing polling configuration is an error; the worker does not silently choose
new settings for an existing production directory.

## Production behavior

Adding `--publish` uses the existing production gates, real-model evaluation,
QA, production tracker, downstream publisher, and exact publication read-back.
Five actions retain the existing all-or-nothing QA requirement. A draft run can
complete with zero actions; that is a completed decision, not a publication.
Draft completion also consumes the feed: changing to `--publish` later does not
automatically publish previous drafts or replay completed feeds.

Production configuration, downstream publisher credentials, tracker token,
allowlists, and a valid time-bounded kill-switch clearance must already be
provisioned as described in the README. The polling command does not renew its
own clearance. A 30-minute pilot clearance does not authorize unattended runs
five hours later. The owner must choose an authorized operating window before
activating publication; expired clearance continues to block it.

Any cycle failure, malformed result, or unverified publication leaves
`review_required`. A process killed mid-cycle remains `running`. Either state
blocks new claims across feed-cycle processes. No automatic lease stealing or
publication retry occurs. The queue records a run ID before executing the child
workflow so crash investigation can find logs and receipts. This queue lock does
not lock manual `marx-specific-cycle` or existing daemons; operate one scheduler
and do not launch those concurrently against the same publishing account.

After stopping the original process and reconciling its exact tracker/outbox/
publisher state, explicitly resolve using the feed and claim IDs from status:

```bash
node dist/cli/main.js marx-feed-resolve \
  --feed-id FEED_ID --claim-id CLAIM_ID \
  --resolution skip \
  --reason 'Reconciled the existing run and receipts; do not regenerate this feed' \
  --confirm-reconciled
```

`skip` records a skipped decision, not a successful publication. Use `retry` only
after verifying that regeneration cannot duplicate an existing or uncertain
publication. Resolution is audited, requires the exact claim, and refuses a
`running` claim while its recorded local process is alive or its host cannot be
verified. Never put this resolution command in the cron job.

## Hermes installation on this machine

Use `every 5h`, not `0 */5 * * *`: the cron expression runs at 00, 05, 10, 15,
and 20, leaving only four hours from 20 to midnight. Hermes interval jobs depend
on its gateway being running and the machine being awake. Inspect existing jobs
before creating one; edit an existing matching job instead of creating duplicates.

```bash
hermes cron list
hermes cron status
```

Build and test under the repository's Node 22 version, then create this small
wrapper under Hermes' required scripts directory. This example prepares drafts;
append `--publish` only for an authorized production job with all gates ready.

```bash
mkdir -p "$HOME/.hermes/scripts"
cat > "$HOME/.hermes/scripts/marx-feed-cycle.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec bash /Users/0x79de/Documents/ChatGPT/moltbook-growth-engine/scripts/hermes-feed-cycle.sh \
  --limit 8 --search-limit 10 --actions 5 --with-agent-quotes
SH

hermes cron create 'every 5h' \
  --name marx-moltbook-feed-5h \
  --script marx-feed-cycle.sh --no-agent --deliver local \
  --workdir /Users/0x79de/Documents/ChatGPT/moltbook-growth-engine
```

The repository wrapper selects the `.nvmrc` Node version from the default nvm
directory. Set `MARX_FEED_NODE` to an absolute Node 22 path for other installations.
The existing setup's `MARX_GROWTH_NODE` is also honored when `MARX_FEED_NODE`
is unset. The installed Hermes scheduler currently defaults to a 3600-second
script timeout; verify `cron.script_timeout_seconds` or
`HERMES_CRON_SCRIPT_TIMEOUT` on the deployment host. A timeout preserves the
running feed claim for reconciliation instead of silently regenerating it.
Provision required secrets through the existing environment/Keychain setup;
never put token values in the wrapper or cron prompt. The wrapper stays silent
when there is no pending work. `--no-agent` avoids an extra Hermes LLM call;
the existing real-model engine still runs when a feed is pending.

Start the owner's intended gateway service only after inspecting other jobs:

```bash
hermes gateway install
hermes cron status
hermes cron list
hermes cron run JOB_ID
hermes cron runs JOB_ID
```

`cron run` requests the next scheduler tick; verify the durable attempt and the
feed status before reporting the job operational. Pause with `hermes cron pause
JOB_ID`. This document and repository implementation do not themselves install
or activate a cron job, grant publishing access, or prove a production run.

API reference: [Marx public API guide](https://marx.finance/agent-skill.md).
Hermes command syntax was checked against the locally installed CLI on
2026-09-13; recheck `hermes cron create --help` on the deployment host.

## Implementation verification (2026-09-13)

Node 22 typecheck and build passed. The combined working tree passed 30 test
files / 185 tests, including 24 feed adapter, persistence, and CLI tests. Fixture
`run --dry-run` and `daemon --once --dry-run` each completed with zero errors.
A separate temporary database was checked against the live public Marx API:
20 currently visible feeds were baselined, and the next wrapper invocation
exited successfully with no stdout. No Moltbook publication or production
baseline mutation was performed. The Hermes job and gateway were not activated.
