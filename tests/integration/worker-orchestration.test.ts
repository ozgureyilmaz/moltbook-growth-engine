import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FixtureMoltbookSource } from "../../src/discovery";
import { SolOrchestrator } from "../../src/orchestrator";
import type { WorkerReport } from "../../src/orchestrator";
import type { MoltbookSource } from "../../src/discovery";
import { WorkerReportSchema } from "../../src/schemas";
import { DeterministicMockExecutor } from "../../src/models";
import { ModelEvaluationOutputSchema } from "../../src/evaluation";

describe("bounded Sol/Luna worker orchestration", () => {
  it("allocates the three closed worker roles, runs fixture work in parallel-safe batches, and persists compact reports", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/moltbook.json", import.meta.url), "utf8")) as ConstructorParameters<typeof FixtureMoltbookSource>[0];
    const reports: WorkerReport[] = [];
    const source = new FixtureMoltbookSource(fixture);
    const result = await new SolOrchestrator(source, {
      saveWorkerReport: (report) => reports.push(report),
    }).run({ runId: "worker-orchestration", dryRun: true, now: "2026-08-24T01:00:00.000Z" });

    expect(result.summary.evaluationMode).toBe("deterministic_mock");
    expect(new Set(reports.map((report) => report.worker))).toEqual(new Set([
      "discovery_context",
      "opportunity_analysis",
      "strategy_generation",
    ]));
    expect(reports.length).toBe(result.summary.workerCalls);
    expect(reports.every((report) => WorkerReportSchema.safeParse(report).success)).toBe(true);
    expect(reports.every((report) => report.findings.length <= 8 && report.errors.length <= 8)).toBe(true);
    expect(reports.every((report) => typeof report.metadata?.objective === "string" && report.metadata?.expectedOutputSchema && report.metadata?.retryPolicy)).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it("continues with a partial run when one bounded worker task exhausts its retries", async () => {
    const post = {
      postId: "worker-failure-post",
      url: "https://moltbook.local/post/worker-failure-post",
      submolt: "markets",
      author: { id: "agent-worker-failure", type: "agent" },
      content: "Agents should compare the provenance behind a market signal before acting.",
      createdAt: "2026-08-24T00:30:00.000Z",
      fetchedAt: "2026-08-24T00:35:00.000Z",
    };
    const source: MoltbookSource = {
      discoverPosts: async () => [post],
      fetchPostContext: async () => { throw new Error("context unavailable"); },
    };
    const result = await new SolOrchestrator(source).run({
      runId: "worker-failure",
      dryRun: true,
      now: "2026-08-24T01:00:00.000Z",
      workerMaxAttempts: 1,
    });
    expect(result.summary.workerCalls).toBe(1);
    expect(result.summary.errors).toBe(1);
    expect(result.summary.failureReceipts?.some((receipt) => receipt.kind === "worker_failure")).toBe(true);
    expect(result.summary.errorMessages?.some((message) => message.includes("context unavailable"))).toBe(true);
    expect(result.summary.actionsEmitted).toBe(0);
  });

  it("uses the ModelExecutor boundary for all three worker roles in real-model mode", async () => {
    const post = {
      postId: "worker-model-post",
      url: "https://moltbook.local/post/worker-model-post",
      submolt: "markets",
      author: { id: "agent-worker-model", type: "agent" },
      content: "Agents should compare the provenance behind a market signal before acting.",
      createdAt: "2026-08-24T00:30:00.000Z",
      fetchedAt: "2026-08-24T00:35:00.000Z",
    };
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      handler: async (task) => task.kind === "candidate_evaluation"
        ? ModelEvaluationOutputSchema.parse({
          scores: Object.fromEntries(["contextFit", "agentInterestProbability", "marxRelevance", "novelty", "usefulness", "naturalness", "conversationContribution", "nonSpamQuality", "brandFit", "likelihoodOfAgentFollowup", "likelihoodOfMarxInvestigation", "genericness", "promotionIntensity", "repetition", "unsupportedClaimRisk"].map((key) => [key, 0.9])),
          overallScore: 0.9, confidence: 0.9, recommendation: "PUBLISH", reasons: ["model fixture"],
        })
        : { ok: true, summary: `advisory for ${task.worker}`, concerns: [] },
    });
    const reports: WorkerReport[] = [];
    const modelRuns: unknown[] = [];
    const result = await new SolOrchestrator({ discoverPosts: async () => [post], fetchPostContext: async () => ({ post, replies: [], fetchedAt: post.fetchedAt }) }, { saveWorkerReport: (report) => reports.push(report), saveModelRun: (record) => modelRuns.push(record) }).run({
      runId: "worker-model",
      dryRun: true,
      evaluationMode: "real_model",
      modelExecutor: executor,
      now: "2026-08-24T01:00:00.000Z",
    });
    expect(result.summary.evaluationMode).toBe("real_model");
    expect(result.summary.realModelEvaluations).toBeGreaterThan(0);
    expect(result.summary.modelCalls).toBeGreaterThanOrEqual(4);
    expect(reports.some((report) => Number(report.metrics?.modelWorkerCalls ?? 0) > 0)).toBe(true);
    expect(modelRuns.length).toBeGreaterThan(0);
  });

  it("keeps a broad opportunity pool but stops real-model generation after five accepted actions", async () => {
    const posts = Array.from({ length: 28 }, (_, index) => ({
      postId: `shortlist-post-${index + 1}`,
      url: `https://moltbook.local/post/shortlist-post-${index + 1}`,
      submolt: "markets",
      author: { id: `shortlist-agent-${index + 1}`, name: `shortlist-agent-${index + 1}`, type: "agent" },
      content: "Agents compare evidence and market signal provenance before making a decision.",
      createdAt: "2026-08-24T00:30:00.000Z",
      fetchedAt: "2026-08-24T00:35:00.000Z",
      engagement: { replies: 8, reactions: 12 },
    }));
    let generationCalls = 0;
    let evaluationCalls = 0;
    let generationTimeout: number | undefined;
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      maxConcurrent: 2,
      handler: async (task) => {
        if (task.kind === "candidate_generation") {
          generationCalls += 1;
          generationTimeout = task.timeoutMs;
          const input = task.input as { allowedStrategyFamilies?: string[] };
          return {
            candidates: [{
              strategyFamily: input.allowedStrategyFamilies?.[0] ?? "provenance",
              hookFamily: "specific_claim",
              comment: "Marx adds a concrete provenance check to this market signal before agents act: compare which independent sources each agent saw before treating agreement as evidence.",
            }],
          };
        }
        if (task.kind === "candidate_evaluation") {
          evaluationCalls += 1;
          const scoreKeys = ["contextFit", "agentInterestProbability", "marxRelevance", "novelty", "usefulness", "naturalness", "conversationContribution", "nonSpamQuality", "brandFit", "likelihoodOfAgentFollowup", "likelihoodOfMarxInvestigation", "genericness", "promotionIntensity", "repetition", "unsupportedClaimRisk"];
          return {
            scores: Object.fromEntries(scoreKeys.map((key) => [key, key === "genericness" || key === "promotionIntensity" || key === "repetition" || key === "unsupportedClaimRisk" ? 0.02 : 0.95])),
            overallScore: 0.95,
            confidence: 0.95,
            recommendation: "PUBLISH",
            reasons: ["bounded model fixture"],
          };
        }
        throw new Error(`unexpected model task kind: ${task.kind}`);
      },
    });
    const reports: WorkerReport[] = [];
    const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts }), {
      saveWorkerReport: (report) => reports.push(report),
    }).run({
      runId: "bounded-specific-generation",
      dryRun: true,
      evaluationMode: "real_model",
      modelExecutor: executor,
      modelGenerateComments: true,
      discoveryLimit: 100,
      targetActions: 5,
      fillTargetActions: true,
      strategyGenerationBatchSize: 5,
      strategyGenerationTaskBudget: 10,
      scoringThreshold: 0,
      workerMaxAttempts: 1,
      modelMaxAttempts: 1,
      modelTimeoutMs: 120_000,
      now: "2026-08-24T01:00:00.000Z",
    });

    expect(result.summary.discovered).toBe(28);
    expect(result.summary.qualified).toBe(28);
    expect(result.summary.actionsEmitted).toBe(5);
    expect(result.summary.errors).toBe(0);
    expect(generationCalls).toBe(5);
    expect(evaluationCalls).toBe(5);
    expect(generationTimeout).toBe(120_000);
    expect(reports.filter((report) => report.worker === "strategy_generation")).toHaveLength(5);
  });

  it("stops the strategy pipeline after the configured consecutive worker failure budget", async () => {
    const posts = Array.from({ length: 5 }, (_, index) => ({
      postId: `failure-budget-post-${index + 1}`,
      url: `https://moltbook.local/post/failure-budget-post-${index + 1}`,
      submolt: "markets",
      author: { id: `failure-budget-agent-${index + 1}`, name: `failure-budget-agent-${index + 1}`, type: "agent" as const },
      content: "Agents compare evidence and market signal provenance before making a decision.",
      createdAt: "2026-08-24T00:30:00.000Z",
      fetchedAt: "2026-08-24T00:35:00.000Z",
    }));
    let generationCalls = 0;
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      handler: async (task) => {
        if (task.kind === "candidate_generation") {
          generationCalls += 1;
          throw new Error("model unavailable");
        }
        throw new Error(`unexpected model task kind: ${task.kind}`);
      },
    });

    const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts })).run({
      runId: "strategy-failure-budget",
      dryRun: true,
      evaluationMode: "real_model",
      modelExecutor: executor,
      modelGenerateComments: true,
      discoveryLimit: 5,
      targetActions: 5,
      fillTargetActions: true,
      strategyGenerationBatchSize: 1,
      strategyGenerationTaskBudget: 5,
      strategyGenerationFailureBudget: 2,
      scoringThreshold: 0,
      workerMaxAttempts: 1,
      modelMaxAttempts: 1,
      now: "2026-08-24T01:00:00.000Z",
    });

    expect(generationCalls).toBe(2);
    expect(result.summary.errors).toBe(2);
    expect(result.summary.actionsEmitted).toBe(0);
  });
});
