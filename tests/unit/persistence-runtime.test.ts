import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeExperimentRecord } from "../../src/experiments";
import { makeActionPayload } from "../../src/outbox";
import { type SqliteDatabase } from "../../src/persistence/database";
import { applyMigrations } from "../../src/persistence/migrations";
import { SqliteRuntimePersistence } from "../../src/persistence/runtime";
import { createMarxOutcomeEvent, ingestVerifiedOutcomeEvents } from "../../src/telemetry";
import type {
  ConversationContext,
  EvaluationResult,
  GeneratedCandidate,
  MoltbookPost,
  Opportunity,
  RunSummary,
} from "../../src/orchestrator/contracts";
import type { TrackingDistribution } from "../../src/schemas";

function fixture() {
  const post: MoltbookPost = {
    postId: "post-source-42",
    url: "https://moltbook.local/post/post-source-42",
    submolt: "research",
    author: { id: "agent-42", name: "agent-42", type: "agent" },
    content: "How should agents validate a market signal against independent evidence?",
    createdAt: "2026-08-24T00:00:00.000Z",
    fetchedAt: "2026-08-24T00:01:00.000Z",
  };
  const context: ConversationContext = {
    post,
    replies: [],
    fetchedAt: post.fetchedAt,
    conversationText: post.content,
    marxMentions: 0,
    repeatedAngles: [],
    saturated: false,
    untrustedSignals: [],
  };
  const opportunity: Opportunity = {
    opportunityId: "opp_hash_is_not_the_post_id",
    post,
    context,
    scores: {
      semanticRelevance: 0.8,
      marxBridgeStrength: 0.8,
      agentAttentionProbability: 0.7,
      conversationFit: 0.8,
      engagementPotential: 0.5,
      novelty: 0.7,
      timing: 0.8,
      targetQuality: 0.7,
      spamRisk: 0.05,
      repetitionRisk: 0.05,
      contextMismatch: 0.05,
    },
    finalScore: 0.78,
    reason: "The source post has a concrete evidence question.",
    recommendedStrategies: ["signal_validation"],
  };
  const candidate: GeneratedCandidate = {
    candidateId: "cand-source-42",
    opportunityId: opportunity.opportunityId,
    strategyFamily: "signal_validation",
    hookFamily: "specific_claim",
    comment: "The useful next check is counter-evidence; Marx could help agents compare that signal against independent sources.",
    promptVersion: "generator-v1",
    modelVersion: "deterministic-v1",
  };
  const evaluation: EvaluationResult = {
    candidateId: candidate.candidateId,
    scores: {
      contextFit: 0.8,
      agentInterestProbability: 0.7,
      marxRelevance: 0.75,
      novelty: 0.8,
      usefulness: 0.8,
      naturalness: 0.9,
      conversationContribution: 0.8,
      nonSpamQuality: 0.9,
      brandFit: 0.8,
      likelihoodOfAgentFollowup: 0.7,
      likelihoodOfMarxInvestigation: 0.75,
      genericness: 0.05,
      promotionIntensity: 0.05,
      repetition: 0.05,
      unsupportedClaimRisk: 0.02,
    },
    overallScore: 0.8,
    confidence: 0.9,
    recommendation: "PUBLISH",
    reasons: ["contextual contribution"],
    modelVersion: "mock-evaluator-v1",
  };
  return { post, opportunity, candidate, evaluation };
}

function summary(runId: string): RunSummary {
  return {
    runId,
    startTime: "2026-08-24T00:00:00.000Z",
    endTime: "2026-08-24T00:02:00.000Z",
    discovered: 1,
    deduplicated: 1,
    analyzed: 1,
    qualified: 1,
    generated: 1,
    passedEvaluator: 1,
    actionsEmitted: 1,
    rejected: 0,
    errors: 0,
    modelCalls: 1,
    workerCalls: 1,
    dryRun: true,
  };
}

describe("SqliteRuntimePersistence attribution", () => {
  it("persists one idempotent, source-post-consistent chain without a runtime placeholder", async () => {
    const db = new Database(":memory:");
    applyMigrations(db as unknown as SqliteDatabase);
    const persistence = new SqliteRuntimePersistence(db as unknown as SqliteDatabase);
    const { opportunity, candidate, evaluation, post } = fixture();
    const runId = "run-attribution-42";

    persistence.saveOpportunity(opportunity);
    persistence.saveCandidate(candidate);
    persistence.saveEvaluation(evaluation);
    const experiment = makeExperimentRecord(runId, opportunity, candidate, evaluation);
    const action = makeActionPayload(runId, opportunity, candidate, evaluation, "2026-08-24T00:02:00.000Z");
    persistence.saveExperiment(experiment);
    persistence.saveAction(action);
    persistence.saveRun(summary(runId));

    persistence.saveOpportunity(opportunity);
    persistence.saveCandidate(candidate);
    persistence.saveEvaluation(evaluation);
    persistence.saveExperiment(experiment);
    persistence.saveAction(action);
    persistence.saveRun(summary(runId));

    expect(db.prepare("SELECT run_id, post_id FROM opportunities").all()).toEqual([{ run_id: runId, post_id: post.postId }]);
    expect(db.prepare("SELECT run_id, post_id, opportunity_id FROM comment_candidates").all()).toEqual([
      { run_id: runId, post_id: post.postId, opportunity_id: opportunity.opportunityId },
    ]);
    expect(db.prepare("SELECT run_id, candidate_id FROM evaluations").all()).toEqual([{ run_id: runId, candidate_id: candidate.candidateId }]);
    expect(db.prepare("SELECT action_id FROM actions").all()).toEqual([{ action_id: action.actionId }]);
    expect(persistence.getAction(action.actionId)).toMatchObject({ action: "COMMENT", actionId: action.actionId, metadata: { runId } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_attribution").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT DISTINCT run_id FROM runtime_attribution WHERE run_id = 'runtime'").all()).toEqual([]);

    expect(persistence.getExperimentAttribution(experiment.experimentId)).toEqual({
      runId,
      sourcePostId: post.postId,
      opportunityId: opportunity.opportunityId,
      candidateId: candidate.candidateId,
      actionId: action.actionId,
      experimentId: experiment.experimentId,
    });
    persistence.savePublication({
      publicationId: "receipt-uncertain-42",
      actionId: action.actionId,
      experimentId: experiment.experimentId,
      status: "failed",
      attemptedAt: "2026-08-24T00:02:30.000Z",
      errorMessage: "provider result unknown",
      metadata: { evidenceStatus: "unverified", targetPostId: post.postId },
    });
    persistence.savePublication({
      publicationId: "receipt-attribution-42",
      actionId: action.actionId,
      experimentId: experiment.experimentId,
      status: "published",
      attemptedAt: "2026-08-24T00:02:30.000Z",
      acknowledgedAt: "2026-08-24T00:03:00.000Z",
      metadata: { evidenceStatus: "verified", targetPostId: post.postId },
    });
    expect(persistence.getPublicationByActionId(action.actionId)).toMatchObject({ publicationId: "receipt-attribution-42", status: "published" });
    const usage = createMarxOutcomeEvent({
      eventType: "marx_used",
      actionId: action.actionId,
      experimentId: experiment.experimentId,
      runId,
      sourcePostId: post.postId,
      targetAgentId: post.author.id,
      value: true,
      source: "marx_product",
      evidenceStatus: "verified",
      evidenceId: "marx-usage-evidence-42",
      occurredAt: "2026-08-24T00:04:00.000Z",
      observedAt: "2026-08-24T00:05:00.000Z",
      consentState: "granted",
    });
    await ingestVerifiedOutcomeEvents(persistence, [usage]);
    expect(persistence.getExperiments()[0]?.outcome).toMatchObject({ marxUsageSignal: true });
    persistence.saveTrackingDistribution({
      ref: "abcdefghijklmnopqrstuv",
      trackingUrl: "https://marx-tracker.marxx.workers.dev/r/abcdefghijklmnopqrstuv",
      environment: "production",
      status: "ACTIVE",
      destinationUrl: "https://marx.finance/feed/feed-42",
      platform: "moltbook",
      contentType: "comment",
      feedId: "feed-42",
      sourcePostId: post.postId,
      sourceUrl: post.url,
      runId,
      opportunityId: opportunity.opportunityId,
      candidateId: candidate.candidateId,
      preLinkIdentity: "marx-tracker-prelink:test",
      idempotencyKey: "marx-tracker-distribution:test",
      actionId: action.actionId,
      experimentId: experiment.experimentId,
      commentHash: "a".repeat(64),
      totalRedirects: 0,
      clicked: false,
      firstClickedAt: null,
      lastClickedAt: null,
      createdAt: "2026-08-24T00:02:00.000Z",
      finalizedAt: "2026-08-24T00:02:01.000Z",
    });
    expect(persistence.getTrackingDistributionByActionId(action.actionId)).toMatchObject({
      ref: "abcdefghijklmnopqrstuv",
      status: "ACTIVE",
      experimentId: experiment.experimentId,
    });
    db.close();
  });

  it("persists tracking identity and redirect metrics in the local attribution table", () => {
    const db = new Database(":memory:");
    applyMigrations(db as unknown as SqliteDatabase);
    const persistence = new SqliteRuntimePersistence(db as unknown as SqliteDatabase);
    const distribution: TrackingDistribution = {
      ref: "abcdefghijklmnopqrstuv",
      trackingUrl: "https://marx-tracker.marxx.workers.dev/r/abcdefghijklmnopqrstuv",
      environment: "production",
      status: "ACTIVE",
      destinationUrl: "https://marx.finance/feed/feed-1",
      platform: "moltbook",
      contentType: "comment",
      feedId: "feed-1",
      sourcePostId: "post-1",
      sourceUrl: "https://www.moltbook.com/post/post-1",
      runId: "run-tracking-1",
      opportunityId: "opp-1",
      candidateId: "candidate-1",
      preLinkIdentity: "prelink-1",
      idempotencyKey: "idempotency-1",
      actionId: "act-1",
      experimentId: "exp-1",
      commentHash: "a".repeat(64),
      totalRedirects: 3,
      clicked: true,
      firstClickedAt: "2026-09-10T00:00:00.000Z",
      lastClickedAt: "2026-09-10T00:03:00.000Z",
      createdAt: "2026-09-10T00:00:00.000Z",
      finalizedAt: "2026-09-10T00:00:01.000Z",
    };

    persistence.saveTrackingDistribution(distribution);

    expect(db.prepare("SELECT ref, status, action_id, experiment_id, comment_hash, total_redirects, clicked FROM tracking_distributions").all()).toEqual([{
      ref: distribution.ref,
      status: "ACTIVE",
      action_id: distribution.actionId,
      experiment_id: distribution.experimentId,
      comment_hash: distribution.commentHash,
      total_redirects: 3,
      clicked: 1,
    }]);
    expect(persistence.getTrackingDistributionByActionId("act-1")).toMatchObject(distribution);
  });

  it("persists the observed retry count in run metrics", () => {
    const db = new Database(":memory:");
    applyMigrations(db as unknown as SqliteDatabase);
    const persistence = new SqliteRuntimePersistence(db as unknown as SqliteDatabase);
    const value = summary("run-retry-metrics");
    value.retries = 4;

    persistence.saveRun(value);

    const row = db.prepare("SELECT counts_json FROM runs WHERE run_id = ?").get<{ counts_json: string }>(value.runId);
    expect(JSON.parse(row!.counts_json).retries).toBe(4);
  });
});
