import { describe, expect, it } from "vitest";
import { buildArticleSearchQueries, chooseMarxEvidence, rankRelatedPosts } from "../../src/article";
import type { MarxArticle } from "../../src/schemas";
import type { MoltbookPost } from "../../src/orchestrator/contracts";

const article: MarxArticle = {
  articleId: "article-greenland",
  sourceUrl: "https://marx.finance/feed/article-greenland",
  title: "Trump announces agreement with Denmark over Greenland security",
  body: "The Arctic agreement raises questions about sovereignty, NATO, military access, and mineral resources in Greenland.",
  tickers: [],
  topics: ["trump", "denmark", "greenland", "arctic", "sovereignty", "nato", "military", "minerals"],
  replyCount: 1,
  visibleReplyCount: 1,
  evidenceStatus: "complete",
  agentReplies: [{
    replyId: "reply-greenland",
    agentId: "agent-greenland",
    agentName: "Flare",
    body: "Greenland's security agreement may change the politics of mineral access and military infrastructure.",
    sourceUrl: "https://marx.finance/feed/article-greenland",
    quote: "Greenland's security agreement may change the politics of mineral access and military infrastructure.",
  }],
  fetchedAt: "2026-09-20T00:00:00.000Z",
};

function post(postId: string, content: string, submolt = "general"): MoltbookPost {
  return {
    postId,
    url: `https://www.moltbook.com/post/${postId}`,
    submolt,
    author: { id: `author-${postId}`, name: "agent" },
    content,
    createdAt: "2026-09-20T00:00:00.000Z",
    fetchedAt: "2026-09-20T00:00:00.000Z",
  };
}

describe("Marx article relevance", () => {
  it("builds search queries from the supplied article instead of fixed Fed queries", () => {
    const queries = buildArticleSearchQueries(article).join(" ").toLowerCase();

    expect(queries).toContain("greenland");
    expect(queries).toContain("denmark");
    expect(queries).not.toContain("warsh");
    expect(queries).not.toContain("fedwatch");
    expect(queries).not.toContain("pce");
  });

  it("rejects finance posts that only match a fixed macro vocabulary", () => {
    const unrelated = post("fed-post", "Fed rate hike risk is repricing inflation and Treasury yields.", "finance");

    expect(rankRelatedPosts(article, [unrelated])).toEqual([]);
  });

  it("rejects broad defense posts without a feed-specific geographic anchor", () => {
    const unrelated = post("defense-post", "NATO and China are changing military defense strategy across Europe.", "general");

    expect(rankRelatedPosts(article, [unrelated])).toEqual([]);
  });

  it("keeps posts with a direct feed-topic anchor", () => {
    const related = post("greenland-post", "The Arctic security agreement could change Greenland's sovereignty and NATO posture.", "geopolitics");

    expect(rankRelatedPosts(article, [related]).map((item) => item.post.postId)).toEqual(["greenland-post"]);
  });

  it("does not attach Marx evidence to an unrelated post", () => {
    const unrelated = post("fed-post", "Fed rate hike risk is repricing inflation and Treasury yields.", "finance");

    expect(chooseMarxEvidence(article, unrelated)).toBeUndefined();
  });

  it("attaches Marx evidence only to a topic-matched post", () => {
    const related = post("greenland-post", "The Arctic security agreement could change Greenland's sovereignty and NATO posture.", "geopolitics");

    expect(chooseMarxEvidence(article, related)).toEqual(expect.objectContaining({
      replyId: "reply-greenland",
      agentName: "Flare",
    }));
  });
});
