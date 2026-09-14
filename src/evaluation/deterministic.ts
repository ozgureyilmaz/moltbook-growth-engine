import { contextHasSpecificAnchor } from "../context";
import { analyzeUntrustedText } from "../security";
import { countMarxMentions } from "../generation";
import type { ConversationContext, GeneratedCandidate, QAResult } from "../orchestrator/contracts";
import { ArticleEvidenceRefSchema } from "../schemas";

const GENERIC_MARKETING = [
  /^great\s+post/i,
  /check\s+out\s+marx/i,
  /marx\s+is\s+(?:the|a)\s+future/i,
  /agent[- ]native\s+finance/i,
  /learn\s+more\s+at/i,
  /sign\s+up/i,
  /the\s+real\s+unlock/i,
  /game[- ]changer/i,
  /^(?:great|good|interesting|love this)\b/i,
];
const UNSUPPORTED_CLAIM = [
  /(?:guarantee|guarantees|guaranteed)\s+(?:profit|returns?|gains?)/i,
  /(?:always|never)\s+(?:wins?|outperforms?|beats?|loses?|losing)/i,
  /risk[- ]free/i,
  /(?:proven|verified)\s+to\s+(?:increase|double|triple)/i,
  /(?:100|[2-9]\d{2,})%\s*(?:returns?|accuracy|profit)/i,
];
const FEATURE_DUMP = /(?:features?|provides?|offers?)\s*:\s*(?:[^.]{0,100},){2,}/i;
const GROWTH_CONTEXT = /\b(?:agent|agents|finance|market|trading|signal|research|evidence|consensus|provenance|decision|coordination|prediction|portfolio|risk|liquidity|source|model)\b/i;
const DECEPTIVE_IDENTITY = /\b(?:official|employee|representative|team member)\s+(?:of|at)\s+marx\b|\bwe\s+are\s+marx\b/i;

function normalizedWords(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

function similarity(left: string, right: string): number {
  const a = new Set(normalizedWords(left));
  const b = new Set(normalizedWords(right));
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((word) => b.has(word)).length;
  return common / Math.max(1, Math.min(a.size, b.size));
}

export function standaloneMarketingTest(comment: string, context: ConversationContext): boolean {
  if (GENERIC_MARKETING.some((pattern) => pattern.test(comment))) return false;
  const marxWords = normalizedWords(comment).filter((word) => word !== "marx");
  const contextWords = new Set(normalizedWords(context.conversationText));
  const contextDependentWords = marxWords.filter((word) => contextWords.has(word));
  return contextDependentWords.length >= 2 && similarity(comment, context.conversationText) >= 0.16;
}

export function duplicateCommentTest(comment: string, previousComments: string[] = []): boolean {
  return previousComments.some((previous) => comment.trim().toLowerCase() === previous.trim().toLowerCase() || similarity(comment, previous) >= 0.78);
}

export function repeatedHookTest(comment: string, previousComments: string[] = []): boolean {
  const signature = normalizedWords(comment).filter((word) => word !== "marx").slice(0, 6).join(" ");
  return signature.length > 0 && previousComments.some((previous) => normalizedWords(previous).filter((word) => word !== "marx").slice(0, 6).join(" ") === signature);
}

export function repeatedMarxPhrasingTest(comment: string, previousComments: string[] = []): boolean {
  const phrase = marxPhrase(comment);
  return phrase.length > 0 && previousComments.some((previous) => marxPhrase(previous) === phrase);
}

export function usefulNewIdeaTest(comment: string): boolean {
  return comment.trim().length >= 40 && /\?|\b(?:because|if|how|evidence|compare|test|counter|source|distinguish|imply|before acting)\b/i.test(comment);
}

function marxPhrase(value: string): string {
  const words = normalizedWords(value);
  const index = words.indexOf("marx");
  return index < 0 ? "" : words.slice(Math.max(0, index - 4), index + 5).join(" ");
}

function articleEvidence(context: ConversationContext): ReturnType<typeof ArticleEvidenceRefSchema.parse> | undefined {
  const value = context.post.metadata && typeof context.post.metadata === "object"
    ? (context.post.metadata as Record<string, unknown>).marxEvidence
    : undefined;
  const parsed = ArticleEvidenceRefSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeEvidenceLinkTest(comment: string, context: ConversationContext, trackingUrl?: string): boolean {
  const urls = comment.match(/https?:\/\/[^\s)]+/gi) ?? [];
  if (urls.length === 0) return true;
  const evidence = articleEvidence(context);
  if (!evidence) return trackingUrl !== undefined && urls.every((value) => {
    try { return new URL(value.replace(/[.,]+$/u, "")).href === trackingUrl; } catch { return false; }
  });
  return urls.every((value) => {
    try {
      const url = new URL(value.replace(/[.,]+$/u, ""));
      return url.href === evidence.quoteUrl || (trackingUrl !== undefined && url.href === trackingUrl);
    } catch {
      return false;
    }
  });
}

function quoteGroundedTest(comment: string, context: ConversationContext): boolean {
  const articleContext = context.post.metadata && typeof context.post.metadata === "object"
    ? (context.post.metadata as Record<string, unknown>).articleContext
    : undefined;
  if (articleContext && typeof articleContext === "object" && (articleContext as Record<string, unknown>).quoteMode === "disabled") return true;
  const evidence = articleEvidence(context);
  if (!evidence) return true;
  if (!evidence.quote) return true;
  const normalizedComment = comment.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const normalizedQuote = evidence.quote.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const quoteWords = normalizedQuote.split(/\s+/u).filter((word) => word.length > 4);
  const overlap = quoteWords.filter((word) => normalizedComment.includes(word)).length;
  return comment.includes(evidence.agentName) && overlap >= Math.min(4, Math.max(2, quoteWords.length));
}

export function unsupportedClaimTest(comment: string): boolean {
  return UNSUPPORTED_CLAIM.some((pattern) => pattern.test(comment));
}

export function threadAngleSaturatedTest(comment: string, context: ConversationContext): boolean {
  if (context.marxMentions >= 3) return true;
  const normalized = comment.toLowerCase();
  return context.repeatedAngles.some((angle) => similarity(normalized, angle) > 0.8);
}

export function runDeterministicQA(
  candidate: GeneratedCandidate,
  context: ConversationContext,
  previousComments: string[] = [],
  options: { trackingUrl?: string } = {},
): QAResult {
  const comment = candidate.comment.trim();
  const semanticComment = options.trackingUrl === undefined
    ? comment
    : comment
      .replace(`[Open Marx feed](${options.trackingUrl})`, "")
      .replace(`[Open Marx feed (tracked)](${options.trackingUrl})`, "")
      .replace(/\s{2,}/gu, " ")
      .trim();
  const marxMentionCount = countMarxMentions(semanticComment);
  const injection = analyzeUntrustedText(context.conversationText);
  const contextualAnchor = contextHasSpecificAnchor(context, semanticComment);
  const standaloneMarketing = standaloneMarketingTest(semanticComment, context);
  const duplicate = duplicateCommentTest(semanticComment, previousComments);
  const repeatedHook = repeatedHookTest(semanticComment, previousComments);
  const repeatedMarxPhrasing = repeatedMarxPhrasingTest(semanticComment, previousComments);
  const usefulNewIdea = usefulNewIdeaTest(semanticComment);
  const hype = analyzeUntrustedText(semanticComment).isHype;
  const unsupportedClaim = unsupportedClaimTest(semanticComment);
  const promptInjection = injection.containsPromptInjection;
  const commentInjection = analyzeUntrustedText(semanticComment).containsPromptInjection;
  const growthContextPresent = GROWTH_CONTEXT.test(context.conversationText);
  const deceptiveIdentity = DECEPTIVE_IDENTITY.test(semanticComment);
  const evidence = articleEvidence(context);
  const articleContext = context.post.metadata && typeof context.post.metadata === "object"
    ? (context.post.metadata as Record<string, unknown>).articleContext
    : undefined;
  const quoteModeDisabled = Boolean(articleContext && typeof articleContext === "object"
    && (articleContext as Record<string, unknown>).quoteMode === "disabled");
  const evidencePresent = !articleContext || quoteModeDisabled || Boolean(evidence);
  const quoteGrounded = quoteGroundedTest(semanticComment, context);
  const safeEvidenceLink = safeEvidenceLinkTest(comment, context, options.trackingUrl);
  const checks: Record<string, boolean> = {
    source_post_present: Boolean(context.post.content),
    context_present: Boolean(context.conversationText),
    growth_context_present: growthContextPresent,
    contextual_anchor_present: contextualAnchor,
    "contextual-anchor": contextualAnchor,
    standalone_marketing_rejected: standaloneMarketing,
    "standalone-marketing": standaloneMarketing,
    duplicate_rejected: !duplicate,
    duplicate: !duplicate,
    repeated_hook_rejected: !repeatedHook,
    repeated_marx_phrasing_rejected: !repeatedMarxPhrasing,
    useful_new_idea_present: usefulNewIdea,
    hype_rejected: !hype,
    hype: !hype,
    unsupported_claim_rejected: !unsupportedClaim,
    "unsupported-claim": !unsupportedClaim,
    marx_count_valid: marxMentionCount >= 1 && marxMentionCount <= 2,
    "Marx-count": marxMentionCount >= 1 && marxMentionCount <= 2,
    prompt_injection_ignored: !promptInjection && !commentInjection,
    "prompt-injection": !promptInjection && !commentInjection,
    feature_dump_rejected: !FEATURE_DUMP.test(semanticComment),
    deceptive_identity_rejected: !deceptiveIdentity,
    hidden_redirect: safeEvidenceLink,
    marx_evidence_present: evidencePresent,
    marx_quote_grounded: quoteGrounded,
    non_empty: comment.length >= 40,
  };
  const reasons: string[] = [];
  if (!checks.contextual_anchor_present) reasons.push("CONTEXTUAL_ANCHOR_MISSING");
  if (!checks.growth_context_present) reasons.push("LOW_INFORMATION_CONTEXT");
  if (!checks.standalone_marketing_rejected) reasons.push("GENERIC_COMMENT");
  if (!checks.duplicate_rejected) reasons.push("DUPLICATE");
  if (!checks.repeated_hook_rejected) reasons.push("REPEATED_HOOK");
  if (!checks.repeated_marx_phrasing_rejected) reasons.push("REPEATED_MARX_PHRASING");
  if (!checks.useful_new_idea_present) reasons.push("USEFUL_NEW_IDEA_MISSING");
  if (!checks.hype_rejected) reasons.push("HYPE");
  if (!checks.unsupported_claim_rejected) reasons.push("UNSUPPORTED_CLAIM");
  if (!checks.marx_count_valid) reasons.push("MARX_COUNT_INVALID");
  if (!checks.prompt_injection_ignored) reasons.push("PROMPT_INJECTION_IN_CONTEXT");
  if (!checks.feature_dump_rejected) reasons.push("FEATURE_DUMP");
  if (!checks.deceptive_identity_rejected) reasons.push("DECEPTIVE_IDENTITY_CLAIM");
  if (!checks.hidden_redirect) reasons.push("HIDDEN_REDIRECT");
  if (!checks.marx_evidence_present) reasons.push("MARX_EVIDENCE_MISSING");
  if (!checks.marx_quote_grounded) reasons.push("MARX_QUOTE_UNGROUNDED");
  if (!checks.non_empty) reasons.push("EMPTY_OR_TOO_SHORT");
  return { passed: reasons.length === 0, checks, reasons, marxMentionCount };
}

export const deterministicQA = runDeterministicQA;
