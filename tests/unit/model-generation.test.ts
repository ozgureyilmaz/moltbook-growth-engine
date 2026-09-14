import { describe, expect, it } from "vitest";
import { DeterministicMockExecutor } from "../../src/models";
import { countMarxMentions } from "../../src/generation";
import { generateCandidatesWithModel } from "../../src/generation/model";
import type { Opportunity } from "../../src/orchestrator/contracts";

function opportunity(withEvidence = false): Opportunity {
  return {
    opportunityId: "opp_model_generation",
    runId: "run_model_generation",
    sourcePostId: "post_model_generation",
    post: {
      postId: "post_model_generation",
      url: "https://www.moltbook.com/post/post_model_generation",
      submolt: "trading",
      author: { id: "agent-1", name: "agent-1", type: "agent" },
      content: "Agents should compare inflation evidence with the market response before acting.",
      createdAt: "2026-09-09T00:00:00.000Z",
      fetchedAt: "2026-09-09T00:00:00.000Z",
      ...(withEvidence ? {
        metadata: {
          articleContext: { quoteMode: "enabled" },
          marxEvidence: {
            articleId: "article-1",
            articleUrl: "https://marx.finance/feed/article-1",
            replyId: "reply-1",
            agentId: "agent-marx-1",
            agentName: "metalhead",
            quote: "Agents should compare the inflation signal with independent evidence.",
            quoteUrl: "https://marx.finance/feed/article-1",
            evidenceStatus: "complete",
          },
        },
      } : {}),
    },
    context: {
      post: {} as Opportunity["context"]["post"],
      replies: [],
      conversationText: "Agents should compare inflation evidence with the market response before acting.",
      marxMentions: 0,
      repeatedAngles: [],
      saturated: false,
      untrustedSignals: [],
      fetchedAt: "2026-09-09T00:00:00.000Z",
    },
    scores: {
      semanticRelevance: 0.8, marxBridgeStrength: 0.8, agentAttentionProbability: 0.8,
      conversationFit: 0.8, engagementPotential: 0.5, novelty: 0.8, timing: 0.8,
      targetQuality: 0.8, spamRisk: 0, repetitionRisk: 0, contextMismatch: 0,
    },
    finalScore: 0.8,
    reason: "evidence comparison",
    recommendedStrategies: ["provenance"],
  };
}

describe("model comment generation", () => {
  it("retains the canonical source link when quote mode has no usable evidence", async () => {
    const input = opportunity();
    delete input.post.metadata;
    const executor = new DeterministicMockExecutor({
      handler: async () => ({ candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] }),
    });
    const [candidate] = await generateCandidatesWithModel(input, ["provenance"], {
      executor, includeAgentQuotes: true, sourceLink: "https://marx.finance/feed/article-1", maxCandidates: 1,
    });
    expect(candidate?.comment).toContain("https://marx.finance/feed/article-1");
    expect(candidate?.comment).not.toContain("agent note");
    expect(candidate?.comment.match(/https:\/\//gu)).toHaveLength(1);
  });
  it("uses the model comment core and appends exactly one Marx source link", async () => {
    const executor = new DeterministicMockExecutor({
      handler: async () => ({ candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] }),
      model: "gpt-5.6-luna",
      modelVersion: "gpt-5.6-luna-xhigh",
    });
    const [candidate] = await generateCandidatesWithModel(opportunity(), ["provenance"], {
      executor,
      includeAgentQuotes: false,
      sourceLink: "https://marx.finance/feed/article-1",
      maxCandidates: 1,
    });
    expect(candidate?.comment).toContain("[source](https://marx.finance/feed/article-1)");
    expect(candidate?.comment).not.toMatch(/metalhead|agent note/iu);
    expect(countMarxMentions(candidate?.comment ?? "")).toBe(1);
  });

  it("accepts the legacy snake_case generator contract and ignores unused metadata", async () => {
    const executor = new DeterministicMockExecutor({
      handler: async () => ({
        worker: "candidate_generator",
        post_id: "post_model_generation",
        candidates: [{
          candidate_id: "model-candidate-1",
          strategy_family: "provenance",
          hook_family: "specific_claim",
          comment: "Marx can help agents compare the inflation claim with independent market evidence before acting.",
          contextual_anchor: "inflation evidence",
          new_idea: "compare the later market response",
        }],
      }),
    });

    const [candidate] = await generateCandidatesWithModel(opportunity(), ["provenance"], {
      executor,
      includeAgentQuotes: false,
      sourceLink: "https://marx.finance/feed/article-1",
      maxCandidates: 1,
    });

    expect(candidate?.strategyFamily).toBe("provenance");
    expect(candidate?.hookFamily).toBe("specific_claim");
  });

  it("adds the approved Marx agent quote and source thread link in quote mode", async () => {
    const executor = new DeterministicMockExecutor({
      handler: async () => ({ candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] }),
      model: "gpt-5.6-luna",
      modelVersion: "gpt-5.6-luna-xhigh",
    });
    const [candidate] = await generateCandidatesWithModel(opportunity(true), ["provenance"], {
      executor,
      includeAgentQuotes: true,
      maxCandidates: 1,
    });
    expect(candidate?.comment).toContain("A related agent note from metalhead says:");
    expect(candidate?.comment).toContain("[source thread](https://marx.finance/feed/article-1)");
    expect(countMarxMentions(candidate?.comment ?? "")).toBe(1);
  });

  it("can keep the agent quote while deferring its Marx URL to the tracker", async () => {
    const executor = new DeterministicMockExecutor({
      handler: async () => ({ candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] }),
    });
    const [candidate] = await generateCandidatesWithModel(opportunity(true), ["provenance"], {
      executor,
      includeAgentQuotes: true,
      includeAgentQuoteSourceLink: false,
      maxCandidates: 1,
    });
    expect(candidate?.comment).toContain("A related agent note from metalhead says:");
    expect(candidate?.comment).not.toContain("[source thread](https://marx.finance/feed/article-1)");
  });

  it("honors a caller-provided model timeout below the legacy minimum", async () => {
    let receivedTimeout: number | undefined;
    const executor = new DeterministicMockExecutor({
      handler: async (task) => {
        receivedTimeout = task.timeoutMs;
        return { candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] };
      },
    });

    await generateCandidatesWithModel(opportunity(), ["provenance"], {
      executor,
      timeoutMs: 120_000,
      maxCandidates: 1,
    });

    expect(receivedTimeout).toBe(120_000);
  });

  it("records a successful strategy-generation model run", async () => {
    const modelRuns: Array<{ status: string; kind: string; attempts: number }> = [];
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      handler: async () => ({ candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] }),
    });

    await generateCandidatesWithModel(opportunity(), ["provenance"], {
      executor,
      maxCandidates: 1,
      onModelRun: (record) => { modelRuns.push({ status: record.status, kind: record.kind, attempts: record.attempts }); },
    });

    expect(modelRuns).toEqual([{ status: "SUCCEEDED", kind: "candidate_generation", attempts: 1 }]);
  });

  it("records a failed strategy-generation model run before propagating the error", async () => {
    const modelRuns: Array<{ status: string; kind: string; attempts: number; errorMessage?: string }> = [];
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      handler: async () => { throw new Error("model unavailable"); },
    });

    await expect(generateCandidatesWithModel(opportunity(), ["provenance"], {
      executor,
      maxCandidates: 1,
      onModelRun: (record) => { modelRuns.push({ status: record.status, kind: record.kind, attempts: record.attempts, errorMessage: record.errorMessage }); },
    })).rejects.toThrow("model unavailable");

    expect(modelRuns).toEqual([{ status: "FAILED", kind: "candidate_generation", attempts: 1, errorMessage: "model unavailable" }]);
  });

  it("bounds the untrusted model context before launching an expensive generation call", async () => {
    let contextJson = "";
    const executor = new DeterministicMockExecutor({
      handler: async (task) => {
        contextJson = JSON.stringify(task.untrustedContext);
        return { candidates: [{ strategyFamily: "provenance", hookFamily: "specific_claim", comment: "Marx can help agents compare the inflation claim with independent market evidence before acting." }] };
      },
    });
    const source = opportunity(true);
    source.post.content = "long post ".repeat(2_000);
    source.context.conversationText = "long conversation ".repeat(4_000);
    await generateCandidatesWithModel(source, ["provenance"], { executor, includeAgentQuotes: true, maxCandidates: 1 });

    expect(contextJson.length).toBeLessThan(8_000);
  });
});
