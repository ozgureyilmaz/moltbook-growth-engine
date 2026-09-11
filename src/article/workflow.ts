import { EnvironmentSecretProvider } from "../secrets";
import { FixtureMoltbookSource, AuthorizedMoltbookSource, MoltbookHttpClient, MoltbookHttpError, isRetryableMoltbookError } from "../discovery";
import { analyzeUntrustedText } from "../security";
import type { MoltbookPost, PersistenceLike, PostContext } from "../orchestrator/contracts";
import { SolOrchestrator, type ObservableRunSummary, type OrchestratorOptions, type OrchestratorResult } from "../orchestrator";
import { LocalOutbox } from "../outbox";
import type { MarxArticle } from "../schemas";
import { fetchMarxArticle } from "./source";
import { annotateRelatedPost, buildArticleSearchQueries, chooseMarxEvidence, rankRelatedPosts, type RelatedMoltbookPost } from "./related";

export type ArticleWorkflowOptions = {
  articleUrl: string;
  maxPosts?: number;
  searchLimitPerQuery?: number;
  sourceTimeoutMs?: number;
  persistence?: PersistenceLike;
  outbox?: LocalOutbox;
  includeAgentQuotes?: boolean;
  includeSourceLink?: boolean;
  targetPostIds?: string[];
  orchestratorOptions?: Omit<OrchestratorOptions, "sourceMode" | "fixturePosts">;
};

export type ArticleWorkflowPreparation = {
  article: MarxArticle;
  queries: string[];
  related: RelatedMoltbookPost[];
  posts: MoltbookPost[];
  contexts: Record<string, PostContext>;
};

export type ArticleWorkflowResult = OrchestratorResult & {
  article: MarxArticle;
  queries: string[];
  relatedPosts: RelatedMoltbookPost[];
};

function publicReadClient(timeoutMs: number): MoltbookHttpClient {
  return new MoltbookHttpClient({
    secretProvider: new EnvironmentSecretProvider({}),
    secretReference: { name: "unused-public-read-key" },
    baseUrl: "https://www.moltbook.com/api/v1",
    timeoutMs,
    publicReadOnly: true,
  });
}

export type MoltbookRetryOptions = {
  maxAttempts?: number;
  backoffMs?: number;
};

/** Retry only transient official-read failures with a small bounded budget. */
export async function retryMoltbookRead<T>(operation: () => Promise<T>, options: MoltbookRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("Moltbook retry maxAttempts must be a positive integer");
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) throw new Error("Moltbook retry backoffMs must be a non-negative integer");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableMoltbookError(error) || attempt === maxAttempts) throw error;
      const retryAfterMs = error instanceof MoltbookHttpError ? error.retryAfterMs ?? 0 : 0;
      const waitMs = Math.min(5_000, Math.max(backoffMs * attempt, retryAfterMs));
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error("Moltbook retry loop terminated unexpectedly");
}

export async function prepareArticleWorkflow(options: Pick<ArticleWorkflowOptions, "articleUrl" | "maxPosts" | "searchLimitPerQuery" | "sourceTimeoutMs" | "includeAgentQuotes" | "targetPostIds">): Promise<ArticleWorkflowPreparation> {
  const article = await fetchMarxArticle(options.articleUrl, { timeoutMs: options.sourceTimeoutMs });
  const queries = buildArticleSearchQueries(article);
  const client = publicReadClient(options.sourceTimeoutMs ?? 20_000);
  const targetIds = [...new Set(options.targetPostIds ?? [])];
  const rawPosts = targetIds.length > 0
    ? []
    : (await Promise.all(queries.map((query) => retryMoltbookRead(
      () => client.searchPosts(query, options.searchLimitPerQuery ?? 10),
      { maxAttempts: 3, backoffMs: 500 },
    )))).flat();
  const source = new AuthorizedMoltbookSource(client, {
    authorized: true,
    allowedDomains: ["www.moltbook.com"],
    maxPages: 1,
    maxAttempts: 2,
    retryBackoffMs: 250,
  });
  const posts = rawPosts.map((value) => value as MoltbookPost);
  let related: RelatedMoltbookPost[];
  if (targetIds.length > 0) {
    const directSource = new AuthorizedMoltbookSource(client, { authorized: true, allowedDomains: ["www.moltbook.com"], maxPages: 1 });
    const directContexts = await Promise.all(targetIds.map((postId) => directSource.fetchPostContext(postId)));
    const directPosts = directContexts.map((context) => context.post);
    const ranked = rankRelatedPosts(article, directPosts);
    related = targetIds.map((postId) => ranked.find((item) => item.post.postId === postId) ?? ({ post: directPosts.find((post) => post.postId === postId)!, score: 0, matchedTerms: [] })).filter((item) => Boolean(item.post));
  } else {
    related = rankRelatedPosts(article, posts)
      .filter((item, index, all) => all.findIndex((candidate) => candidate.post.postId === item.post.postId) === index)
      .slice(0, options.maxPosts ?? 25);
  }
  const contexts = await Promise.all(related.map(async (item) => {
    const evidence = chooseMarxEvidence(article, item.post);
    const searchPost = annotateRelatedPost(item.post, article, evidence, { includeAgentQuotes: options.includeAgentQuotes });
    const context = await source.fetchPostContext(searchPost.postId);
    const fetchedPost = annotateRelatedPost(context.post ?? searchPost, article, evidence, { includeAgentQuotes: options.includeAgentQuotes });
    const contaminated = [fetchedPost.content, ...context.replies.map((reply) => reply.content)].some((text) => analyzeUntrustedText(text).containsPromptInjection);
    return contaminated ? undefined : { post: fetchedPost, context: { ...context, post: fetchedPost } };
  }));
  const safeContexts = contexts.filter((value): value is { post: MoltbookPost; context: Awaited<ReturnType<typeof source.fetchPostContext>> } => Boolean(value));
  return {
    article,
    queries,
    related,
    posts: safeContexts.map(({ post }) => post),
    contexts: Object.fromEntries(safeContexts.map(({ post, context }) => [post.postId, context])),
  };
}

export async function runArticleWorkflow(options: ArticleWorkflowOptions): Promise<ArticleWorkflowResult> {
  const preparation = await prepareArticleWorkflow(options);
  const source = new FixtureMoltbookSource({
    posts: preparation.posts,
    contexts: preparation.contexts,
  });
  const orchestrator = new SolOrchestrator(source, options.persistence, options.outbox);
  const result = await orchestrator.run({
    ...(options.orchestratorOptions ?? {}),
    sourceMode: "live_read_only" as ObservableRunSummary["sourceMode"],
    fixturePosts: preparation.posts,
    dryRun: options.orchestratorOptions?.dryRun ?? true,
    discoveryLimit: options.orchestratorOptions?.discoveryLimit ?? preparation.posts.length,
    includeAgentQuotes: options.includeAgentQuotes,
    includeSourceLink: options.includeSourceLink,
    sourceLink: options.includeSourceLink ? preparation.article.sourceUrl : undefined,
  });
  return { ...result, article: preparation.article, queries: preparation.queries, relatedPosts: preparation.related };
}
