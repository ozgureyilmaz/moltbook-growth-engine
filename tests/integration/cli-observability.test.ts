import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureMoltbookSource } from "../../src/discovery";
import { runCli } from "../../src/cli";
import { SolOrchestrator, type RunContext } from "../../src/orchestrator";
import { emitActionPublished, emitOutcomeObserved, silentLogger } from "../../src/telemetry";
import type { PersistenceLike, RunSummary } from "../../src/orchestrator";

const fixturePath = new URL("../fixtures/moltbook.json", import.meta.url).pathname;

function storedRun(runId: string): RunSummary {
  return {
    runId,
    startTime: "2026-08-24T01:00:00.000Z",
    endTime: "2026-08-24T01:01:00.000Z",
    discovered: 3,
    deduplicated: 3,
    analyzed: 3,
    qualified: 1,
    generated: 4,
    passedEvaluator: 1,
    actionsEmitted: 1,
    rejected: 0,
    errors: 0,
    modelCalls: 0,
    workerCalls: 3,
    dryRun: true,
  };
}

describe("CLI and growth observability handoff", () => {
  it("keeps fixture runs local, carries run context, and labels mock evaluation truthfully", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ConstructorParameters<typeof FixtureMoltbookSource>[0];
    const contexts: RunContext[] = [];
    const runs: RunSummary[] = [];
    const persistence: PersistenceLike = {
      saveOpportunity: (_opportunity, context?: unknown) => { if (context) contexts.push(context as RunContext); },
      saveRun: (summary) => { runs.push(summary); },
      getRecentComments: () => [],
      getExperiments: () => [],
    };
    const output: string[] = [];
    const cliResult = await runCli(["run", "--fixture", fixturePath, "--dry-run"], { persistence, stdout: (line) => output.push(line) });

    expect(cliResult).toContain("Dry run:            true");
    expect(cliResult).toContain("Evaluation mode:    deterministic_mock");
    expect(cliResult).toContain("Real model calls:   0");
    expect(cliResult).toContain("Source mode:        fixture");
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((context) => context.runId && context.dryRun && context.evaluationMode === "deterministic_mock")).toBe(true);
    expect(runs).toHaveLength(1);
    expect(output).toHaveLength(1);
    expect(fixture.posts.length).toBe(3);
  });

  it("requires stored input before replay and identifies a replay as dry-run", async () => {
    const persistence: PersistenceLike = {
      getRun: (runId) => runId === "run_known" ? storedRun(runId) : undefined,
      saveRun: () => undefined,
      getRecentComments: () => [],
      getExperiments: () => [],
    };
    const output: string[] = [];
    const replay = await runCli(["replay", "run_known", "--fixture", fixturePath], { persistence, stdout: (line) => output.push(line) });
    expect(replay).toContain("Replay of:          run_known");
    expect(replay).toContain("Dry run:            true");
    await expect(runCli(["replay", "run_missing", "--fixture", fixturePath], { persistence, stdout: () => undefined })).rejects.toThrow("unknown run");
    await expect(runCli(["replay", "run_known"], { persistence, stdout: () => undefined })).rejects.toThrow("requires --fixture");
  });

  it("emits versioned publication and outcome events only when explicitly handed those facts", () => {
    const logger = silentLogger("run_events");
    const published = emitActionPublished(logger, { runId: "run_events", actionId: "act_1", experimentId: "exp_1", occurredAt: "2026-08-24T01:00:00.000Z" });
    const observed = emitOutcomeObserved(logger, {
      runId: "run_events",
      actionId: "act_1",
      experimentId: "exp_1",
      occurredAt: "2026-08-24T01:05:00.000Z",
      properties: { replyReceived: true },
    });
    expect(published.eventVersion).toBe("1.0");
    expect(observed.event).toBe("outcome_observed");
    expect(logger.entries().map((entry) => entry.event)).toEqual(["action_published", "outcome_observed"]);
    expect(logger.entries().every((entry) => entry.actionId === "act_1" && entry.experimentId === "exp_1")).toBe(true);
  });

  it("does not expose a false run listing when the persistence adapter cannot list runs", async () => {
    const text = await runCli(["status"], { persistence: {}, stdout: () => undefined });
    expect(text).toContain("does not expose run listing");
  });

  it("rejects production handoff from fixture or unverified injected source modes", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "moltbook-production-gate-"));
    await writeFile(join(configDirectory, "system.yaml"), "execution:\n  dry_run_by_default: false\npublishing:\n  enabled: true\nsafety:\n  allowed_domains: [moltbook.example]\n", "utf8");
    await writeFile(join(configDirectory, "submolts.yaml"), "submolts:\n  include: []\n  exclude: []\nlookback:\n  hours: 24\ncandidate_limit:\n  per_run: 100\n", "utf8");
    await writeFile(join(configDirectory, "experiments.yaml"), "candidate_generation:\n  count: 4\nstrategy_selection:\n  exploration_rate: 0.25\n  exploitation_rate: 0.75\nstrategy_families: [provenance]\n", "utf8");
    await expect(runCli(["run", "--fixture", fixturePath, "--dry-run=false"], { configDirectory, persistence: {}, stdout: () => undefined }))
      .rejects.toThrow("authorized Moltbook source mode");
  });
});
