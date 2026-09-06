import { describe, expect, it, vi } from "vitest";
import { AuthorizedMoltbookSource, MoltbookHttpClient, MoltbookHttpError, OFFICIAL_MOLTBOOK_API_BASE_URL } from "../../src/discovery";
import { EnvironmentSecretProvider, MacOsKeychainSecretProvider } from "../../src/secrets";

const rawPost = {
  id: "post-1",
  title: "A useful thread",
  content: "Agents need provenance.",
  type: "text",
  author_id: "agent-1",
  author: { id: "agent-1", name: "ResearchMolty", description: "public profile", isClaimed: true },
  submolt: { id: "sub-1", name: "agents", display_name: "Agents" },
  upvotes: 4,
  downvotes: 1,
  comment_count: 1,
  created_at: "2026-08-27T12:00:00.000Z",
  is_deleted: false,
  is_spam: false,
  labels: { topic: "research" },
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("MoltbookHttpClient", () => {
  it("uses the official GET-only origin and maps posts without exposing the key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json({ success: true, posts: [rawPost], has_more: false });
    });
    const client = new MoltbookHttpClient({
      secretProvider: new EnvironmentSecretProvider({ MOLTBOOK_API_KEY: "secret-value" }),
      secretReference: { name: "read-key", environmentVariable: "MOLTBOOK_API_KEY" },
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-08-27T13:00:00.000Z"),
    });

    const page = await client.discoverPostPage({ limit: 1, includeSubmolts: ["agents"] });

    expect(page.posts).toEqual([expect.objectContaining({
      postId: "post-1",
      url: "https://www.moltbook.com/post/post-1",
      submolt: "agents",
      content: "A useful thread\n\nAgents need provenance.",
    })]);
    expect(calls[0]?.url).toBe(`${OFFICIAL_MOLTBOOK_API_BASE_URL}/posts?sort=new&limit=1&submolt=agents`);
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-value");
  });

  it("maps post context and nested replies from official response shapes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes("/comments")
      ? json({ success: true, comments: [{
        id: "comment-1", post_id: "post-1", content: "first", author_id: "agent-2", author: { name: "Commenter" },
        upvotes: 2, downvotes: 0, created_at: "2026-08-27T12:10:00.000Z", replies: [{
          id: "reply-1", post_id: "post-1", parent_id: "comment-1", content: "nested", author: { name: "Nested" },
          created_at: "2026-08-27T12:11:00.000Z", replies: [],
        }],
      }] })
      : json({ success: true, post: rawPost }));
    const client = new MoltbookHttpClient({
      secretProvider: new EnvironmentSecretProvider({ MOLTBOOK_API_KEY: "secret-value" }),
      secretReference: { name: "read-key", environmentVariable: "MOLTBOOK_API_KEY" },
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-08-27T13:00:00.000Z"),
    });

    const context = await client.fetchPostContext("post-1") as { replies: Array<{ replyId: string; parentId?: string }> };
    expect(context.replies).toEqual([
      expect.objectContaining({ replyId: "comment-1" }),
      expect.objectContaining({ replyId: "reply-1", parentId: "comment-1" }),
    ]);
  });

  it("fails closed on other origins and redacts secrets from provider errors", async () => {
    expect(() => new MoltbookHttpClient({
      secretProvider: new EnvironmentSecretProvider(),
      secretReference: { name: "read-key" },
      baseUrl: "https://moltbook.com/api/v1",
    })).toThrow(`must be ${OFFICIAL_MOLTBOOK_API_BASE_URL}`);

    const client = new MoltbookHttpClient({
      secretProvider: new EnvironmentSecretProvider({ MOLTBOOK_API_KEY: "do-not-print-me" }),
      secretReference: { name: "read-key", environmentVariable: "MOLTBOOK_API_KEY" },
      fetch: vi.fn(async () => json({ success: false, error: "unauthorized" }, 401)) as typeof fetch,
    });
    const error = await client.discoverPosts({ limit: 1 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MoltbookHttpError);
    expect(String(error)).not.toContain("do-not-print-me");
    expect((error as MoltbookHttpError).retryable).toBe(false);
  });

  it("retries only retryable read failures at the authorized source boundary", async () => {
    let attempts = 0;
    const client = {
      discoverPosts: async () => {
        attempts += 1;
        if (attempts === 1) throw new MoltbookHttpError("temporary", 503, true, 0);
        return [{
          postId: "post-1",
          url: "https://www.moltbook.com/post/post-1",
          submolt: "agents",
          author: { id: "agent-1", name: "ResearchMolty", type: "agent" },
          content: "Agents need provenance.",
          createdAt: "2026-08-27T12:00:00.000Z",
          fetchedAt: "2026-08-27T13:00:00.000Z",
        }];
      },
      fetchPostContext: async () => ({ post: rawPost, replies: [], fetchedAt: "2026-08-27T13:00:00.000Z" }),
    };
    const source = new AuthorizedMoltbookSource(client, { authorized: true, allowedDomains: ["www.moltbook.com"], maxAttempts: 2 });
    await expect(source.discoverPosts({ limit: 1 })).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("treats malformed JSON and denied redirects as terminal read failures", async () => {
    for (const fetchMock of [
      vi.fn(async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })),
      vi.fn(async () => { throw new TypeError("redirect mode is set to error"); }),
    ]) {
      const client = new MoltbookHttpClient({
        secretProvider: new EnvironmentSecretProvider({ MOLTBOOK_API_KEY: "secret-value" }),
        secretReference: { name: "read-key", environmentVariable: "MOLTBOOK_API_KEY" },
        fetch: fetchMock as typeof fetch,
      });
      const source = new AuthorizedMoltbookSource(client, { authorized: true, allowedDomains: ["www.moltbook.com"], maxAttempts: 3 });
      const error = await source.discoverPosts({ limit: 1 }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(MoltbookHttpError);
      expect((error as MoltbookHttpError).retryable).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects context returned for a different post", async () => {
    const source = new AuthorizedMoltbookSource({
      discoverPosts: async () => [],
      fetchPostContext: async () => ({
        post: {
          postId: "post-2",
          url: "https://www.moltbook.com/post/post-2",
          submolt: "agents",
          author: { id: "agent-1", type: "agent" },
          content: "Wrong conversation",
          createdAt: "2026-08-27T12:00:00.000Z",
          fetchedAt: "2026-08-27T13:00:00.000Z",
        },
        replies: [],
        fetchedAt: "2026-08-27T13:00:00.000Z",
      }),
    }, { authorized: true, allowedDomains: ["www.moltbook.com"] });
    await expect(source.fetchPostContext("post-1")).rejects.toThrow(/does not match requested post/u);
  });

  it("does not treat a pending Moltbook agent as authorized", async () => {
    const client = new MoltbookHttpClient({
      secretProvider: new EnvironmentSecretProvider({ MOLTBOOK_API_KEY: "secret-value" }),
      secretReference: { name: "read-key", environmentVariable: "MOLTBOOK_API_KEY" },
      fetch: vi.fn(async () => json({ success: true, status: "pending_claim" })) as typeof fetch,
    });
    await expect(client.checkAuthorization()).rejects.toThrow(/not claimed/u);
  });
});

describe("secret providers", () => {
  it("reads Keychain by service/account without putting the secret in command arguments", async () => {
    const run = vi.fn(async () => ({ stdout: "key-from-keychain\n" }));
    const provider = new MacOsKeychainSecretProvider(run);
    await expect(provider.getSecret({ name: "read-key", keychainService: "service", keychainAccount: "account" })).resolves.toBe("key-from-keychain");
    expect(run).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "service", "-a", "account", "-w"]);
    expect(JSON.stringify(run.mock.calls)).not.toContain("key-from-keychain");
  });
});
