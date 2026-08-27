import type { MoltbookPost } from "../orchestrator/contracts";

export type RawMoltbookPost = Partial<MoltbookPost> & {
  id?: string;
  title?: string;
  body?: string;
  text?: string;
  community?: string;
  created_at?: string;
  author_id?: string;
  author_name?: string;
};

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizePost(raw: RawMoltbookPost, fetchedAt = new Date().toISOString()): MoltbookPost {
  const postId = cleanText(raw.postId ?? raw.id);
  if (!postId) throw new Error("Cannot normalize a Moltbook post without an id");
  const content = cleanText(raw.content ?? raw.body ?? raw.text);
  const author = raw.author ?? {
    id: cleanText(raw.author_id) || undefined,
    name: cleanText(raw.author_name) || undefined,
  };
  return {
    postId,
    url: cleanText(raw.url) || `https://moltbook.local/post/${encodeURIComponent(postId)}`,
    submolt: cleanText(raw.submolt ?? raw.community) || "unknown",
    author: {
      id: cleanText(author.id) || undefined,
      name: cleanText(author.name) || undefined,
      type: cleanText(author.type) || undefined,
    },
    content,
    createdAt: cleanText(raw.createdAt ?? raw.created_at) || fetchedAt,
    fetchedAt,
    parentId: cleanText(raw.parentId) || undefined,
    engagement: raw.engagement
      ? { replies: raw.engagement.replies ?? 0, reactions: raw.engagement.reactions ?? 0 }
      : { replies: 0, reactions: 0 },
    metadata: raw.metadata ? { ...raw.metadata } : undefined,
  };
}

function normalizedKey(post: MoltbookPost): string {
  return post.postId || `${post.url}|${post.author.id ?? post.author.name ?? ""}|${post.createdAt}`;
}

/** Stable first-seen deduplication; later copies cannot overwrite trusted context. */
export function deduplicatePosts(posts: MoltbookPost[]): MoltbookPost[] {
  const seen = new Set<string>();
  const result: MoltbookPost[] = [];
  for (const post of posts) {
    const key = normalizedKey(post);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(post);
  }
  return result;
}

export function normalizeAndDeduplicate(rawPosts: RawMoltbookPost[]): MoltbookPost[] {
  const fetchedAt = new Date().toISOString();
  return deduplicatePosts(rawPosts.map((raw) => normalizePost(raw, fetchedAt)));
}

