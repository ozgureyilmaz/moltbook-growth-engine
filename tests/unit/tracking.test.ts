import { describe, expect, it, vi } from "vitest";
import { appendTrackedMarxLink, preLinkIdentityFor } from "../../src/tracking/links";
import { MarxTrackerHttpClient, TrackerHttpError } from "../../src/tracking/client";
import { createTrackedCandidatePreparer } from "../../src/tracking/prepare";
import type { ActionPayload, EvaluationResult, GeneratedCandidate, Opportunity } from "../../src/orchestrator/contracts";

describe("Marx tracker integration", () => {
  it("builds a stable pre-link identity without depending on the final comment", () => {
    const first = preLinkIdentityFor({
      runId: "run-1",
      opportunityId: "opp-1",
      candidateId: "candidate-1",
      sourcePostId: "post-1",
      strategyFamily: "marx_discussion_bridge",
    });
    const second = preLinkIdentityFor({
      runId: "run-1",
      opportunityId: "opp-1",
      candidateId: "candidate-1",
      sourcePostId: "post-1",
      strategyFamily: "marx_discussion_bridge",
      finalComment: "this value must not affect the pre-link identity",
    });
    expect(first).toBe(second);
  });

  it("appends exactly the required tracked link label", () => {
    expect(appendTrackedMarxLink("Marx is useful here.", "https://marx-tracker.marxx.workers.dev/r/abc")).toBe(
      "Marx is useful here. [Open Marx feed](https://marx-tracker.marxx.workers.dev/r/abc)",
    );
  });
  it("keeps the tracked link after an agent quote and its source thread", () => {
    const quoted = "Marx can help agents compare the signal. A related agent note from metalhead says: \u201cCompare the signal with independent evidence.\u201d ([source thread](https://marx.finance/feed/feed-1)).";
    const trackingUrl = "https://marx-tracker.marxx.workers.dev/r/quoted";
    const comment = appendTrackedMarxLink(quoted, trackingUrl);

    expect(comment.indexOf("[source thread]")).toBeLessThan(comment.indexOf("[Open Marx feed]"));
    expect(comment.endsWith(`[Open Marx feed](${trackingUrl})`)).toBe(true);
  });

  it("validates a successful create response and sends the bearer token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ref: "abcdefghijklmnopqrstuv",
      trackingUrl: "https://marx-tracker.marxx.workers.dev/r/abcdefghijklmnopqrstuv",
      destinationUrl: "https://marx.finance/feed/feed-1",
      status: "pending",
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new MarxTrackerHttpClient({
      baseUrl: "https://marx-tracker.marxx.workers.dev",
      token: "tracker-secret",
      fetcher,
      maxAttempts: 1,
    });

    const result = await client.createDistribution({
      ref: "abcdefghijklmnopqrstuv",
      preLinkIdentity: "prelink:one",
      destinationUrl: "https://marx.finance/feed/feed-1",
      platform: "moltbook",
      contentType: "comment",
      feedId: "feed-1",
      sourcePostId: "post-1",
      sourceUrl: "https://www.moltbook.com/post/post-1",
      runId: "run-1",
      opportunityId: "opp-1",
      candidateId: "candidate-1",
      idempotencyKey: "tracker-prelink:one",
    });

    expect(result.status).toBe("pending");
    expect(fetcher).toHaveBeenCalledWith(
      "https://marx-tracker.marxx.workers.dev/v1/distributions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer tracker-secret" }),
      }),
    );
  });

  it("treats tracker conflicts as failures rather than success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "ref_conflict" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));
    const client = new MarxTrackerHttpClient({
      baseUrl: "https://marx-tracker.marxx.workers.dev",
      token: "tracker-secret",
      fetcher,
      maxAttempts: 2,
    });

    await expect(client.createDistribution({
      ref: "abcdefghijklmnopqrstuv",
      preLinkIdentity: "prelink:one",
      destinationUrl: "https://marx.finance/feed/feed-1",
      platform: "moltbook",
      contentType: "comment",
      feedId: "feed-1",
      sourcePostId: "post-1",
      sourceUrl: "https://www.moltbook.com/post/post-1",
      runId: "run-1",
      opportunityId: "opp-1",
      candidateId: "candidate-1",
      idempotencyKey: "tracker-prelink:one",
    })).rejects.toMatchObject<Partial<TrackerHttpError>>({ status: 409, code: "ref_conflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("finalizes attribution with the final linked comment hash", async () => {
    const records: Array<Record<string, unknown>> = [];
    const client = {
      createDistribution: vi.fn().mockResolvedValue({
        ref: "abcdefghijklmnopqrstuv",
        trackingUrl: "https://marx-tracker.marxx.workers.dev/r/abcdefghijklmnopqrstuv",
        destinationUrl: "https://marx.finance/feed/feed-1",
        status: "pending",
      }),
      finalizeDistribution: vi.fn().mockResolvedValue({
        ref: "abcdefghijklmnopqrstuv",
        status: "active",
        actionId: "act-final",
        experimentId: "exp-final",
        commentHash: "a".repeat(64),
      }),
      getSummary: vi.fn().mockResolvedValue({
        ref: "abcdefghijklmnopqrstuv",
        clicked: false,
        totalRedirects: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        status: "active",
      }),
      revokeDistribution: vi.fn(),
    };
    const candidate: GeneratedCandidate = {
      candidateId: "candidate-1",
      opportunityId: "opp-1",
      runId: "run-1",
      sourcePostId: "post-1",
      strategyFamily: "marx_discussion_bridge",
      hookFamily: "specific_claim",
      comment: "Treasury and inflation move together, and Marx helps agents compare whether policy repricing is confirmed across assets.",
      promptVersion: "generator-v1",
      modelVersion: "deterministic-v1",
    };
    const opportunity = {
      opportunityId: "opp-1",
      runId: "run-1",
      sourcePostId: "post-1",
      post: {
        postId: "post-1",
        url: "https://www.moltbook.com/post/post-1",
        submolt: "finance",
        author: { id: "agent-1", name: "agent" },
        content: "Treasury yields and inflation repricing are splitting the market.",
        createdAt: "2026-09-09T10:00:00.000Z",
        fetchedAt: "2026-09-09T10:00:00.000Z",
      },
      context: {
        post: {
          postId: "post-1",
          url: "https://www.moltbook.com/post/post-1",
          submolt: "finance",
          author: { id: "agent-1", name: "agent" },
          content: "Treasury yields and inflation repricing are splitting the market.",
          createdAt: "2026-09-09T10:00:00.000Z",
          fetchedAt: "2026-09-09T10:00:00.000Z",
        },
        replies: [],
        fetchedAt: "2026-09-09T10:00:00.000Z",
        conversationText: "POST (agent): Treasury yields and inflation repricing are splitting the market.",
        marxMentions: 0,
        repeatedAngles: [],
        saturated: false,
        untrustedSignals: [],
      },
      scores: {
        semanticRelevance: 0.9,
        marxBridgeStrength: 0.9,
        agentAttentionProbability: 0.8,
        conversationFit: 0.9,
        engagementPotential: 0.8,
        novelty: 0.8,
        timing: 0.8,
        targetQuality: 0.8,
        spamRisk: 0.1,
        repetitionRisk: 0.1,
        contextMismatch: 0,
      },
      finalScore: 0.85,
      reason: "specific Treasury and inflation bridge",
      recommendedStrategies: ["marx_discussion_bridge"],
    } satisfies Opportunity;
    const preparer = createTrackedCandidatePreparer({
      client,
      environment: "development",
      feedId: "feed-1",
      destinationUrl: "https://marx.finance/feed/feed-1",
      persistence: { saveTrackingDistribution: async (value) => records.push(value as unknown as Record<string, unknown>) },
    });
    const prepared = await preparer({
      runId: "run-1",
      opportunity,
      context: opportunity.context,
      candidate,
      evaluation: {} as EvaluationResult,
      previousComments: [],
      createdAt: "2026-09-09T10:00:00.000Z",
    });
    const action = {
      actionId: "act-final",
      action: "COMMENT",
      content: { comment: prepared.candidate.comment, strategyFamily: candidate.strategyFamily, hookFamily: candidate.hookFamily },
    } as unknown as ActionPayload;
    await prepared.finalize(action, { experimentId: "exp-final" } as never);

    expect(prepared.candidate.comment).toContain("[Open Marx feed]");
    expect(client.finalizeDistribution).toHaveBeenCalledWith("abcdefghijklmnopqrstuv", expect.objectContaining({ actionId: "act-final", experimentId: "exp-final" }));
    expect(records.map((record) => record.status)).toEqual(["PENDING", "ACTIVE"]);
    expect(records[1]?.commentHash).toBeDefined();
  });
});
