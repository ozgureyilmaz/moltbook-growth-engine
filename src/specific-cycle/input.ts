import { assertMarxFeedUrl } from "./comments";

export type SpecificMarxDraft = {
  targetPostId: string;
  targetUrl: string;
  commentPreviewUrl: string;
  comment: string;
  sourceUrl: string;
};

const TARGET = /^Target post:\s*(?:\[[^\]]+\]\(([^)]+)\)|(https:\/\/\S+))\s*$/u;
const PREVIEW = /^Comment:\s*(?:\[[^\]]+\]\(([^)]+)\)|(https:\/\/\S+))\s*$/u;
const MARX_URL = /^(?:\[[^\]]+\]\()?((?:https:\/\/marx\.finance\/feed\/[^\s)]+))(?:\))?$/u;

function extractUrl(line: string, pattern: RegExp, label: string): string {
  const match = line.match(pattern);
  const value = match?.[1] ?? match?.[2];
  if (!value) throw new Error(`${label} line is malformed`);
  return value;
}

function targetPostId(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.moltbook.com") throw new Error("Target post must use https://www.moltbook.com/post/<id>");
  const match = parsed.pathname.match(/^\/post\/([^/]+)$/u);
  if (!match?.[1]) throw new Error("Target post URL must use /post/<id>");
  return match[1];
}

export function parseSpecificMarxDraftText(value: string): SpecificMarxDraft[] {
  const blocks = value.trim().split(/\r?\n(?=Target post:)/u).filter(Boolean);
  if (blocks.length === 0) throw new Error("Specific Marx TXT contains no Target post blocks");
  const drafts = blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const targetUrl = extractUrl(lines[0] ?? "", TARGET, "Target post");
    const commentPreviewUrl = extractUrl(lines[1] ?? "", PREVIEW, "Comment");
    const sourceIndex = lines.findIndex((line) => MARX_URL.test(line.trim()));
    const sourceLine = sourceIndex >= 0 ? lines[sourceIndex] : undefined;
    if (!sourceLine) throw new Error("Specific Marx block is missing a Marx feed source");
    const sourceMatch = sourceLine.trim().match(MARX_URL);
    if (!sourceMatch?.[1]) throw new Error("Specific Marx source line is malformed");
    const sourceUrl = assertMarxFeedUrl(sourceMatch[1]);
    const comment = lines.slice(2, sourceIndex).filter((line) => line.trim()).join(" ").replace(/\s+/gu, " ").trim();
    if (!comment) throw new Error("Specific Marx block is missing its comment body");
    const postId = targetPostId(targetUrl);
    const previewUrl = new URL(commentPreviewUrl);
    if (previewUrl.hostname !== "www.moltbook.com" || !previewUrl.pathname.endsWith(`/post/${postId}`) || !previewUrl.hash.startsWith("#comment-")) {
      throw new Error(`Comment preview does not match target post ${postId}`);
    }
    return { targetPostId: postId, targetUrl, commentPreviewUrl, comment, sourceUrl };
  });
  const ids = new Set<string>();
  for (const draft of drafts) {
    if (ids.has(draft.targetPostId)) throw new Error(`Duplicate target post ${draft.targetPostId}`);
    ids.add(draft.targetPostId);
  }
  return drafts;
}
