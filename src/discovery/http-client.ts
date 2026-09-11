import { spawn } from "node:child_process";
import { z } from "zod";
import { requireSecret, type SecretProvider, type SecretReference } from "../secrets";
import type { DiscoveryRequest, MoltbookPost, PostContext, PostReply } from "../orchestrator/contracts";
import type { AuthorizedMoltbookClient } from "./moltbook";

export const OFFICIAL_MOLTBOOK_API_BASE_URL = "https://www.moltbook.com/api/v1";

const RawAuthorSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  karma: z.number().optional(),
  followerCount: z.number().optional(),
  followingCount: z.number().optional(),
  isClaimed: z.boolean().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.string().optional(),
  lastActive: z.string().nullable().optional(),
}).passthrough();

const RawPostSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  type: z.string().optional(),
  author_id: z.string().optional(),
  author: RawAuthorSchema.optional(),
  submolt: z.object({ name: z.string().min(1), display_name: z.string().optional() }).passthrough(),
  upvotes: z.number().int().nonnegative().optional(),
  downvotes: z.number().int().nonnegative().optional(),
  score: z.number().optional(),
  comment_count: z.number().int().nonnegative().optional(),
  relevance: z.number().optional(),
  is_deleted: z.boolean().optional(),
  is_spam: z.boolean().optional(),
  verification_status: z.string().optional(),
  created_at: z.string().datetime({ offset: true }),
  labels: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

type RawComment = {
  id: string;
  post_id: string;
  parent_id?: string;
  content?: string | null;
  author_id?: string;
  author?: z.infer<typeof RawAuthorSchema>;
  upvotes?: number;
  downvotes?: number;
  created_at: string;
  is_deleted?: boolean;
  is_spam?: boolean;
  replies?: RawComment[];
};

const RawCommentSchema: z.ZodType<RawComment> = z.lazy(() => z.object({
  id: z.string().min(1),
  post_id: z.string().min(1),
  parent_id: z.string().optional(),
  content: z.string().nullable().optional(),
  author_id: z.string().optional(),
  author: RawAuthorSchema.optional(),
  upvotes: z.number().int().nonnegative().optional(),
  downvotes: z.number().int().nonnegative().optional(),
  created_at: z.string().datetime({ offset: true }),
  is_deleted: z.boolean().optional(),
  is_spam: z.boolean().optional(),
  replies: z.array(RawCommentSchema).optional(),
}).passthrough());

const PostListResponseSchema = z.object({
  success: z.literal(true),
  posts: z.array(RawPostSchema),
  has_more: z.boolean().optional(),
  next_cursor: z.string().optional(),
}).passthrough();

const PostResponseSchema = z.object({ success: z.literal(true), post: RawPostSchema }).passthrough();
const CommentsResponseSchema = z.object({ success: z.literal(true), comments: z.array(RawCommentSchema), next_cursor: z.string().optional() }).passthrough();
const SearchResultSchema = z.object({
  id: z.string().optional(),
  post_id: z.string().optional(),
  type: z.literal("post"),
  title: z.string().optional(),
  content: z.string().optional(),
  author: RawAuthorSchema.optional(),
  submolt: z.object({ name: z.string().min(1), display_name: z.string().optional() }).passthrough(),
  created_at: z.string().datetime({ offset: true }),
  upvotes: z.number().int().nonnegative().optional(),
  downvotes: z.number().int().nonnegative().optional(),
  comment_count: z.number().int().nonnegative().optional(),
}).passthrough();
const SearchResponseSchema = z.object({ success: z.literal(true), results: z.array(SearchResultSchema) }).passthrough();

export class MoltbookHttpError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "MoltbookHttpError";
  }
}

export type MoltbookHttpClientOptions = {
  secretProvider: SecretProvider;
  secretReference: SecretReference;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  allowTestBaseUrl?: boolean;
  /** Public GET-only mode. It never attempts to resolve or send a secret. */
  publicReadOnly?: boolean;
  now?: () => Date;
};

/** Official, GET-only Moltbook adapter. It never owns write credentials or write endpoints. */
export class MoltbookHttpClient implements AuthorizedMoltbookClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  public constructor(private readonly options: MoltbookHttpClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl ?? OFFICIAL_MOLTBOOK_API_BASE_URL, options.allowTestBaseUrl === true);
    this.timeoutMs = positiveInteger("Moltbook request timeout", options.timeoutMs ?? 15_000);
    // The macOS runtime used by the Hermes host can reach Moltbook through
    // curl while Node's native fetch intermittently stalls at the TLS connect.
    // Keep injected fetches for tests, but use the stdin-configured curl
    // transport for the official production read boundary.
    this.fetchImpl = options.fetch ?? curlFetch;
    this.now = options.now ?? (() => new Date());
  }

  public async discoverPosts(input: DiscoveryRequest = {}): Promise<unknown[]> {
    return (await this.discoverPostPage(input)).posts;
  }

  public async discoverPostPage(input: DiscoveryRequest = {}, cursor?: string): Promise<{ posts: unknown[]; nextCursor?: string }> {
    const url = this.endpoint("posts");
    url.searchParams.set("sort", "new");
    url.searchParams.set("limit", String(Math.min(100, Math.max(1, input.limit ?? 100))));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (input.includeSubmolts?.length === 1) url.searchParams.set("submolt", input.includeSubmolts[0]!);
    const parsed = PostListResponseSchema.parse(await this.getJson(url));
    return {
      posts: parsed.posts.filter((post) => !post.is_deleted && !post.is_spam).map((post) => this.toPost(post)),
      ...(parsed.has_more && parsed.next_cursor ? { nextCursor: parsed.next_cursor } : {}),
    };
  }

  public async searchPosts(query: string, limit = 20): Promise<unknown[]> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 500) throw new Error("Moltbook search query must contain 1-500 characters");
    const url = this.endpoint("search");
    url.searchParams.set("q", normalized);
    url.searchParams.set("type", "posts");
    url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
    const parsed = SearchResponseSchema.parse(await this.getJson(url));
    return parsed.results.map((result) => this.toSearchPost(result));
  }

  public async fetchPostContext(postId: string): Promise<unknown> {
    const safePostId = pathSegment("postId", postId);
    const [postResponse, commentsResponse] = await Promise.all([
      this.getJson(this.endpoint(`posts/${safePostId}`)),
      this.getJson(this.endpoint(`posts/${safePostId}/comments`, { sort: "new", limit: "100" })),
    ]);
    const post = PostResponseSchema.parse(postResponse).post;
    const comments = CommentsResponseSchema.parse(commentsResponse).comments;
    const context: PostContext = {
      post: this.toPost(post),
      replies: flattenComments(comments),
      authorContext: publicAuthorContext(post.author),
      fetchedAt: this.now().toISOString(),
    };
    return context;
  }

  /** A read-only auth probe used by the doctor command. */
  public async checkAuthorization(): Promise<{ authorized: true; status?: string }> {
    const parsed = z.object({ success: z.literal(true), status: z.string().optional() }).passthrough().parse(await this.getJson(this.endpoint("agents/status")));
    if (parsed.status && parsed.status !== "claimed") throw new MoltbookHttpError(`Moltbook agent is not claimed: ${parsed.status}`, undefined, false);
    return { authorized: true, ...(parsed.status ? { status: parsed.status } : {}) };
  }

  private async getJson(url: URL): Promise<unknown> {
    assertWithinBase(url, this.baseUrl);
    const apiKey = this.options.publicReadOnly ? undefined : await requireSecret(this.options.secretProvider, this.options.secretReference);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "User-Agent": "marx-moltbook-growth-engine/0.2" },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new MoltbookHttpError(
          `Moltbook read request failed with HTTP ${response.status}`,
          response.status,
          response.status === 429 || response.status >= 500,
          retryAfterMs,
        );
      }
      try {
        return await response.json() as unknown;
      } catch {
        // A transient edge/challenge response can be HTTP 200 while not
        // containing the expected JSON envelope. Keep the retry bounded at
        // the authorized source boundary instead of treating that response
        // as proof that the API contract is permanently broken.
        throw new MoltbookHttpError("Moltbook read response contained malformed JSON", response.status, true);
      }
    } catch (error) {
      if (error instanceof MoltbookHttpError) throw error;
      if (controller.signal.aborted) throw new MoltbookHttpError("Moltbook read request timed out", undefined, true);
      if (error instanceof Error && /redirect/iu.test(error.message)) throw new MoltbookHttpError("Moltbook read request refused a redirect", undefined, false);
      throw new MoltbookHttpError(`Moltbook read request failed: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(path: string, query: Record<string, string> = {}): URL {
    const base = this.baseUrl.href.endsWith("/") ? this.baseUrl.href : `${this.baseUrl.href}/`;
    const url = new URL(path.replace(/^\/+/, ""), base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private toPost(raw: z.infer<typeof RawPostSchema>): MoltbookPost {
    const fetchedAt = this.now().toISOString();
    const content = [raw.title?.trim(), raw.content?.trim()].filter(Boolean).join("\n\n");
    return {
      postId: raw.id,
      url: `https://www.moltbook.com/post/${encodeURIComponent(raw.id)}`,
      submolt: raw.submolt.name,
      author: { ...(raw.author?.id ?? raw.author_id ? { id: raw.author?.id ?? raw.author_id } : {}), ...(raw.author?.name ? { name: raw.author.name } : {}), type: "agent" },
      content,
      createdAt: raw.created_at,
      fetchedAt,
      engagement: { replies: raw.comment_count ?? 0, reactions: Math.max(0, (raw.upvotes ?? 0) - (raw.downvotes ?? 0)) },
      metadata: {
        source: "moltbook-official-api-v1",
        postType: raw.type,
        verificationStatus: raw.verification_status,
        labels: raw.labels ?? [],
        submoltDisplayName: raw.submolt.display_name,
      },
    };
  }

  private toSearchPost(raw: z.infer<typeof SearchResultSchema>): MoltbookPost {
    const postId = raw.post_id ?? raw.id;
    if (!postId) throw new Error("Moltbook search result did not contain a post id");
    const fetchedAt = this.now().toISOString();
    return {
      postId,
      url: `https://www.moltbook.com/post/${encodeURIComponent(postId)}`,
      submolt: raw.submolt.name,
      author: { ...(raw.author?.id ? { id: raw.author.id } : {}), ...(raw.author?.name ? { name: raw.author.name } : {}), type: "agent" },
      content: [raw.title?.trim(), raw.content?.trim()].filter(Boolean).join("\n\n"),
      createdAt: raw.created_at,
      fetchedAt,
      engagement: { replies: raw.comment_count ?? 0, reactions: Math.max(0, (raw.upvotes ?? 0) - (raw.downvotes ?? 0)) },
      metadata: { source: "moltbook-official-search", searchType: "posts", submoltDisplayName: raw.submolt.display_name, searchRelevance: raw.relevance },
    };
  }
}

type CurlFetchInput = Parameters<typeof fetch>[0];
type CurlFetchInit = Parameters<typeof fetch>[1];

function curlFetch(input: CurlFetchInput, init?: CurlFetchInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") throw new Error("Moltbook curl transport is GET-only");
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const config = [
    `url = ${curlConfigQuote(url.href)}`,
    "request = GET",
    "proto = https",
    "max-redirs = 0",
    // The host can transiently fail TCP connects while the browser remains
    // reachable. Keep this transport-level retry small and bounded; HTTP
    // responses still flow through the status-aware application retry policy.
    "retry = 2",
    "retry-delay = 1",
    "retry-max-time = 12",
    "retry-connrefused",
    "silent",
    "show-error",
    "connect-timeout = 10",
    "max-time = 20",
    `write-out = ${curlConfigQuote("%{stderr}__MARX_STATUS__:%{http_code}__MARX_HEADERS__:%{header_json}")}`,
    ...Array.from(headers.entries()).map(([name, value]) => `header = ${curlConfigQuote(`${name}: ${value}`)}`),
  ].join("\n");

  return new Promise<Response>((resolve, reject) => {
    const child = spawn("/usr/bin/curl", ["--config", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finishFailure = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finishFailure(new Error("Moltbook curl request aborted"));
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finishFailure(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code) => {
      if (settled) return;
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      const marker = diagnostics.lastIndexOf("__MARX_STATUS__:");
      const statusText = marker >= 0 ? diagnostics.slice(marker + "__MARX_STATUS__:".length).split("__MARX_HEADERS__:", 1)[0] : "";
      const status = Number(statusText);
      if (code !== 0 || !Number.isInteger(status) || status < 100) {
        finishFailure(new Error(`Moltbook curl request failed${diagnostics ? `: ${diagnostics.replace(/__MARX_STATUS__:[\s\S]*$/u, "").trim()}` : ""}`));
        return;
      }
      const headerStart = diagnostics.lastIndexOf("__MARX_HEADERS__:");
      const responseHeaders = new Headers();
      if (headerStart >= 0) {
        const rawHeaders = diagnostics.slice(headerStart + "__MARX_HEADERS__:".length).trim();
        try {
          const parsedHeaders = JSON.parse(rawHeaders) as Record<string, string | string[]>;
          for (const [name, value] of Object.entries(parsedHeaders)) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        } catch {
          finishFailure(new Error("Moltbook curl response headers were malformed"));
          return;
        }
      }
      settled = true;
      resolve(new Response(Buffer.concat(stdout), { status, headers: responseHeaders }));
    });
    if (init?.signal) {
      if (init.signal.aborted) {
        abort();
        return;
      }
      init.signal.addEventListener("abort", abort, { once: true });
      child.once("close", () => init.signal?.removeEventListener("abort", abort));
    }
    child.stdin.end(config, "utf8");
  });
}

function curlConfigQuote(value: string): string {
  return `"${value.replace(/([\\"])/gu, "\\$1").replace(/[\r\n]/gu, " ")}"`;
}

function validateBaseUrl(value: string, allowTestBaseUrl: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Moltbook API base URL must not contain credentials, query, or fragment");
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const official = url.protocol === "https:" && url.hostname === "www.moltbook.com" && normalizedPath === "/api/v1";
  if (!official && !allowTestBaseUrl) throw new Error(`Moltbook API base URL must be ${OFFICIAL_MOLTBOOK_API_BASE_URL}`);
  if (!allowTestBaseUrl && url.port) throw new Error("Moltbook API base URL must not use a custom port");
  url.pathname = normalizedPath;
  return url;
}

function assertWithinBase(url: URL, base: URL): void {
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.username || url.password) {
    throw new Error("Refusing to send Moltbook credentials outside the configured API base URL");
  }
}

function pathSegment(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") throw new Error(`${label} is invalid`);
  return encodeURIComponent(normalized);
}

function publicAuthorContext(author: z.infer<typeof RawAuthorSchema> | undefined): Record<string, unknown> | undefined {
  if (!author) return undefined;
  return {
    description: author.description,
    karma: author.karma,
    followerCount: author.followerCount,
    followingCount: author.followingCount,
    isClaimed: author.isClaimed,
    isActive: author.isActive,
    createdAt: author.createdAt,
    lastActive: author.lastActive,
  };
}

function flattenComments(comments: RawComment[], output: PostReply[] = []): PostReply[] {
  for (const comment of comments) {
    if (!comment.is_deleted && !comment.is_spam && comment.content !== null && comment.content !== undefined) {
      output.push({
        replyId: comment.id,
        author: { ...(comment.author?.id ?? comment.author_id ? { id: comment.author?.id ?? comment.author_id } : {}), ...(comment.author?.name ? { name: comment.author.name } : {}), type: "agent" },
        content: comment.content,
        createdAt: comment.created_at,
        ...(comment.parent_id ? { parentId: comment.parent_id } : {}),
        engagement: { reactions: Math.max(0, (comment.upvotes ?? 0) - (comment.downvotes ?? 0)), replies: comment.replies?.length ?? 0 },
      });
    }
    flattenComments(comment.replies ?? [], output);
  }
  return output;
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function isRetryableMoltbookError(error: unknown): boolean {
  return error instanceof MoltbookHttpError && error.retryable;
}
