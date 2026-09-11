import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FixtureMoltbookSource, fixturePost } from "../../src/discovery";
import { SolOrchestrator } from "../../src/orchestrator";
import { LocalOutbox } from "../../src/outbox";
import { actionIdFor, commentHash } from "../../src/domain/identifiers";
import { appendTrackedMarxLink } from "../../src/tracking";

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

  it("derives action and experiment identity from the final tracked comment", async () => {
    const post = fixturePost({
      postId: "tracked-action-post",
      url: "https://www.moltbook.com/post/tracked-action-post",
      submolt: "markets",
      content: "Agents should compare independent evidence behind a market signal before acting.",
    });
    const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts: [post] })).run({
      runId: "run_tracked_identity",
      dryRun: true,
      sourceMode: "live_read_only",
      discoveryLimit: 1,
      targetActions: 1,
      includeSourceLink: false,
      allowedDomains: ["www.moltbook.com"],
      preparePublishableCandidate: async ({ candidate }) => {
        const trackingUrl = "https://marx-tracker.marxx.workers.dev/r/abcdefghijklmnopqrstuv";
        return {
          candidate: { ...candidate, comment: appendTrackedMarxLink(candidate.comment, trackingUrl) },
          tracking: { ref: "abcdefghijklmnopqrstuv", trackingUrl, environment: "development" },
          finalize: async () => undefined,
        };
      },
    });
    const action = result.actions[0];
    expect(action).toBeDefined();
    expect(action?.content.comment).toContain("[Open Marx feed]");
    expect(action?.actionId).toBe(actionIdFor(action!.target.postId, action!.content.comment, action!.content.strategyFamily));
    expect(action?.experiment.experimentId).toBeDefined();
    expect(result.experiments[0]?.commentHash).toBe(commentHash(action!.content.comment));
  });

  it("turns a tracker preparation failure into NO_ACTION instead of a direct-link action", async () => {
    const post = fixturePost({
      postId: "tracker-failure-post",
      url: "https://www.moltbook.com/post/tracker-failure-post",
      submolt: "markets",
      content: "Agents should compare independent evidence behind a market signal before acting.",
    });
    const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts: [post] })).run({
      runId: "run_tracker_failure",
      dryRun: true,
      sourceMode: "live_read_only",
      discoveryLimit: 1,
      targetActions: 1,
      allowedDomains: ["www.moltbook.com"],
      preparePublishableCandidate: async () => { throw new Error("tracker unavailable"); },
    });
    expect(result.actions).toHaveLength(0);
    expect(result.noActions[0]?.reason).toBe("PUBLISHING_RISK");
    expect(result.summary.errors).toBeGreaterThan(0);
  });
});
