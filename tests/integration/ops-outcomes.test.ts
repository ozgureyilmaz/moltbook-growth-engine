import { describe, expect, it } from "vitest";
import { makeExperimentRecord, LocalOutcomeProvider, aggregateStrategyStats } from "../../src/experiments";
import { AuthorizedMoltbookSource, fixturePost, FixtureMoltbookSource } from "../../src/discovery";
import { buildConversationContext } from "../../src/context";
import { scoreOpportunity } from "../../src/analysis";
import { generateCandidates } from "../../src/generation";
import { IndependentMockEvaluator } from "../../src/evaluation";

describe("local outcome and strategy learning path", () => {
  it("simulates outcomes and aggregates north-star strategy statistics", async () => {
    const post = fixturePost({ postId: "outcome-path-post", submolt: "markets", content: "Agents should compare provenance behind a market signal." });
    const source = new FixtureMoltbookSource({ posts: [post] });
    const context = buildConversationContext(await source.fetchPostContext(post.postId));
    const opportunity = scoreOpportunity(post, context, { runId: "outcome-path-run", now: post.createdAt });
    const candidate = generateCandidates(opportunity, ["provenance"], { runId: "outcome-path-run" })[0]!;
    const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
    const experiment = makeExperimentRecord("outcome-path-run", opportunity, candidate, evaluation);
    const provider = new LocalOutcomeProvider({}, { seed: "outcome-test", investigationScore: 1, interactionScore: 1, usageScore: 1 });
    const outcome = await provider.getOrSimulate(experiment);
    const stats = aggregateStrategyStats([{ experiment, outcome }]);
    expect(outcome.marxInvestigationSignal).toBeTypeOf("boolean");
    expect(stats[0]).toMatchObject({ trials: 1, sampleSize: 1, dimensions: { strategyFamily: "provenance", submolt: "markets" } });
    expect(stats[0]!.northStarSuccesses).toBeGreaterThanOrEqual(0);
    expect(stats[0]!.posteriorMean).toBeGreaterThan(0);
    expect(stats[0]!.standardError).toBeGreaterThan(0);
  });

  it("keeps the authorized source adapter bounded, paginated, and allow-listed", async () => {
    let attempts = 0;
    const source = new AuthorizedMoltbookSource({
      discoverPosts: async () => [],
      fetchPostContext: async () => ({}),
      discoverPostPage: async (_input, cursor) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary rate limit");
        const post = fixturePost({ postId: cursor ? "page-2" : "page-1", url: "https://moltbook.example/posts/page", content: "Agents should compare evidence behind a market signal." });
        return { posts: [post], nextCursor: cursor ? undefined : "next" };
      },
    }, { authorized: true, allowedDomains: ["moltbook.example"], maxPages: 2, maxAttempts: 2, retryBackoffMs: 0 });
    const posts = await source.discoverPosts({ limit: 2 });
    expect(posts).toHaveLength(2);
    expect(attempts).toBe(3);
    expect(() => new AuthorizedMoltbookSource({ discoverPosts: async () => [], fetchPostContext: async () => ({}) })).toThrow("authorized=true");
  });
});
