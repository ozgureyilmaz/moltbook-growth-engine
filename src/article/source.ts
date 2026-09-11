import { MarxArticleSchema, type MarxAgentReply, type MarxArticle } from "../schemas";

const MARX_HOSTS = new Set(["marx.finance", "www.marx.finance"]);
const MAX_ARTICLE_CHARS = 40_000;

type RawMarxReply = {
  id?: unknown;
  body?: unknown;
  content?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  agent?: { id?: unknown; name?: unknown };
  author?: { id?: unknown; name?: unknown };
};

function articleIdFromUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !MARX_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Marx article URL must use https://marx.finance");
  const match = url.pathname.match(/^\/feed\/([^/]+)$/u);
  if (!match?.[1]) throw new Error("Marx article URL must use /feed/<post-id>");
  return decodeURIComponent(match[1]);
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function quoteFor(reply: string): string {
  const normalized = clean(reply);
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).trimEnd()}…`;
}

function toReply(raw: RawMarxReply, sourceUrl: string): MarxAgentReply | undefined {
  const agent = raw.agent ?? raw.author;
  const replyId = clean(raw.id);
  const agentId = clean(agent?.id);
  const agentName = clean(agent?.name);
  const body = clean(raw.body ?? raw.content);
  if (!replyId || !agentId || !agentName || !body) return undefined;
  const createdAt = clean(raw.createdAt ?? raw.created_at);
  return {
    replyId,
    agentId,
    agentName,
    body,
    sourceUrl,
    ...(createdAt ? { createdAt } : {}),
    quote: quoteFor(body),
  };
}

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", "User-Agent": "marx-moltbook-growth-engine/0.2" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Marx article read failed with HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMarxArticle(sourceUrl: string, options: { timeoutMs?: number } = {}): Promise<MarxArticle> {
  const articleId = articleIdFromUrl(sourceUrl);
  const canonicalUrl = `https://marx.finance/feed/${encodeURIComponent(articleId)}`;
  const raw = await getJson(`https://marx.finance/api/posts/${encodeURIComponent(articleId)}`, options.timeoutMs);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Marx article response was not an object");
  const value = raw as Record<string, unknown>;
  const repliesRaw = [
    ...(Array.isArray(value.replies) ? value.replies : []),
    ...(Array.isArray(value.replies_on_post) ? value.replies_on_post : []),
    ...(Array.isArray(value.latestReplies) ? value.latestReplies : []),
  ] as RawMarxReply[];
  const seen = new Set<string>();
  const rawReplyCount = Number(value.replyCount ?? value.reply_count ?? repliesRaw.length);
  const replyCount = Number.isFinite(rawReplyCount) && rawReplyCount >= 0 ? Math.floor(rawReplyCount) : repliesRaw.length;
  const evidenceStatus: "complete" | "partial" = replyCount > 0 && repliesRaw.length < replyCount ? "partial" : "complete";
  const agentReplies = repliesRaw
    .map((reply) => toReply(reply, canonicalUrl))
    .filter((reply): reply is MarxAgentReply => Boolean(reply))
    .filter((reply) => {
      if (seen.has(reply.replyId)) return false;
      seen.add(reply.replyId);
      return true;
    });
  const title = clean(value.title);
  const body = clean(value.body ?? value.content);
  if (!title || !body) throw new Error("Marx article response is missing title or body");
  const tickers = Array.isArray(value.tickers) ? value.tickers.map(clean).filter(Boolean) : [];
  const topics = ["Federal Reserve", "inflation", "interest rates", "PCE", "macro markets", ...tickers]
    .filter((item, index, all) => all.indexOf(item) === index);
  const createdAt = clean(value.createdAt ?? value.created_at);
  return MarxArticleSchema.parse({
    articleId,
    sourceUrl: canonicalUrl,
    title,
    body: body.slice(0, MAX_ARTICLE_CHARS),
    ...(clean(value.sourceName) ? { sourceName: clean(value.sourceName) } : {}),
    ...(clean(value.sourceUrl) ? { originalSourceUrl: clean(value.sourceUrl) } : {}),
    ...(createdAt ? { createdAt } : {}),
    tickers,
    topics,
    replyCount,
    visibleReplyCount: agentReplies.length,
    evidenceStatus: agentReplies.length === 0 ? "unavailable" : evidenceStatus,
    agentReplies,
    fetchedAt: new Date().toISOString(),
  });
}

export function marxArticleIdFromUrl(sourceUrl: string): string {
  return articleIdFromUrl(sourceUrl);
}
