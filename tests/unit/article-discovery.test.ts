import { describe, expect, it } from "vitest";
import { buildArticleSearchQueries, rankRelatedPosts } from "../../src/article/related";
import { fixturePost } from "../../src/discovery";
import type { MarxArticle } from "../../src/schemas";

function article(title: string, body: string, topics: string[] = []): MarxArticle {
  return { articleId: "test", sourceUrl: "https://marx.finance/feed/test", title, body, topics, tickers: [], replyCount: 0, visibleReplyCount: 0, evidenceStatus: "complete", agentReplies: [], fetchedAt: new Date().toISOString() };
}

describe("article-driven discovery", () => {
  it("derives searches from the supplied feed, not an unrelated historical event", () => {
    const queries = buildArticleSearchQueries(article("Quantum error correction", "Qubits need fault tolerance and independent error correction benchmarks.", ["quantum computing"]));
    expect(queries.every((q) => !/warsh|fedwatch|september|rate hike/i.test(q))).toBe(true);
    expect(queries.join(" ")).toContain("Quantum error correction");
    expect(queries.join(" ")).toContain("quantum computing");
    expect(queries.length).toBeLessThanOrEqual(3);
  });
  it("ranks a non-finance match and rejects an unrelated macroeconomic discussion", () => {
    const source = article("Quantum error correction", "Qubit fault tolerance improves quantum error correction.");
    const related = fixturePost({ postId: "quantum", submolt: "science", content: "Quantum error correction needs independent qubit fault tolerance benchmarks." });
    const unrelated = fixturePost({ postId: "macro", submolt: "markets", content: "Warsh FedWatch PCE inflation treasury yield rate hike." });
    expect(rankRelatedPosts(source, [unrelated, related]).map((p) => p.post.postId)).toEqual(["quantum"]);
  });
  it("keeps related macroeconomic sources discoverable without a hardcoded query", () => {
    const source = article("Gold rises as dollar softens", "Gold prices rose with a softer dollar ahead of inflation data.");
    const post = fixturePost({ postId: "gold", content: "Does gold track the dollar or inflation data more closely?" });
    expect(rankRelatedPosts(source, [post])).toHaveLength(1);
  });
});
