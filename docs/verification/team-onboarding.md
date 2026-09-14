# Team onboarding verification

This is release verification evidence for the `codex/team-onboarding` branch.
It records local and CI checks; it is not live publication proof.

## Passed checks

- Node 22.17.0 with native SQLite ABI 127.
- `npm run setup` on a clean clone, including fixture smoke run.
- TypeScript typecheck and production build.
- 176 Vitest tests, including article-source, source-driven discovery,
  publication contracts, preflight failure boundaries, and report output.
- Bundled publisher Python syntax and 2 Python unittest cases.
- Cross-language TypeScript/Python signed request and receipt verification without
  an HTTP write.
- Fixture CLI and one-shot daemon runs.
- CI clone checks on Ubuntu and macOS, including setup from a different shell
  Node major and Node 22 relaunch selection.

## What this does not prove

- A specific operator's Codex login, Moltbook claim, tracker authorization or
  provider rate limit.
- A provider POST, challenge resolution, exact production read-back or Marx usage.
- A current production tracker token or changing Moltbook platform rules.
- Safe multi-host operation. One account still needs one publishing host and
  one durable database/outbox owner.

The first production action remains a one-action pilot. Preserve all reports,
requests, receipts and attempt state, then increase the cap only after the
provider permalink, exact body, author and tracker status are verified.
