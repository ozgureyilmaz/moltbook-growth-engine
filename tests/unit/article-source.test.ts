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

  it("derives article topics from the supplied feed instead of a fixed finance topic list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "article-greenland",
      title: "Trump announces agreement with Denmark over Greenland security",
      body: "The Arctic agreement raises questions about sovereignty, NATO, military access, and mineral resources in Greenland.",
      replyCount: 0,
      replies: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const article = await fetchMarxArticle("https://marx.finance/feed/article-greenland");

    expect(article.topics).toEqual(expect.arrayContaining(["trump", "denmark", "greenland", "arctic", "nato"]));
    expect(article.topics).not.toContain("Federal Reserve");
    expect(article.topics).not.toContain("PCE");
  });

  it("ends long agent evidence on a complete sentence instead of an ellipsis fragment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "article-quote-boundary",
      title: "Gold and the dollar",
      body: "Gold is moving while inflation data approaches.",
      replyCount: 1,
      replies: [{
        id: "reply-quote-boundary",
        body: "Gold's recent uptick amidst a softer dollar signals the resilience of safe-haven assets, especially with inflation data looming. A potential Fed interest rate hike could shift dynamics quickly, making this a test of whether the market is pricing protection or merely reacting to a temporary currency move.",
        agent: { id: "agent-quote-boundary", name: "novabadger" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const article = await fetchMarxArticle("https://marx.finance/feed/article-quote-boundary");
    expect(article.agentReplies[0]?.quote).toBe("Gold's recent uptick amidst a softer dollar signals the resilience of safe-haven assets, especially with inflation data looming.");
    expect(article.agentReplies[0]?.quote).not.toMatch(/…$/u);
  });

  it("does not mistake abbreviation periods for agent quote sentence boundaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "article-abbreviation-boundary",
      title: "Gold and U.S. inflation",
      body: "Gold is moving while U.S. inflation data approaches.",
      replyCount: 1,
      replies: [{
        id: "reply-abbreviation-boundary",
        body: "The current market dynamics suggest that a softer dollar provides short-term support for gold, yet the upcoming U.S. inflation data will be pivotal in determining the Fed's interest rate trajectory. A potential rate hike could shift dynamics quickly.",
        agent: { id: "agent-abbreviation-boundary", name: "onyxstoat" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const article = await fetchMarxArticle("https://marx.finance/feed/article-abbreviation-boundary");
    expect(article.agentReplies[0]?.quote).toBe("The current market dynamics suggest that a softer dollar provides short-term support for gold, yet the upcoming U.S. inflation data will be pivotal in determining the Fed's interest rate trajectory.");
    expect(article.agentReplies[0]?.quote).not.toMatch(/\bU\.$/u);
  });

  it("omits agent evidence when no complete quote can be extracted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "article-no-complete-quote",
      title: "An unfinished agent observation",
      body: "The market is still being evaluated.",
      replyCount: 1,
      replies: [{
        id: "reply-no-complete-quote",
        body: "This agent observation keeps extending without a sentence boundary and should not be turned into a partial quotation because the engine cannot safely preserve the complete thought ".repeat(4),
        agent: { id: "agent-no-complete-quote", name: "quietagent" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const article = await fetchMarxArticle("https://marx.finance/feed/article-no-complete-quote");
    expect(article.agentReplies[0]?.quote).toBeUndefined();
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
