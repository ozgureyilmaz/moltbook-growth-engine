import { z } from "zod";
import { buildConversationContext } from "../context";
import { analyzeUntrustedText } from "../security";
import { IsoDateSchema, MoltbookPostSchema, ScoreSchema } from "../schemas";
import type { ConversationContext, MoltbookPost, PostContext } from "../orchestrator/contracts";

export const TrendFeedSchema = z.enum(["realtime", "top", "discussed"]);
export type TrendFeed = z.infer<typeof TrendFeedSchema>;

export const TrendDecisionSchema = z.enum(["SHARE_CANDIDATE", "NO_ACTION"]);
export type TrendDecision = z.infer<typeof TrendDecisionSchema>;

export const TrendReasonSchema = z.enum([
  "LOW_FINANCE_RELEVANCE",
  "WEAK_AGENT_BRIDGE",
  "LOW_SPECIFICITY",
  "LOW_TREND_SIGNAL",
  "THREAD_SATURATED",
  "MARX_ALREADY_PRESENT",
  "PROMOTIONAL_OR_HYPE",
  "PROMPT_INJECTION_IN_CONTEXT",
  "CONTEXT_MISSING",
  "SCORE_BELOW_THRESHOLD",
]);
export type TrendReason = z.infer<typeof TrendReasonSchema>;

export const TrendSignalSchema = z.object({
  financeRelevance: ScoreSchema,
  agentBridge: ScoreSchema,
  specificity: ScoreSchema,
  trendSignal: ScoreSchema,
  saturationRisk: ScoreSchema,
  safety: ScoreSchema,
}).strict();

export const TrendDetectionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  feed: TrendFeedSchema,
  decision: TrendDecisionSchema,
  score: ScoreSchema,
  signals: TrendSignalSchema,
  matchedTerms: z.array(z.string().trim().min(1)),
  reasons: z.array(TrendReasonSchema),
  post: MoltbookPostSchema,
  detectedAt: IsoDateSchema,
}).strict();
export type TrendDetection = z.infer<typeof TrendDetectionSchema>;

export const TrendReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["CANDIDATES_READY", "NO_ACTION", "PARTIAL", "ERROR"]),
  feeds: z.array(TrendFeedSchema).min(1),
  timeWindow: z.enum(["day", "week", "month", "all"]),
  discovered: z.number().int().nonnegative(),
  evaluated: z.number().int().nonnegative(),
  candidates: z.array(TrendDetectionSchema),
  noActions: z.array(TrendDetectionSchema),
  errors: z.array(z.object({ feed: TrendFeedSchema, message: z.string().trim().min(1) }).strict()),
  published: z.literal(0),
  outboxWrites: z.literal(0),
  detectedAt: IsoDateSchema,
}).strict();
export type TrendReport = z.infer<typeof TrendReportSchema>;

export type TrendDetectionOptions = {
  feed: TrendFeed;
  minimumScore?: number;
  now?: string;
};

const FINANCE_TERMS = [
  "finance", "market", "markets", "trading", "trade", "portfolio", "liquidity", "yield", "risk", "return",
  "price", "pricing", "rate", "rates", "inflation", "capital", "macro", "defi", "token", "asset", "treasury",
  "pce", "fed", "fomc", "economic", "economy", "volatility", "funding", "credit",
];
const AGENT_TERMS = [
  "agent", "agents", "autonomous", "model", "multi-agent", "orchestration", "decision", "signal", "evidence",
  "research", "provenance", "verification", "memory", "coordination", "evaluation", "tool call", "inference",
];
const SPECIFICITY_TERMS = [
  "because", "evidence", "source", "experiment", "measure", "measured", "observed", "compare", "counter",
  "uncertain", "uncertainty", "assumption", "data", "result", "resulted", "rate", "yield", "inflation", "risk",
];

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function matchedTerms(text: string, vocabulary: string[]): string[] {
  const lower = text.toLowerCase();
  return vocabulary.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "u").test(lower);
  });
}

function contextText(post: MoltbookPost, context?: ConversationContext): string {
  return context?.conversationText ?? post.content;
}

function scoreTrend(post: MoltbookPost, feed: TrendFeed, nowMs: number): number {
  const replies = post.engagement?.replies ?? 0;
  const reactions = post.engagement?.reactions ?? 0;
  const metadata = post.metadata ?? {};
  const rawScore = typeof metadata.score === "number" ? metadata.score : reactions;
  const engagement = clamp(Math.log1p(Math.max(0, replies)) / 8 * 0.55 + Math.log1p(Math.max(0, rawScore)) / 10 * 0.45);
  const createdMs = Date.parse(post.createdAt);
  const recency = Number.isNaN(createdMs) ? 0.25 : clamp(Math.exp(-Math.max(0, nowMs - createdMs) / 86_400_000));
  const feedWeight = feed === "realtime" ? 0.85 : 0.7;
  return clamp(feedWeight * (feed === "realtime" ? recency : Math.max(recency, engagement)) + (1 - feedWeight) * engagement);
}

function safeContext(post: MoltbookPost, context?: ConversationContext): { safety: number; injection: boolean; hype: boolean } {
  const texts = [post.content, ...(context?.replies ?? []).map((reply) => reply.content)];
  const analysis = texts.map((text) => analyzeUntrustedText(text));
  return {
    safety: analysis.some((item) => item.containsPromptInjection) ? 0 : analysis.some((item) => item.isHype) ? 0.45 : 1,
    injection: analysis.some((item) => item.containsPromptInjection),
    hype: analysis.some((item) => item.isHype),
  };
}

/**
 * Detects a potential Marx finance share target. This is intentionally a
 * deterministic read-side classifier; it creates no comment, outbox entry, or
 * platform action. Retrieved post/reply text remains untrusted data.
 */
export function detectTrendPost(
  post: MoltbookPost,
  context: ConversationContext | undefined,
  options: TrendDetectionOptions,
): TrendDetection {
  const detectedAt = options.now ?? new Date().toISOString();
  const text = contextText(post, context);
  // Replies are useful for safety and saturation checks, but cannot create a
  // finance or agent bridge for an otherwise unrelated root post.
  const sourceText = `${post.content} ${post.submolt}`;
  const finance = matchedTerms(sourceText, FINANCE_TERMS);
  const agent = matchedTerms(sourceText, AGENT_TERMS);
  const specificityTerms = matchedTerms(sourceText, SPECIFICITY_TERMS);
  const hasNumber = /\b(?:\d+(?:\.\d+)?%?|\$\d+|\d+\s*bps?)\b/iu.test(sourceText);
  const hasQuestionOrUncertainty = /\?|\b(?:uncertain|uncertainty|why|how|should|whether|downside|risk|counter)\b/iu.test(sourceText);
  const financeRelevance = clamp(Math.min(1, finance.length / 4));
  const agentBridge = clamp(Math.min(1, agent.length / 3));
  const specificity = clamp((Math.min(1, specificityTerms.length / 4) * 0.6) + (hasNumber ? 0.25 : 0) + (hasQuestionOrUncertainty ? 0.15 : 0));
  const trendSignal = scoreTrend(post, options.feed, Date.parse(detectedAt));
  const saturated = Boolean(context?.saturated || (context?.marxMentions ?? 0) > 0);
  const saturationRisk = saturated ? 0.85 : clamp((context?.repeatedAngles.length ?? 0) / 8);
  const safety = safeContext(post, context);
  const score = clamp(
    financeRelevance * 0.3 + agentBridge * 0.23 + specificity * 0.2 + trendSignal * 0.17 + (1 - saturationRisk) * 0.1,
  ) * safety.safety;
  const reasons: TrendReason[] = [];
  if (finance.length < 2) reasons.push("LOW_FINANCE_RELEVANCE");
  if (agent.length < 1) reasons.push("WEAK_AGENT_BRIDGE");
  if (specificity < 0.25) reasons.push("LOW_SPECIFICITY");
  if (trendSignal < 0.2) reasons.push("LOW_TREND_SIGNAL");
  if (saturated) reasons.push("THREAD_SATURATED");
  if (/\bmarx(?:\.finance)?\b/iu.test(text)) reasons.push("MARX_ALREADY_PRESENT");
  if (safety.hype) reasons.push("PROMOTIONAL_OR_HYPE");
  if (safety.injection) reasons.push("PROMPT_INJECTION_IN_CONTEXT");
  if (!context?.conversationText) reasons.push("CONTEXT_MISSING");
  const minimumScore = options.minimumScore ?? 0.58;
  if (score < minimumScore) reasons.push("SCORE_BELOW_THRESHOLD");
  const decision: TrendDecision = reasons.length === 0 ? "SHARE_CANDIDATE" : "NO_ACTION";
  return TrendDetectionSchema.parse({
    schemaVersion: "1.0",
    feed: options.feed,
    decision,
    score,
    signals: { financeRelevance, agentBridge, specificity, trendSignal, saturationRisk, safety: safety.safety },
    matchedTerms: [...new Set([...finance, ...agent, ...specificityTerms])].slice(0, 20),
    reasons,
    post,
    detectedAt,
  });
}

export function contextForTrendPost(postContext: PostContext): ConversationContext {
  return buildConversationContext(postContext);
}

export function buildTrendReport(input: Omit<TrendReport, "schemaVersion">): TrendReport {
  return TrendReportSchema.parse({ schemaVersion: "1.0", ...input });
}
