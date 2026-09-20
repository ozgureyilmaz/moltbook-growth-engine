import { describe, expect, it } from "vitest";
import { parseArgs, runCli } from "../../src/cli";
import type { MoltbookPost, PostContext } from "../../src/orchestrator";

function post(feed: string): MoltbookPost {
  return {
    postId: `trend-${feed}`,
    url: `https://moltbook.local/post/trend-${feed}`,
    submolt: "markets",
    author: { id: "agent-1", name: "market-agent", type: "agent" },
    content: "Agents compare liquidity signals, inflation, and rates before a portfolio decision. Which evidence should change the strategy?",
    createdAt: "2026-09-20T12:00:00.000Z",
    fetchedAt: "2026-09-20T12:01:00.000Z",
    engagement: { replies: 18, reactions: 30 },
    metadata: { feed, score: 30 },
  };
}

describe("trend-detect CLI", () => {
  it("scans all requested feed modes and never creates publication state", async () => {
    const calls: string[] = [];
    const posts = [post("realtime"), post("top"), post("discussed")];
    const source = {
      discoverPosts: async (input: { feed?: string }) => {
        calls.push(input.feed ?? "missing");
        return posts.filter((value) => value.metadata?.feed === input.feed);
      },
      fetchPostContext: async (postId: string): Promise<PostContext> => ({
        post: posts.find((value) => value.postId === postId)!,
        replies: [],
        fetchedAt: "2026-09-20T12:01:00.000Z",
      }),
    };
    const output: string[] = [];
    const result = await runCli(["trend-detect", "--feeds", "realtime,top,discussed", "--time", "day", "--limit", "3"], {
      source,
      persistence: {},
      stdout: (line) => output.push(line),
    });
    const report = JSON.parse(result) as { status: string; feeds: string[]; published: number; outboxWrites: number; candidates: unknown[] };
    expect(calls).toEqual(["realtime", "top", "discussed"]);
    expect(report.status).toBe("CANDIDATES_READY");
    expect(report.feeds).toEqual(["realtime", "top", "discussed"]);
    expect(report.candidates).toHaveLength(3);
    expect(report.published).toBe(0);
    expect(report.outboxWrites).toBe(0);
    expect(output).toHaveLength(1);
  });

  it("rejects publication flags and invalid feed modes", async () => {
    expect(parseArgs(["trend-detect", "--feeds", "top"]).command).toBe("trend-detect");
    await expect(runCli(["trend-detect", "--feeds", "unknown"], { persistence: {}, stdout: () => undefined })).rejects.toThrow(/only realtime, top, and discussed/u);
    await expect(runCli(["trend-detect", "--publish"], { persistence: {}, stdout: () => undefined })).rejects.toThrow(/always public-read-only/u);
  });
});
