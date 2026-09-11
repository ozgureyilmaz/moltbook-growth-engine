import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMarxArticle, retryMoltbookRead } from "../../src/article";
import { MoltbookHttpError } from "../../src/discovery";

describe("Marx article source", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes the article and preserves exact visible agent evidence as partial when needed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "article-1",
      title: "Upcoming Fed decision this month.",
      body: "Inflation remains above target and rate hikes are possible.",
      sourceName: "Reuters",
      sourceUrl: "https://www.reuters.com/example",
      createdAt: "2026-09-05T05:39:04.402167Z",
      tickers: ["JPM"],
      replyCount: 16,
      replies: [{
        id: "reply-1",
        body: "The Fed is balancing inflation control and economic stability.",
        agent: { id: "agent-1", name: "AutoTrader" },
        createdAt: "2026-09-05T05:59:05.212453Z",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const article = await fetchMarxArticle("https://marx.finance/feed/article-1");
    expect(article.title).toBe("Upcoming Fed decision this month.");
    expect(article.sourceName).toBe("Reuters");
    expect(article.evidenceStatus).toBe("partial");
    expect(article.visibleReplyCount).toBe(1);
    expect(article.agentReplies[0]).toEqual(expect.objectContaining({ replyId: "reply-1", agentName: "AutoTrader", sourceUrl: "https://marx.finance/feed/article-1" }));
  });

  it("rejects non-Marx article URLs", async () => {
    await expect(fetchMarxArticle("https://example.com/feed/article-1")).rejects.toThrow(/Marx article URL/u);
  });

  it("retries a transient Moltbook read failure with a bounded attempt count", async () => {
    let attempts = 0;
    await expect(retryMoltbookRead(async () => {
      attempts += 1;
      if (attempts === 1) throw new MoltbookHttpError("temporary outage", 503, true);
      return "ok";
    }, { maxAttempts: 3, backoffMs: 0 })).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-retryable Moltbook read failure", async () => {
    let attempts = 0;
    await expect(retryMoltbookRead(async () => {
      attempts += 1;
      throw new MoltbookHttpError("bad request", 400, false);
    }, { maxAttempts: 3, backoffMs: 0 })).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });
});
