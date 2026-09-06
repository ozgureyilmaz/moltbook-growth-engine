import { analyzeUntrustedText } from "../security";
import type { DiscoveryRequest, MoltbookPost, PostContext, PostReply } from "../orchestrator/contracts";
import { normalizePost } from "./normalize";
import { isRetryableMoltbookError, MoltbookHttpError } from "./http-client";
import { MoltbookPostSchema, PostReplySchema } from "../schemas";

export interface MoltbookSource {
  discoverPosts(input: DiscoveryRequest): Promise<MoltbookPost[]>;
  fetchPostContext(postId: string): Promise<PostContext>;
}

export type AuthorizedMoltbookClient = {
  discoverPosts(input: DiscoveryRequest): Promise<unknown[]>;
  fetchPostContext(postId: string): Promise<unknown>;
  discoverPostPage?: (input: DiscoveryRequest, cursor?: string) => Promise<{ posts: unknown[]; nextCursor?: string }>;
};

export type SourceFilterOptions = {
  includeSubmolts?: string[];
  excludeSubmolts?: string[];
  lookbackHours?: number;
  allowedDomains?: string[];
  allowLocalDomains?: boolean;
  maxContentChars?: number;
  maxContextReplies?: number;
  allowFutureTimestamps?: boolean;
  ignoreLookback?: boolean;
};

export type FixtureSourceInput = {
  posts: MoltbookPost[];
  contexts?: Record<string, Partial<PostContext>>;
};

function clonePost(post: MoltbookPost): MoltbookPost {
  return {
    ...post,
    author: { ...post.author },
    engagement: post.engagement ? { ...post.engagement } : undefined,
    metadata: post.metadata ? { ...post.metadata } : undefined,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Fixture-backed adapter used by tests and dry-run mode; it performs no network IO. */
export class FixtureMoltbookSource implements MoltbookSource {
  private readonly posts: MoltbookPost[];
  private readonly contexts: Record<string, Partial<PostContext>>;

  public constructor(input: FixtureSourceInput) {
    this.posts = input.posts.map(clonePost);
    this.contexts = input.contexts ?? {};
  }

  public async discoverPosts(input: DiscoveryRequest = {}): Promise<MoltbookPost[]> {
    const include = new Set(input.includeSubmolts ?? []);
    const exclude = new Set(input.excludeSubmolts ?? []);
    const limit = Math.max(0, input.limit ?? 100);

    return this.posts
      .filter((post) => {
        if (include.size > 0 && !include.has(post.submolt)) return false;
        if (exclude.has(post.submolt)) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map(clonePost);
  }

  public async fetchPostContext(postId: string): Promise<PostContext> {
    const post = this.posts.find((candidate) => candidate.postId === postId);
    if (!post) throw new Error(`Moltbook fixture post not found: ${postId}`);
    const provided = this.contexts[postId] ?? {};
    return {
      post: clonePost(provided.post ?? post),
      parent: provided.parent ? clonePost(provided.parent) : undefined,
      replies: (provided.replies ?? []).map((reply) => ({ ...reply, author: { ...reply.author } })),
      authorContext: provided.authorContext ? { ...provided.authorContext } : undefined,
      fetchedAt: provided.fetchedAt ?? nowIso(),
    };
  }
}

function hostAllowed(urlValue: string, domains: string[]): boolean {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+/, "");
    return url.hostname.toLowerCase() === normalized || url.hostname.toLowerCase().endsWith(`.${normalized}`);
  });
}

function cloneReply(reply: PostReply): PostReply {
  return { ...reply, author: { ...reply.author }, engagement: reply.engagement ? { ...reply.engagement } : undefined };
}

function normalizeContext(value: unknown, fallbackPost: MoltbookPost, fetchedAt = nowIso()): PostContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Authorized Moltbook context must be an object");
  const raw = value as Partial<PostContext>;
  const post = raw.post ? normalizePostSafely(raw.post, fetchedAt) : MoltbookPostSchema.parse(fallbackPost);
  const replies = Array.isArray(raw.replies)
    ? raw.replies.filter((reply): reply is PostReply => Boolean(reply && typeof reply === "object")).map((reply) => PostReplySchema.parse(cloneReply(reply)))
    : [];
  return {
    post,
    parent: raw.parent ? normalizePostSafely(raw.parent, fetchedAt) : undefined,
    replies,
    authorContext: raw.authorContext ? { ...raw.authorContext } : undefined,
    fetchedAt: raw.fetchedAt ?? fetchedAt,
  };
}

function normalizePostSafely(value: MoltbookPost, fetchedAt: string): MoltbookPost {
  return normalizePost(value, fetchedAt);
}

/**
 * Adapter for a caller-supplied, authorized client. This class deliberately
 * contains no HTTP, credential, browser, or retry-evasion behavior. The
 * adapter is inert until the caller proves authorization and configures an
 * allowlist, so accidentally selecting a live source fails closed.
 */
export class AuthorizedMoltbookSource implements MoltbookSource {
  private readonly allowedDomains: string[];
  private readonly maxPages: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;

  public constructor(
    private readonly client: AuthorizedMoltbookClient,
    options: { authorized?: boolean; allowedDomains?: string[]; maxPages?: number; maxAttempts?: number; retryBackoffMs?: number } = {},
  ) {
    if (options.authorized !== true) throw new Error("AuthorizedMoltbookSource requires explicit authorized=true");
    this.allowedDomains = [...new Set(options.allowedDomains ?? [])];
    if (this.allowedDomains.length === 0) throw new Error("AuthorizedMoltbookSource requires a non-empty allowed domain list");
    this.maxPages = Math.max(1, options.maxPages ?? 10);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryBackoffMs = Math.max(0, options.retryBackoffMs ?? 250);
  }

  public async discoverPosts(input: DiscoveryRequest = {}): Promise<MoltbookPost[]> {
    const rawPosts = this.client.discoverPostPage
      ? await this.collectPages(input)
      : await this.withRetry(() => this.client.discoverPosts(input));
    if (!Array.isArray(rawPosts)) throw new Error("Authorized Moltbook discovery returned a non-array");
    return rawPosts.map((raw) => {
      const post = MoltbookPostSchema.parse(normalizePost(raw as Parameters<typeof normalizePost>[0]));
      if (!hostAllowed(post.url, this.allowedDomains)) throw new Error(`Moltbook post URL is outside the configured allowlist: ${post.postId}`);
      return post;
    });
  }

  public async fetchPostContext(postId: string): Promise<PostContext> {
    const raw = await this.withRetry(() => this.client.fetchPostContext(postId));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Authorized Moltbook context is invalid for ${postId}`);
    const value = raw as Partial<PostContext>;
    const post = value.post ? normalizePost(value.post, nowIso()) : undefined;
    if (!post) throw new Error(`Authorized Moltbook context is missing its post for ${postId}`);
    if (post.postId !== postId) throw new Error(`Authorized Moltbook context post ID does not match requested post ${postId}`);
    if (!hostAllowed(post.url, this.allowedDomains)) throw new Error(`Moltbook context URL is outside the configured allowlist: ${postId}`);
    const context = normalizeContext(value, post);
    if (context.parent && !hostAllowed(context.parent.url, this.allowedDomains)) throw new Error(`Moltbook parent URL is outside the configured allowlist: ${postId}`);
    return context;
  }

  private async collectPages(input: DiscoveryRequest): Promise<unknown[]> {
    const posts: unknown[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < this.maxPages && posts.length < (input.limit ?? 100); page += 1) {
      if (cursor && seenCursors.has(cursor)) throw new Error("Authorized Moltbook pagination cursor repeated");
      if (cursor) seenCursors.add(cursor);
      const response = await this.withRetry(() => this.client.discoverPostPage!(input, cursor));
      if (!Array.isArray(response.posts)) throw new Error("Authorized Moltbook page returned a non-array posts value");
      posts.push(...response.posts);
      cursor = response.nextCursor;
      if (!cursor || response.posts.length === 0) break;
    }
    return posts.slice(0, input.limit ?? posts.length);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try { return await operation(); } catch (error) {
        lastError = error;
        if (!isRetryableMoltbookError(error) || attempt >= this.maxAttempts) break;
        const waitMs = error instanceof MoltbookHttpError && error.retryAfterMs !== undefined
          ? Math.max(this.retryBackoffMs, error.retryAfterMs)
          : this.retryBackoffMs;
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Applies authoritative discovery policy without adding platform access. */
export class ConfiguredMoltbookSource implements MoltbookSource {
  public constructor(private readonly source: MoltbookSource, private readonly options: SourceFilterOptions = {}) {}

  public async discoverPosts(input: DiscoveryRequest = {}): Promise<MoltbookPost[]> {
    const includeSubmolts = this.options.includeSubmolts ?? input.includeSubmolts;
    const excludeSubmolts = this.options.excludeSubmolts ?? input.excludeSubmolts;
    const posts = await this.source.discoverPosts({
      ...input,
      ...(includeSubmolts ? { includeSubmolts: [...includeSubmolts] } : {}),
      ...(excludeSubmolts ? { excludeSubmolts: [...excludeSubmolts] } : {}),
    });
    const now = Date.parse(input.now ?? nowIso());
    const lookbackMs = (this.options.lookbackHours ?? input.lookbackHours ?? 24) * 3_600_000;
    return posts.filter((post) => {
      if (includeSubmolts && includeSubmolts.length > 0 && !includeSubmolts.includes(post.submolt)) return false;
      if (excludeSubmolts?.includes(post.submolt)) return false;
      const created = Date.parse(post.createdAt);
      if (!this.options.ignoreLookback && !Number.isNaN(created) && ((!this.options.allowFutureTimestamps && created > now) || now - created > lookbackMs)) return false;
      if (this.options.maxContentChars !== undefined && post.content.length > this.options.maxContentChars) return false;
      if (!this.options.allowLocalDomains && this.options.allowedDomains && this.options.allowedDomains.length > 0 && !hostAllowed(post.url, this.options.allowedDomains)) return false;
      return this.options.allowLocalDomains || this.options.allowedDomains === undefined || this.options.allowedDomains.length === 0 || hostAllowed(post.url, this.options.allowedDomains);
    }).slice(0, Math.max(0, input.limit ?? posts.length));
  }

  public async fetchPostContext(postId: string): Promise<PostContext> {
    const context = await this.source.fetchPostContext(postId);
    if (this.options.maxContextReplies !== undefined && context.replies.length > this.options.maxContextReplies) {
      return { ...context, replies: context.replies.slice(0, this.options.maxContextReplies) };
    }
    return context;
  }
}

/** A source that fails loudly when a live integration is accidentally requested. */
export class DisabledMoltbookSource implements MoltbookSource {
  public async discoverPosts(): Promise<MoltbookPost[]> {
    throw new Error("Live Moltbook access is disabled in this intelligence slice; use an authorized adapter or fixtures");
  }

  public async fetchPostContext(postId: string): Promise<PostContext> {
    throw new Error(`Live Moltbook access is disabled (requested context for ${postId})`);
  }
}

export function fixturePost(overrides: Partial<MoltbookPost> & Pick<MoltbookPost, "postId" | "content">): MoltbookPost {
  const now = nowIso();
  return {
    postId: overrides.postId,
    url: overrides.url ?? `https://moltbook.local/post/${encodeURIComponent(overrides.postId)}`,
    submolt: overrides.submolt ?? "general",
    author: overrides.author ?? { id: `agent-${overrides.postId}`, name: "fixture-agent", type: "agent" },
    content: overrides.content,
    createdAt: overrides.createdAt ?? now,
    fetchedAt: overrides.fetchedAt ?? now,
    parentId: overrides.parentId,
    engagement: overrides.engagement ?? { replies: 0, reactions: 0 },
    metadata: overrides.metadata,
  };
}

export function fixtureReply(replyId: string, content: string, overrides: Partial<PostReply> = {}): PostReply {
  return {
    replyId,
    content,
    author: overrides.author ?? { id: `agent-${replyId}`, name: "reply-agent", type: "agent" },
    createdAt: overrides.createdAt ?? nowIso(),
    parentId: overrides.parentId,
    engagement: overrides.engagement,
  };
}

export function securitySignalsForPost(post: MoltbookPost): string[] {
  return analyzeUntrustedText(post.content).injectionSignals;
}
