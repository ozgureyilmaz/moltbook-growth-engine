import { describe, expect, it } from "vitest";
import { buildConversationContext } from "../../src/context";
import { fixturePost, FixtureMoltbookSource } from "../../src/discovery";
import { scoreOpportunity } from "../../src/analysis";
import { generateCandidates } from "../../src/generation";
import { IndependentMockEvaluator, finalDecision } from "../../src/evaluation";
import { ExperimentEngine, makeExperimentRecord, StrategyStatsStore, updateExperimentOutcome } from "../../src/experiments";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnStrategyPriors } from "../../src/strategy";
import type { ExperimentRecord } from "../../src/orchestrator";

async function decisionFixture() {
  const post = fixturePost({
    postId: "decision-learning-post",
    submolt: "markets",
    content: "Agents keep agreeing on the same liquidity signal, but we need to know whether that consensus is independent or copied from one model.",
  });
  const source = new FixtureMoltbookSource({
    posts: [post],
    contexts: {
      [post.postId]: {
        replies: [{
          replyId: "decision-learning-reply",
          author: { id: "agent-reply", name: "reply-agent", type: "agent" },
          content: "Record which source each agent saw before calling it consensus.",
          createdAt: post.createdAt,
        }],
      },
    },
  });
  const context = buildConversationContext(await source.fetchPostContext(post.postId));
  const opportunity = scoreOpportunity(post, context, { now: post.createdAt, runId: "run-decision-learning" });
  const candidate = generateCandidates(opportunity, ["provenance"], { runId: "run-decision-learning" })[0]!;
  return { context, opportunity, candidate };
}

describe("decision and learning contracts", () => {
  it("propagates run and source attribution through scoring, generation, final evaluation, and experiments", async () => {
    const { context, opportunity, candidate } = await decisionFixture();
    const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
    const publish = finalDecision(
      candidate,
      context,
      { ...evaluation, overallScore: 0.7, confidence: 0.8, recommendation: "PUBLISH" },
      [],
      { runId: "run-decision-learning", createdAt: "2026-08-24T01:00:00.000Z", policy: { minimumEvaluationScore: 0.65, minimumConfidence: 0.75 } },
    );

    expect(opportunity.runId).toBe("run-decision-learning");
    expect(opportunity.sourcePostId).toBe(opportunity.post.postId);
    expect(candidate.runId).toBe("run-decision-learning");
    expect(candidate.sourcePostId).toBe(opportunity.post.postId);
    expect(publish.kind).toBe("publish");
    expect(publish.evaluation.runId).toBe("run-decision-learning");
    expect(publish.evaluation.sourcePostId).toBe(opportunity.post.postId);

    const experiment = makeExperimentRecord("run-decision-learning", opportunity, candidate, {
      overallScore: publish.evaluation.overallScore,
      scores: publish.evaluation.scores,
      modelVersion: publish.evaluation.modelVersion,
    });
    expect(experiment.runId).toBe("run-decision-learning");
    expect(experiment.sourcePostId).toBe(opportunity.post.postId);

    const runContextOpportunity = scoreOpportunity(opportunity.post, context, {
      now: opportunity.post.createdAt,
      runContext: { runId: "run-context-attribution" },
    });
    expect(runContextOpportunity.runId).toBe("run-context-attribution");
    expect(runContextOpportunity.sourcePostId).toBe(opportunity.post.postId);
  });

  it("applies an explicit final-decision policy and retains safe NO_ACTION behavior", async () => {
    const { context, candidate } = await decisionFixture();
    const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
    const blocked = finalDecision(
      candidate,
      context,
      { ...evaluation, overallScore: 0.7, confidence: 0.8, recommendation: "PUBLISH" },
      [],
      "run-policy",
      { minimumEvaluationScore: 0.75, minimumConfidence: 0.75 },
    );

    expect(blocked.kind).toBe("no_action");
    expect(blocked.decision.reason).toBe("QUALITY_BELOW_THRESHOLD");
    expect(blocked.decision.metadata.runId).toBe("run-policy");

    const missingContext = finalDecision(
      candidate,
      { ...context, conversationText: "" },
      { ...evaluation, overallScore: 0.95, confidence: 0.95, recommendation: "PUBLISH" },
      [],
      "run-missing-context",
    );
    expect(missingContext.kind).toBe("no_action");
    expect(missingContext.decision.reason).toBe("CONTEXT_MISSING");
  });

  it("learns only from declared Marx investigation, interaction, and usage signals", () => {
    const priors = learnStrategyPriors([
      { strategyFamily: "provenance" },
      { strategyFamily: "provenance", outcome: { targetAgentEngaged: true, replyReceived: true } },
      { strategyFamily: "provenance", outcome: { marxInvestigationSignal: true } },
      { strategyFamily: "provenance", outcome: { marxInteractionSignal: true } },
      { strategyFamily: "provenance", outcome: { marxUsageSignal: true } },
      { strategyFamily: "provenance", outcome: { replyReceived: true, reactionCount: 20 } },
    ]);

    expect(priors).toHaveLength(1);
    expect(priors[0]).toMatchObject({ strategyFamily: "provenance", trials: 5, successes: 3 });
    expect(priors[0]!.posterior).toBeCloseTo(4 / 7);
  });

  it("normalizes the legacy discussion-visit signal without losing experiment history", async () => {
    const { context, opportunity, candidate } = await decisionFixture();
    const record = makeExperimentRecord("run-legacy", opportunity, candidate, {
      overallScore: 0.8,
      scores: {},
      modelVersion: "test-evaluator",
    });
    const updated = updateExperimentOutcome(record, { marxDiscussionVisitSignal: true });
    expect(updated.outcome?.marxInvestigationSignal).toBe(true);

    const engine = new ExperimentEngine([record]);
    expect(engine.update(record.experimentId, { marxInteractionSignal: true })?.sourcePostId).toBe(context.post.postId);
    expect(engine.priors()[0]).toMatchObject({ trials: 1, successes: 1 });
  });

  it("keeps experiment records structurally attributable when older callers omit optional fields", () => {
    const record: ExperimentRecord = {
      experimentId: "exp-legacy",
      runId: "run-legacy",
      sourcePlatform: "moltbook",
      sourceSubmolt: "markets",
      sourcePostId: "post-legacy",
      sourceUrl: "https://moltbook.local/post-legacy",
      hookFamily: "specific_claim",
      strategyFamily: "provenance",
      model: "deterministic",
      modelVersion: "deterministic-v1",
      promptVersion: "generator-v1",
      templateVersion: "strategy-v1",
      commentHash: "hash",
      semanticCluster: "cluster",
      opportunityScore: 0.7,
      publisherStatus: "pending",
    };
    const engine = new ExperimentEngine([record]);
    expect(engine.all()[0]).toMatchObject({ runId: "run-legacy", sourcePostId: "post-legacy" });
  });

  it("rebuilds strategy statistics idempotently from durable outcomes", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-strategy-stats-"));
    try {
      const { context, opportunity, candidate } = await decisionFixture();
      const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
      const experiment = { ...makeExperimentRecord("run-stats", opportunity, candidate, evaluation), outcome: { marxUsageSignal: true } };
      const store = new StrategyStatsStore(join(root, "stats.json"));
      await store.replaceExperiments([{ experiment }]);
      await store.replaceExperiments([{ experiment }]);
      expect((await store.load())[0]).toMatchObject({ trials: 1, northStarSuccesses: 1 });
      await rm(root, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
