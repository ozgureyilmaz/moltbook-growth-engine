import { analyzeUntrustedText } from "../security";
import type { ConversationContext, MoltbookPost, PostContext, PostReply } from "../orchestrator/contracts";

const MARX_PATTERN = /\bmarx\b/gi;

function textForReply(reply: PostReply): string {
  const author = reply.author.name ?? reply.author.id ?? "agent";
  return `${author}: ${reply.content}`;
}

function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function repeatedAngles(post: MoltbookPost, replies: PostReply[]): string[] {
  const statements = [post.content, ...replies.map((reply) => reply.content)]
    .map(normalizePhrase)
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (const statement of statements) {
    const words = statement.split(" ").filter((word) => word.length > 4);
    for (let index = 0; index < words.length - 2; index += 1) {
      const phrase = words.slice(index, index + 3).join(" ");
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([phrase]) => phrase);
}

export function buildConversationContext(context: PostContext): ConversationContext {
  const replies = context.replies ?? [];
  const sections = [
    `POST (${context.post.author.name ?? context.post.author.id ?? "agent"}): ${context.post.content}`,
    context.parent ? `PARENT: ${context.parent.content}` : "",
    ...replies.map((reply) => `REPLY: ${textForReply(reply)}`),
  ].filter(Boolean);
  const conversationText = sections.join("\n");
  const untrustedSignals = [
    ...analyzeUntrustedText(context.post.content).injectionSignals,
    ...replies.flatMap((reply) => analyzeUntrustedText(reply.content).injectionSignals),
  ];
  const marxMentions = (conversationText.match(MARX_PATTERN) ?? []).length;
  const angles = repeatedAngles(context.post, replies);
  return {
    ...context,
    replies,
    conversationText,
    marxMentions,
    repeatedAngles: angles,
    saturated: marxMentions >= 2 || angles.length >= 4,
    untrustedSignals,
  };
}

export interface ContextBuilder {
  build(post: MoltbookPost): Promise<ConversationContext>;
}

export class SourceContextBuilder implements ContextBuilder {
  public constructor(private readonly source: { fetchPostContext(postId: string): Promise<PostContext> }) {}

  public async build(post: MoltbookPost): Promise<ConversationContext> {
    const fetched = await this.source.fetchPostContext(post.postId);
    return buildConversationContext({ ...fetched, post: fetched.post ?? post });
  }
}

export function contextHasSpecificAnchor(context: ConversationContext, candidate: string): boolean {
  const source = normalizePhrase(context.post.content);
  const comment = normalizePhrase(candidate);
  if (!source || !comment) return false;
  const sourceWords = new Set(source.split(" ").filter((word) => word.length > 4));
  const commentWords = comment.split(" ").filter((word) => word.length > 4);
  const overlap = new Set(commentWords.filter((word) => sourceWords.has(word)));
  // A proper noun, number, or two content words is a useful minimum anchor.
  const properOrNumber = (candidate.match(/\b[A-Z][a-z]{2,}\b|\b\d+(?:\.\d+)?%?\b/g) ?? [])
    .filter((value) => value.toLowerCase() !== "marx");
  return overlap.size >= 2 || properOrNumber.length > 0;
}

export function extractContextAnchors(context: ConversationContext): string[] {
  const words = context.post.content.match(/\b[A-Za-z][A-Za-z0-9-]{4,}\b/g) ?? [];
  const replyWords = context.replies.flatMap((reply) => reply.content.match(/\b[A-Za-z][A-Za-z0-9-]{4,}\b/g) ?? []);
  return [...new Set([...words, ...replyWords])].slice(0, 24);
}
