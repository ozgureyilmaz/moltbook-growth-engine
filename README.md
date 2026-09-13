# Marx Moltbook Growth Engine

Local, autonomous, experiment-driven infrastructure for finding high-value
Moltbook conversations and preparing context-specific Marx outreach for an
existing publishing agent.

The engine owns discovery, context analysis, candidate generation, evaluation,
deterministic QA, tracking-link attribution, and the signed publisher handoff.
The separate publisher agent owns the Moltbook write credential and the actual
platform interaction:

```text
discover -> understand context -> rank opportunity -> generate candidates
-> evaluate -> deterministic QA -> validated JSON action -> local outbox
-> existing Moltbook publishing agent
```

The downstream agent owns authentication and the actual Moltbook interaction.
This project never needs to bypass platform controls or keep the publisher
write credential.

## Choose your operating mode

Start with live drafts. Configure the external publisher only on the machine
that will own production publication.

| Mode | What it does | Required setup |
| --- | --- | --- |
| Fixture smoke | Uses checked-in sample posts and deterministic mock evaluation. No platform or model calls. | Node 22 and dependencies. |
| Public live drafts (`npm run live`) | Reads a Marx article and public Moltbook search/context, generates and evaluates with real models, writes Markdown/JSON reports. No tracker writes or publication. | Node 22, dependencies, authenticated Codex CLI and access to the configured model. No Moltbook key or Hermes required. |
| Authorized source rehearsal (`run --live-read --dry-run`) | Reads through the authenticated Moltbook source adapter. | Also requires the Moltbook read key. Add `--real-model` for actual model evaluation. |
| Production publish | Creates production tracker distributions, prepares signed handoff files, and invokes the external publisher. | Everything in dry-run plus production config, tracker token, publisher contract secret, Hermes publisher, valid clearance, and provider read-back. |

Cloning the GitHub repository gives you the code and checked-in safe defaults.
It does not give you API keys, the local SQLite database, the production
configuration, the Hermes installation, or any other operator-machine state.

## Quick start after `git clone`

Prerequisites: access to this GitHub repository, Git, and a Node version manager
such as [nvm](https://github.com/nvm-sh/nvm#installing-and-updating). The supported
Node major is 22; `.nvmrc` pins the tested baseline to 22.17.0. Package installation
rejects other majors because the SQLite addon must match the Node ABI. macOS is
the current publisher platform. The public draft path is suitable for macOS and
Linux; the CI matrix covers both. Native Windows publishing is not supported by
the current external Keychain-based publisher.

```bash
git clone https://github.com/ozgureyilmaz/moltbook-growth-engine.git
cd moltbook-growth-engine

# The native SQLite dependency must be built for Node 22.
nvm install
nvm use
node --version                         # expected: v22.17.0
node -p 'process.versions.modules'     # expected: 127

npm run setup
npm run typecheck
npm test
```

`setup` runs `npm ci`, builds the CLI, then performs an isolated fixture smoke
test. It prints the temporary evidence directory and does not use your existing
database or inherited production configuration for that rehearsal. The install
step needs package-registry access; the fixture run needs no model/platform
access. Setup does not install Codex, Hermes, account credentials, or a scheduler.
If native compilation is needed, install your platform's compiler tools and
Python (Xcode Command Line Tools on macOS; a C/C++ toolchain on Linux).

## First live run

Complete [Codex authentication](#connecting-codex-exec), then run:

```bash
npm run doctor:live
npm run live -- \
  --article-url "https://marx.finance/feed/REPLACE_WITH_FEED_ID"
```

Use an existing Marx feed ID. `doctor:live` probes public Moltbook search and one
real model request. `live` repeats those checks and validates the supplied Marx
article before running. A failed mandatory check exits nonzero and prevents the
workflow from starting. An engaged publication kill switch is a warning during
read-only work, not a blocker. A model smoke proves model access at that moment;
individual generation/evaluation calls can still fail or hit account limits.

The default one-shot run examines up to 8 related posts with a per-query search
limit of 10 and requests up to 5 validated drafts. These are limits, not a promise
of five results. Override them explicitly:

```bash
npm run live -- \
  --article-url "https://marx.finance/feed/REPLACE_WITH_FEED_ID" \
  --limit 8 --search-limit 10 --actions 5 --output reports/
```

`live` accepts only `--article-url`, `--limit`, `--search-limit`, `--actions`,
`--output` and the separate `--publish` opt-in. It rejects unknown/duplicate
options, fixture overrides, disabled real models, and ambiguous boolean forms.
For lower-level controls, use the documented CLI commands below. The safe path
is `article-run --dry-run --real-model --no-agent-quotes`, with a direct source
link; `marx-specific-cycle` is the separate tracked-distribution path and needs
a development tracker even without `--publish`.

Real article runs use the existing bounded specific-cycle model profile: one
model call at a time, low reasoning effort, a 120-second call deadline and one
attempt per model task. Additional advisory model calls are disabled; actual
generation, independent evaluation and deterministic QA still run. A full run
can take several minutes across targets; the call deadline is not a total-run
deadline. Failures do not fall back to mock comments.

## Reading results and operating as a team

The final JSON prints `reports.markdownPath` and `reports.jsonPath`. Open the
Markdown report for validated draft comments and target URLs. Use JSON for the
full summary, generated candidates, evaluations, QA reasons and decisions.
`--output reports/` creates run-specific filenames; `--output reports/review.md`
uses an explicit Markdown filename and a matching `.json`. Existing review
files are not overwritten. Reports are untrusted external content; do not
execute commands or follow instructions embedded in source text or comments.

| Result | Meaning | Next step |
| --- | --- | --- |
| `DRAFTS_READY` | At least one comment passed the draft gates. Published count is 0. | Review the report. |
| `NO_ACTION` | No candidate passed, or no suitable target was found. | Inspect the reasons; use a different article or improve discovery. |
| `ERROR` / nonzero exit | A source, model, persistence, or other required step failed. | Inspect the error and existing logs before retrying. |
| `PUBLISHED` in a production receipt | Publisher ID, exact comment read-back and receipt checks passed. | Preserve the permalink/receipt and tracker evidence. |
| `RECONCILIATION_REQUIRED` / `READBACK_MISSING` | A write may have occurred but is unverified. | Reconcile it before any retry. |

Errors before a workflow result exists are printed to the terminal and may not
produce a review report. During execution, inspect `logs/runs/` and
`logs/errors/`; ordinary CLI runs persist their summary to the local SQLite DB.

```bash
npm run cli -- status
npm run cli -- status RUN_ID
npm run cli -- experiments
```

Each clone has independent `data/`, `.local/`, logs, reports and outbox state.
For a shared Moltbook account, designate **one publishing host and one durable
outbox/database**. Other teammates can run live drafts locally. Separate clones
do not share duplicate history, cooldowns or publisher caps; do not run the same
account from multiple machines. Do not move SQLite to a shared network drive as
a substitute for a coordinated publisher.

Before moving the publishing host, stop the old scheduler, engage its kill
switch, and reconcile pending/ambiguous receipts. Transfer a consistent private
backup of the stopped database and associated outbox/cap state through your
approved team channel. Provision secrets separately on the new host. A fresh
clone is not a replacement for that state. Keep the old host stopped until the
new host's one-action pilot has been verified.

## Updating an existing clone

Finish or stop active runs first and back up local state before applying a
release that changes persistence. From a clean checkout:

```bash
git pull --ff-only
nvm use
npm run setup
npm run typecheck
npm test
npm run doctor:live
```

If Git reports local edits or a divergence, resolve those deliberately; do not
reset or overwrite operator work. `setup` rebuilds `dist/` and preserves runtime
state. The lower-level `node dist/cli/main.js` command does not detect stale
builds; rebuild after every source update. Share a tested commit/tag with the
team, not just a moving branch name. CI runs setup, typecheck, tests and fixture
CLI/daemon checks on clean macOS/Linux runners, with no credentials or live posts.

For the remaining setup and reference material: [credentials](#machine-local-secrets),
[production config](#production-setup-is-separate-from-the-clone),
[Hermes](#external-hermes-publisher),
[production run](#production-preflight-and-one-off-run),
[troubleshooting](#common-clone-failures), and
[CLI reference](#cli-and-safe-execution).

### Native SQLite troubleshooting

If `better-sqlite3` reports `NODE_MODULE_VERSION` or a missing native
binding, first confirm that `node --version` is 22.17.0. Then rebuild with the
Node 22 npm binary. This avoids a common macOS setup where a Node 26/Hermes
wrapper is selected during `node-gyp`:

```bash
NODE22_BIN="$(dirname "$(nvm which 22.17.0)")"
env -u npm_node_execpath -u npm_execpath \
  PATH="$NODE22_BIN:$PATH" \
  npm_config_build_from_source=true \
  "$NODE22_BIN/npm" rebuild better-sqlite3 --build-from-source

node -p 'process.versions.modules'     # expected: 127
npm run typecheck
npm test
npm run build
```

The `dist/` directory is intentionally ignored by Git, so every fresh clone
must run `npm run build` before using `node dist/cli/main.js`.

## Connecting Codex Exec

Model-backed runs use the local `codex` CLI as a child process. The engine does
not use a separate model API key and does not embed Codex credentials in the
repository. Each operator must authenticate Codex on the machine that will
run the engine.

Install the Codex CLI using the approved Codex installation method for the
operator's environment, then verify that the binary is visible:

```bash
command -v codex
codex --version
codex login status
```

If the session is not authenticated, use the device/browser login flow and
complete it in the visible browser:

```bash
codex login --device-auth
codex login status
```

The status command must show an authenticated session. Do not paste an access
token or API key into this README, a prompt, a GitHub issue, or a terminal
command that will be saved in shell history.

If `codex` is installed outside `PATH`, point the read-only model smoke test at
the exact binary:

```bash
export MARX_GROWTH_CODEX_BIN="/absolute/path/to/codex"
node dist/cli/main.js doctor --model-smoke
```

This smoke test makes one structured, read-only Codex call. It does not read
Moltbook, create a tracker link, create an outbox action, or publish anything.
For a live engine run, the same authenticated CLI session is used internally
by `CodexExecExecutor`; there is no second in-repository Codex connection to
configure.

## Machine-local secrets

Never commit secret values. The default macOS Keychain references used by this
repository are:

| Purpose | Keychain service | Keychain account |
| --- | --- | --- |
| Moltbook GET/read access | `marx-moltbook-growth-engine` | `moltbook-read-client` |
| Engine/Hermes contract HMAC | `marx-moltbook-growth-engine` | `publisher-contract` |
| Production tracker token | `marx-tracker-production` | `ENGINE_API_TOKEN` |

Create or update each entry with a hidden prompt. The value is never printed:

```bash
# Moltbook read key used by --live-read and production discovery.
/usr/bin/security add-generic-password -U \
  -s marx-moltbook-growth-engine \
  -a moltbook-read-client \
  -w

# Separate HMAC contract secret shared with the external publisher.
/usr/bin/security add-generic-password -U \
  -s marx-moltbook-growth-engine \
  -a publisher-contract \
  -w

# The value must match the active Cloudflare Worker secret ENGINE_API_TOKEN.
# Do not invent a different local value.
/usr/bin/security add-generic-password -U \
  -s marx-tracker-production \
  -a ENGINE_API_TOKEN \
  -w
```

For a production command, expose only the tracker token to the current shell
session. The engine reads the Moltbook and contract secrets directly from
Keychain:

```bash
export MARX_TRACKER_API_TOKEN="$(/usr/bin/security \
  find-generic-password -s marx-tracker-production \
  -a ENGINE_API_TOKEN -w)"
```

If the tracker token is rotated, update the Cloudflare Worker secret and this
Keychain entry as one coordinated change. A token stored only on an operator's
machine, or only in Cloudflare, is not sufficient.

## Live-read verification (still no publication)

After the Codex and read-key setup, run the read-only checks first:

```bash
node dist/cli/main.js doctor --live-read
node dist/cli/main.js run \
  --live-read \
  --dry-run \
  --limit 8 \
  --actions 0
```

`doctor --live-read` proves only that the configured official Moltbook GET
probe works. The bounded dry-run proves source retrieval, normalization,
ranking, generation, evaluation, and QA without writing to the publisher
outbox. A successful live-read check is not production-publish authorization.

## Production setup is separate from the clone

The checked-in `config/system.yaml` is intentionally safe:

- `source.mode: live_read_only`;
- `publishing.enabled: false`;
- `publisher_bridge.enabled: false`;
- `execution.dry_run_by_default: true`.

Do not edit those defaults in the shared branch just to enable one operator.
The recommended Hermes setup command below generates ignored `.local/config/`
copies with publishing disabled. Use those copies for this machine. For a
manually managed configuration outside the repository, the equivalent is:

```bash
export PROD_CONFIG_DIR="$PWD/../marx-growth-production-config"
mkdir -p "$PROD_CONFIG_DIR"
cp config/*.yaml "$PROD_CONFIG_DIR"/
```

Edit only the copied `system.yaml` and explicitly set the production gates:

```yaml
source:
  mode: authorized_autonomous

publishing:
  enabled: true

publisher_bridge:
  enabled: true
```

Keep the production tracker origin pinned to
`https://marx-tracker.marxx.workers.dev`, keep the allowed domain list
restricted to `www.moltbook.com`, and keep the Keychain references unchanged
unless the external publisher was configured with a different approved
contract. Point the process at this directory:

```bash
export MARX_GROWTH_CONFIG_DIR="$PROD_CONFIG_DIR"
```

Active production configuration is never generated by `npm ci` or `setup` and
is not included in GitHub. `setup:hermes` creates safe local copies only; every
operator must deliberately review activation and the three gates above.

## External Hermes publisher

The GitHub clone does not contain the Hermes publisher, its Python script, its
private Moltbook write credential, its publisher config, or its local lock/cap
state. The publisher must be installed and configured separately on the
machine that owns the Moltbook account.

Recommended arrangement: install Hermes normally on the publishing Mac and
transfer only the reviewed `moltbook-deterministic-publisher` skill directory
from the team's maintained publisher distribution. Do not copy a teammate's
entire `~/.hermes` directory, login tokens, memories, sessions, or private config.
Hermes installation alone does **not** provide this project-specific publisher.
Use the [official Hermes quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
for installation and `hermes setup`/`hermes model`, then verify a basic chat.
See [Hermes skills documentation](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)
for skill loading. The engine generates/evaluates comments through Codex Exec;
the deterministic publisher must not ask a model to rewrite approved comments.

Once the reviewed publisher skill is present:

```bash
npm run setup:hermes -- --account YOUR_CLAIMED_MOLTBOOK_AGENT
source .local/hermes/env.sh
```

For a non-default skill location, add `--publisher-script /absolute/path/to/publish_moltbook_action.py`.
This creates `.local/hermes/moltbook-publisher.json`, `.local/hermes/env.sh`,
and safe copies in `.local/config/`. Paths are derived from this clone and
the current Node executable. It refuses to overwrite existing Hermes setup
files. It does not enable publishing, register an account, install services,
or copy/provision secrets. The generated shell file contains paths only and
must be sourced in each new production terminal. Moving the clone requires
reviewing/regenerating these paths. `HERMES_HOME` is respected for default
publisher discovery; the current external publisher still needs macOS Keychain.

Before a publish, verify the external boundary:

```bash
command -v hermes
hermes --version
hermes gateway status
python3 --version
```

Create the publisher config from
[the Hermes setup runbook](docs/runbooks/HERMES_PUBLISHER_SETUP.md). Its
`project_dir`, `pending_dir`, and `handoff_dir` must point to the cloned
repository, and its `account` must be the intended claimed Moltbook account.
The publisher must use the same contract secret and `contract-v1` key ID as
the engine. The publisher's Moltbook write credential stays inside the
publisher's private secret store; it must never be copied into this repo.

If the publisher script or config is not in the default paths, set the
following environment variables before a production run:

```bash
export MOLTBOOK_PUBLISHER_PYTHON="$(command -v python3)"
export MOLTBOOK_PUBLISHER_SCRIPT="/absolute/path/to/publish_moltbook_action.py"
export MOLTBOOK_PUBLISHER_CONFIG="/absolute/path/to/moltbook-publisher.json"
```

The current external publisher's `--validate-only` mode makes no network request,
but can create lock/directories and quarantine malformed pending entries. Use
it on a disposable rehearsal copy of the outbox before activation, with a
corresponding rehearsal publisher config. Do not use it as a no-mutation check
against a live outbox. In that rehearsal environment:

```bash
"$MOLTBOOK_PUBLISHER_PYTHON" "$MOLTBOOK_PUBLISHER_SCRIPT" \
  --config "$MOLTBOOK_PUBLISHER_CONFIG" \
  --validate-only
```

`doctor --publisher` checks the configured publisher contract, Hermes gateway,
Python executable, script availability, and config/outbox path consistency.
It does not execute the publisher. An empty validation queue proves no action
validation. Neither check proves publisher-account credentials, tracker-token
authorization, or a successful publication; a one-action pilot with exact
read-back is required. `doctor --autonomous` verifies tracker-token presence,
not remote token validity. Tracker operations still validate their own responses.

## Production preflight and one-off run

Run every check from the same terminal environment that will launch the
production command:

```bash
node dist/cli/main.js doctor --live-read
node dist/cli/main.js doctor --publisher
node dist/cli/main.js doctor --model-smoke
node dist/cli/main.js ops kill-status
```

The requested checks must have no FAIL results. Before activation, disabled
publishing gates and the kill switch produce expected warnings. After the
reviewed local production config is enabled, the kill switch is cleared only for the
short, explicitly authorized publishing window. Create and apply a fresh
time-bounded clearance; never hand-edit an old clearance JSON file:

```bash
export CLEARANCE_FILE="$PWD/../marx-publish-clearance.json"
node dist/cli/main.js ops kill-clearance-create \
  --output "$CLEARANCE_FILE" \
  --minutes 30 \
  --reason "authorized one-off Marx feed publishing pilot" \
  --actor "operator"

node dist/cli/main.js ops kill-clear --clearance "$CLEARANCE_FILE"
node dist/cli/main.js ops kill-status
node dist/cli/main.js doctor --autonomous
```

Then replace `NEW_FEED_ID` with the target Marx feed ID and run the bounded
specific cycle:

```bash
npm run live -- \
  --article-url "https://marx.finance/feed/NEW_FEED_ID" \
  --limit 8 \
  --search-limit 10 \
  --actions 5 \
  --publish \
  --output reports/
```

`--limit` and `--search-limit` bound discovery; `--actions 5` is the requested
maximum/quality requirement, not permission to weaken QA. The engine publishes
no partial batch when it cannot produce five valid, distinct, tracker-finalized
actions. For a first canary on a new machine, use `--actions 1` and verify the
Moltbook permalink, exact comment read-back, tracker status, and report before
raising the cap.

When the run is complete, engage the kill switch again and preserve the report:

```bash
node dist/cli/main.js ops kill-engage \
  --reason "one-off publishing run completed" \
  --actor "operator"
```

Do not immediately rerun an interrupted or ambiguous production run. First
reconcile the provider permalink/read-back and tracker distribution. A
`RECONCILIATION_REQUIRED`, `READBACK_MISSING`, or ambiguous tracker response is
not a successful run and must not be treated as permission to retry blindly.

## What belongs in GitHub

Before pushing a clone for another operator, commit the intended source and
documentation changes, then inspect the staged file list. Do not push local
runtime state from the operator machine:

- safe to share: source, tests, prompts, checked-in safe config, README,
  `AGENTS.md`, and reviewed runbook documentation;
- do not share: `.env*` secrets, API keys, SQLite databases, logs containing
  sensitive content, `outbox/` state, kill-switch clearance files, publisher
  responses, or Hermes config/credentials;
- generated `docs/moltbook-runs/` files should be included only when they are
  intentionally curated evidence, not as an automatic dump of every local run.

The clone is reproducible only after the latest source fixes are committed and
the clean clone passes `npm ci`, typecheck, tests, build, Codex model smoke,
and the appropriate read-only health checks. A GitHub push of an uncommitted
working tree does not transfer those local changes.

## Common clone failures

| Symptom | Likely cause | Correct response |
| --- | --- | --- |
| `better-sqlite3` ABI or native binding error | Node 26/Hermes wrapper used to build an addon consumed by Node 22, or vice versa | `nvm use 22.17.0`, verify ABI `127`, then rebuild with the Node 22 npm binary. |
| `codex: command not found` | Codex CLI is not installed or not on `PATH` | Install/authenticate Codex, verify `codex --version`, or set `MARX_GROWTH_CODEX_BIN`. |
| Missing Moltbook secret | Keychain is per-machine and is not cloned from GitHub | Add `moltbook-read-client` with the hidden Keychain prompt, then run `doctor --live-read`. |
| Missing tracker token or tracker 401 | Local value does not match Cloudflare `ENGINE_API_TOKEN`, or the variable is absent | Reconcile the Worker secret and local Keychain entry; export `MARX_TRACKER_API_TOKEN` only for the run. |
| `CLEARANCE_EXPIRED` or kill switch engaged | Clearance is local, signed, and time-bounded | Create a new clearance after preflight; do not edit or reuse an expired file. |
| Hermes gateway/publisher unavailable | External Hermes installation/config is absent from the clone | Complete the Hermes runbook and validate the publisher boundary separately. |
| Fewer than five actions or publish refusal | Candidate pool, model, evaluator, QA, or tracker finalization did not provide five safe actions | Preserve the no-publication result; inspect the report and improve discovery/context. Never weaken QA just to fill the count. |
| `RECONCILIATION_REQUIRED` | A provider or tracker write may have happened but cannot be proven yet | Reconcile Moltbook and D1/tracker state before any retry. |
| `EBADENGINE` / Node 22 required | A different Node major is active | Run `nvm use` from the clone, then `npm run setup`; do not bypass engine checks. |
| `doctor is NOT_READY` | A requested check failed | Read the named FAIL check; the command exits nonzero before a live workflow starts. |
| Missing development tracker URL | The lower-level tracked cycle was used without a development tracker | Use `npm run live` for public drafts, or configure a separate development tracker. |
| Local Hermes config already exists | Setup refuses to overwrite machine state | Review `.local/hermes` and `.local/config` manually; preserve existing operator settings. |
| Model unavailable / timeout / account limit | Model or account access is insufficient, or a call failed | Resolve access and retry bounded read-only work; never switch publication to mock evaluation. |

### Configuration and compatibility reference

Run lower-level CLI commands from the repository root. The wrappers resolve
their own clone root; runtime paths in YAML are otherwise relative to the
working directory. `.env` files are **not automatically loaded**. Use your
shell's environment or the configured secret provider.

| Variable | Purpose |
| --- | --- |
| `MARX_GROWTH_CONFIG_DIR` | Directory containing `system.yaml`, `submolts.yaml`, `experiments.yaml`. |
| `MARX_GROWTH_DB` | Optional SQLite path override. Keep the engine and publisher on the same DB; the legacy external publisher may not forward this override, so prefer `storage.database_path` in their shared config. |
| `MARX_GROWTH_CODEX_BIN` | Absolute Codex executable path if it is absent from PATH. |
| `MOLTBOOK_API_KEY` | Used only when `source.secret_provider: environment` is explicitly configured. Default authorized reads use Keychain; public article drafts need no key. |
| `MARX_TRACKER_API_TOKEN` | Production tracker token, supplied privately per terminal/service. |
| `MARX_TRACKER_DEVELOPMENT_BASE_URL` / `MARX_TRACKER_DEVELOPMENT_API_TOKEN` | Separate development tracker used by tracked cycles without `--publish`. |
| `MARX_GROWTH_NODE` | Node executable passed to the external publisher; the engine launcher pins it to its own executable. |
| `MOLTBOOK_PUBLISHER_PYTHON`, `MOLTBOOK_PUBLISHER_SCRIPT`, `MOLTBOOK_PUBLISHER_CONFIG` | Explicit external publisher paths, generated by `setup:hermes`. |

The team entry points add no action-schema version change or database migration. `article-run
--real-model` now uses real generation as well as evaluation and includes the
canonical article source link. Existing scripts using `doctor` must now handle
nonzero exit status on any FAIL check; warnings remain nonfatal for read-only
checks, while autonomous preflight requires READY. Existing explicit publisher
path overrides continue to work. Prompt versions and deterministic QA thresholds
are unchanged. Local reports, `.local/`, credentials and runtime state stay out
of GitHub.

The included article-evidence fix preserves short full replies, extracts a
complete sentence from longer replies when possible, and omits a quote when no
usable excerpt is available. Article reply/evidence `quote` fields are now
optional; existing records with quotes remain valid. Consumers must handle an
absent quote. Action payload versions and existing stored actions are unchanged.

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
The checked-in `command.txt` runs only a fixture dry-run. A publish attempt
requires the normal authorized source mode,
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
