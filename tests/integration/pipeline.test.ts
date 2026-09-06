import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FixtureMoltbookSource, fixturePost } from "../../src/discovery";
import { SolOrchestrator } from "../../src/orchestrator";
import { LocalOutbox } from "../../src/outbox";

describe("growth vertical slice", () => {
  it("discovers, ranks, evaluates and emits validated dry-run actions", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/moltbook.json", import.meta.url), "utf8")) as ConstructorParameters<typeof FixtureMoltbookSource>[0];
    const source = new FixtureMoltbookSource(fixture);
    const outbox = new LocalOutbox("/tmp/moltbook-growth-test-outbox");
    const orchestrator = new SolOrchestrator(source, {}, outbox);
    const result = await orchestrator.run({ runId: "run_fixture", discoveryLimit: 100, targetActions: 5, dryRun: true, now: "2026-08-24T01:00:00.000Z" });

    expect(result.summary.discovered).toBe(3);
    expect(result.summary.analyzed).toBe(3);
    expect(result.summary.actionsEmitted).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.action === "COMMENT" && /\bmarx\b/i.test(action.content.comment))).toBe(true);
    expect(result.logs.some((entry) => entry.event === "run_finished")).toBe(true);
  });

  it("validates official live targets in a live-read dry-run", async () => {
    const post = fixturePost({
      postId: "official-dry-run-post",
      url: "https://www.moltbook.com/post/official-dry-run-post",
      submolt: "markets",
      content: "Agents should compare independent evidence behind a market signal before acting.",
    });
    const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts: [post] })).run({
      runId: "run_official_dry_run",
      sourceMode: "live_read_only",
      discoveryLimit: 1,
      targetActions: 1,
      dryRun: true,
      allowedDomains: ["www.moltbook.com"],
      now: post.createdAt,
    });
    expect(result.summary.errors).toBe(0);
    expect(result.summary.actionsEmitted).toBeGreaterThan(0);
  });
});
