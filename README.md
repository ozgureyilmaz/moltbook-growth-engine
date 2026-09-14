# Marx Moltbook Growth Engine — Operator and Agent Guide

Install a fresh clone, find Moltbook conversations related to a supplied Marx
feed, generate source-grounded comments, and publish from your own claimed
Moltbook account. A coding agent or Hermes can follow the same guide.

**Start with a read-only draft. Publication requires a separate explicit command
and your own account credentials.** Passing this file to an agent alone does
not authorize posting. Successful tests do not prove live account permissions.

## 1. Obtain the required access

| Requirement | Supplied by | Purpose |
| --- | --- | --- |
| Private GitHub repository access and tested branch/commit | Project maintainer | Clone/update |
| macOS or Linux, Git, bash/zsh, Node 22, Python 3.10+ | Operator | Local engine and publisher |
| Compatible Codex CLI, operator login and configured-model access | Operator | Real generation/evaluation |
| Existing `https://marx.finance/feed/…` URL | Operator or maintainer | Article, replies and related-post discovery |
| Claimed Moltbook agent name and its API key | Account owner | Authenticated reads/publication |
| Authorized production tracker token | Marx Tracker service owner | Attribution link creation/finalization |
| Publishing host, account scope, caps and recovery contact | Team | Account/state ownership |

Use a durable local filesystem for SQLite, outbox and locks. Native Windows
publishing is unsupported; WSL must be treated and verified as Linux. One shared
Moltbook account needs **one active publishing host and one durable state store**.
Independent clones do not coordinate duplicate history, cooldowns or daily caps.

`MARX_TRACKER_API_TOKEN` is the client credential for the separate team service
at `https://marx-tracker.marxx.workers.dev`, corresponding to its Worker secret
`ENGINE_API_TOKEN`. It is not a Moltbook key or Cloudflare account API token.
Do not invent it. If it has not been supplied privately, complete draft setup
and stop before publishing setup. Tracker redirect requests do not prove human
clicks or Marx usage.

## 2. Clone the delivery branch

Until the PR is merged, use the branch explicitly. If the target folder exists,
inspect it instead of replacing it. Record the commit in your handoff.

```bash
git clone --branch codex/team-onboarding --single-branch https://github.com/ozgureyilmaz/moltbook-growth-engine.git
cd moltbook-growth-engine
git branch --show-current
git rev-parse --short HEAD
```

Run the remaining commands from this directory. For later releases, use the
branch/tag supplied by the maintainer; a default clone may be an older version.

## 3. Install runtimes and build

```bash
git --version
command -v nvm
python3 --version
```

If nvm is missing, follow the [official nvm installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating),
reopen the terminal and return to the clone. On macOS, install Xcode Command
Line Tools if Git/native compilation needs them (`xcode-select --install`).
On Debian/Ubuntu, install Git, curl, Python 3.10+ and the C/C++ build toolchain
through the system package manager. The owner completes any OS installation prompts.

```bash
nvm install 22.17.0
nvm use 22.17.0
node --version
node -p 'process.versions.modules'
npm run setup
```

Expected baseline: Node `v22.17.0`, ABI `127`. Setup runs `npm ci`, builds `dist/`,
and performs an isolated fixture rehearsal. Expect `Setup passed` and zero
errors. Fixture comments are sample data; no model or platform call occurs in
that rehearsal. The ordinary operator DB/outbox is preserved. Never reinstall
dependencies while another run uses them.

Team wrappers automatically select an installed Node 22 when another Node major
is active. They inspect `MARX_GROWTH_NODE`, nvm installations, common Homebrew
paths and PATH, verifying the actual executable. They do not install Node or
change the global shell default. Direct `npm ci`, `npm test`, `npm run build`
and `npm run cli` still require Node 22 selected in the shell.

If native SQLite reports an ABI mismatch, select Node 22 and rerun setup. Do not
copy node_modules/dist from another machine. Record dependency advisories;
do not perform a forced major upgrade as part of onboarding.

## 4. Connect the operator's Codex account

Install Codex through the [official CLI installation guide](https://learn.chatgpt.com/docs/codex/cli).
Never copy another operator's Codex home/authentication files.

If it is absent, install the npm CLI version checked for this release after
selecting Node 22 (or use the official standalone installer):

```bash
npm install -g @openai/codex@0.154.0
```

```bash
codex --version
codex login status
```

If not authenticated, the owner completes browser/device login:

```bash
codex login --device-auth
codex login status
```

The engine uses this local CLI session without a separate model API key. Its
default real model is `gpt-5.6-luna`; access and usage limits must be verified on
each account. If Codex is outside PATH, set `MARX_GROWTH_CODEX_BIN` to its absolute
executable path in the same terminal. Do not switch publication to mocks when
model access fails. The [verification report](docs/verification/team-onboarding.md)
records the CLI tested for this release.

```bash
npm run doctor:live
```

This probes official public Moltbook search and one actual structured model
request. All requested checks must pass. The publication kill switch being
engaged is an expected warning during read-only work. A version-only check
cannot prove model availability or authentication.

## 5. Discover related posts and generate quoted drafts

Copy an actual Marx feed URL from the browser; replace `FEED_ID` below.

```bash
npm run live -- --article-url "https://marx.finance/feed/FEED_ID" --limit 8 --search-limit 10 --actions 5 --with-agent-quotes --output reports/
```

This reads the Marx article and available agent replies, searches related
Moltbook posts, fetches their context, scores opportunities, generates real-model
comments and applies independent evaluation plus deterministic QA. All external
content remains untrusted data. The default live path creates direct-link drafts
and Markdown/JSON reports in `reports/`; it needs no Moltbook key, tracker token
or Hermes and makes no comment POST or tracker distribution.

`--with-agent-quotes` permits a complete source-grounded agent quote when one is
available. It does not guarantee one on every comment; absent/unusable evidence
is omitted. Use `--no-agent-quotes` to disable quotes. If every comment must
contain a quote, review candidates and use a feed with usable agent replies;
this flag is not a mandatory-quote gate. Old accessible feeds are usable for
testing but may return `NO_ACTION` for weak relevance or saturated conversations.

`--limit` bounds posts examined; `--search-limit` bounds each search query;
`--actions` is constrained by QA. This is related **Moltbook post discovery for
the supplied feed**. This branch does not automatically choose a new Marx feed
or install a feed schedule. Publishing reruns discovery/generation and may
produce different text; it does not publish a previous draft report verbatim.

## 6. Configure the publishing account once

If the account is already used through Hermes, use that same claimed Moltbook
name/key. Hermes model login is separate and does not create a Moltbook account.
New account owners follow [Moltbook's official registration/claim process](https://www.moltbook.com/skill.md)
and finish the human claim step. Do not create a duplicate account to repair
missing local credentials.

```bash
npm run setup:publish -- --account YOUR_CLAIMED_MOLTBOOK_AGENT
```

Enter `MOLTBOOK_API_KEY` and `MARX_TRACKER_API_TOKEN` through the hidden terminal
prompts. A separate random HMAC contract secret is generated locally if none
was supplied. In non-interactive agent runs, the owner must inject these named
environment variables privately before setup. Never put secrets in chat,
command arguments, model prompts or logs.

Setup creates ignored `.local/publish/settings.json`, `publisher-config.json`,
`secrets.json` and `config/`. Files use mode 600 and private directories mode 700.
These are local plaintext secrets protected by OS permissions, not an encrypted
vault. Existing setup is refused before collecting new secrets. Setup makes no
remote authorization claim and posts nothing. Keep the directory private.

Check the full publishing environment without posting:

```bash
npm run publish -- --check-only --article-url "https://marx.finance/feed/FEED_ID" --with-agent-quotes
```

This loads the saved config, verifies paths/permissions, Python and the actual
claimed Moltbook identity, probes tracker authorization, and checks source,
article and model access. It does not clear the kill switch, create tracker
distributions or post a comment. Resolve every reported failure first.

## 7. Publish an explicitly authorized pilot

Execute only when the operator has authorized the named account, feed and action
limit. Use **`npm run publish`**, not npm's package-upload command `npm publish`.

```bash
npm run publish -- --article-url "https://marx.finance/feed/FEED_ID" --limit 8 --search-limit 10 --actions 1 --with-agent-quotes --output reports/
```

The wrapper loads local secrets/config, acquires an operation lock, blocks
unresolved previous work, runs preflight, creates a fresh 30-minute signed
clearance, checks autonomous readiness, and invokes the tracked cycle once.
Cleanup engages the kill switch before releasing the lock; cleanup failure is
an error. SIGKILL, shutdown and disk failure cannot guarantee cleanup: preserve
the lock/state and reconcile before recovery.

The cycle creates/finalizes attribution links after candidate approval. The
publisher receives only this run's action IDs, verifies signed grants/hashes
and account identity, enforces persistent caps/cooldown, rechecks the kill switch
before POST, and records attempts durably. Exact provider read-back and a
verified signed receipt import are required for success.

The default pilot requests one action. After a verified pilot, increase to the
configured cap if appropriate (for example `--actions 5`). The cycle requires
the full requested batch to pass before handoff: four eligible comments out of
five requested means no handoff. Provider failures may still leave a partially
published batch. Inspect each receipt; never assume external delivery is atomic.

Stop using the dedicated local configuration:

```bash
npm run publish -- --stop
```

A write may already be in flight; stop does not undo a posted comment. Inspect
reports/receipts before any new publication.

## 8. Let Hermes or another agent follow this guide

Hermes is optional for one-shot publication. If desired, install it from the
[official Hermes quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart),
run `hermes setup`, and verify a basic chat. Use the terminal backend on the
designated host and clone. Keep the Codex login and Moltbook key separate from
Hermes's own model-provider login. Do not copy an entire teammate profile.

Give an agent this README and a concrete preparation task:

> Read README.md and AGENTS.md in the supplied clone. Prepare dependencies and
> run local checks plus a quoted live draft for FEED_URL. Preserve existing files
> and runtime state. Report the commit, command exit codes and report paths, never
> credentials. If login, claim or private input is missing, pause that dependent
> step and state exactly what the owner must complete. Do not post, clear a kill
> switch, register an account or schedule work unless my task authorizes it.

For a pilot, the owner can add this explicit scope:

> I authorize one comment from ACCOUNT for FEED_URL. After successful check-only
> preflight, run the documented publish command with --actions 1 and
> --with-agent-quotes. Do not change credentials, bypass QA, rewrite approved
> text or retry uncertain writes. Return a permalink only for a verified signed
> publication receipt, then confirm the kill switch is engaged.

Agents may prepare local config and run tests within the assigned task. The
human completes interactive account login/claim or supplies secrets privately.
Do not invent account names, tokens, IDs or approval. A missing optional source
quote must be reported honestly. Adding a schedule is a separate decision after
a successful pilot; this guide installs no cron. Stop legacy outbox consumers
before using this command for the same account. Existing external installations
can consult the [legacy Hermes runbook](docs/runbooks/HERMES_PUBLISHER_SETUP.md).

## 9. Interpret results and recover

| Result | Meaning and response |
| --- | --- |
| `Setup passed` | Fixture setup succeeded; no live account/publication proof. |
| `DRAFTS_READY` | Local reviewable drafts; zero publications. |
| `NO_ACTION` / insufficient qualified targets | No eligible batch. Inspect QA/context; do not weaken thresholds. |
| `PUBLISHED`, provider permalink and imported receipt | Verified external comment; retain the evidence. |
| `VERIFICATION_REQUIRED` | Platform challenge. Not verified publication; this integration does not solve it. |
| `RECONCILIATION_REQUIRED` / previous attempt / missing read-back | A write may exist. Do not rerun or delete evidence automatically. |
| Lock or pending guard | Prior work/process exists. Identify the owner and reconcile; never automatically steal a lock. |
| Account mismatch / tracker 401 | Ask the credential owner for the correct access privately. |
| Model unavailable / login expired / quota | Resolve account access; no mock fallback for publication. |
| Missing runtime / ABI mismatch / stale build | Select Node 22, install Python 3.10+, rerun setup with no active run. |
| Insecure permissions / moved clone | Repair only the named local ownership/paths deliberately. |
| Shell `dquote>` | Closing quote missing before the app starts. Ctrl+C, then paste the complete command. |

Draft reports are `.md`/`.json` in `reports/`. Tracked cycles write a Markdown
status report and terminal JSON. Handoff requests, receipts and attempt evidence
are in the configured outbox handoff directory. Detailed diagnostics are in
`logs/runs/` and `logs/errors/`; errors before a workflow starts may appear only
in the terminal. A run ID is not publication proof. Share redacted summaries,
never the private setup directory.

After selecting Node 22, `npm run cli -- status RUN_ID` reads normal local state.
Uncertain-write recovery checks the exact account, target, body, request and
receipt together. There is no blanket reset-and-retry command. Contact the
recovery owner rather than deleting pending files or manufacturing receipts.

## 10. Validate and update

```bash
nvm use 22.17.0
npm run typecheck
npm test
npm run test:publisher
npm run build
npm run cli -- run --fixture ./tests/fixtures/moltbook.json --dry-run
npm run cli -- daemon --once --fixture ./tests/fixtures/moltbook.json --dry-run
```

Tests use fixture/mocked providers, never real comments. The
[verification report](docs/verification/team-onboarding.md) records passed
checks and limits. CI covers macOS/Linux clean clones and another shell Node
version. Live permissions, network failures, platform rules, model quotas and
quality eligibility can still cause legitimate failures.

Before updating, stop runs and back up consistent DB/outbox/cap/attempt state
privately. From a clean checkout:

```bash
git pull --ff-only
npm run setup
npm run doctor:live
```

Inspect divergence/local edits instead of forcing Git. Recheck publication
setup after a move or account change. When migrating a shared account's host,
keep the old host stopped, transfer consistent runtime state privately and
re-provision secrets separately. A fresh clone must not reset account history.

## Maintainer delivery checklist

Supply repository access; a tested branch/tag or commit and this guide; an
accessible sample Marx feed with usable agent replies; the authorized tracker
token privately and its owner/rotation contact; account scope, pilot caps and
one designated publishing host; and a contact/procedure for platform challenges,
uncertain receipts and recovery. The operator supplies their own Codex login
and claimed Moltbook credentials, or receives authorized team account access
privately. The HMAC contract secret is generated locally.

Do not deliver personal credentials, whole Hermes/Codex profiles, node_modules,
unreviewed pending actions or a database for a different account. Shared config
remains read-only. Engineering contracts are in [AGENTS.md](AGENTS.md),
[the publisher ADR](docs/adr/0006-bundled-publisher.md),
[the outbox ADR](docs/adr/0004-outbox-and-outcome-attribution.md), and versioned
prompts/schemas/tests. The runtime has three bounded worker roles; model output
never replaces deterministic QA or the signed publisher boundary.
