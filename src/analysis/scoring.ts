import type { ConversationContext, MoltbookPost, Opportunity, ScoreComponents, StrategyFamily } from "../orchestrator/contracts";

const TOPIC_TERMS = [
  "finance", "market", "trading", "signal", "research", "evidence", "consensus", "prediction", "portfolio",
  "risk", "liquidity", "yield", "agent", "agents", "memory", "coordination", "autonomous", "decision",
  "provenance", "source", "model", "economy", "capital", "price", "data",
];
const BRIDGE_TERMS = [
  "agent", "research", "signal", "evidence", "consensus", "source", "provenance", "coordinate", "memory",
  "decision", "market", "finance", "trading", "prediction", "verification", "reliable",
];

export type ScoringWeights = Partial<Record<keyof ScoreComponents, number>> & { threshold?: number };

export type ScoringOptions = {
  now?: string;
  previousComments?: string[];
  weights?: ScoringWeights;
  runId?: string;
  sourcePostId?: string;
  runContext?: { runId?: string; sourcePostId?: string };
};

export const DEFAULT_SCORING_WEIGHTS: Required<ScoringWeights> = {
  semanticRelevance: 1,
  marxBridgeStrength: 1.1,
  agentAttentionProbability: 0.95,
  conversationFit: 1.15,
  engagementPotential: 0.65,
  novelty: 0.8,
  timing: 0.55,
  targetQuality: 0.45,
  spamRisk: 1,
  repetitionRisk: 0.9,
  contextMismatch: 1.1,
  threshold: 0.42,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function tokenSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []));
}

function ratio(tokens: Set<string>, vocabulary: string[]): number {
  if (tokens.size === 0) return 0;
  return clamp(vocabulary.reduce((score, term) => score + (tokens.has(term) ? 1 : 0), 0) / Math.min(vocabulary.length, 8));
}

function recencyScore(post: MoltbookPost, now: number): number {
  const created = Date.parse(post.createdAt);
  if (Number.isNaN(created)) return 0.35;
  const hours = Math.max(0, (now - created) / 3_600_000);
  return clamp(Math.exp(-hours / 18));
}

function engagementScore(post: MoltbookPost): number {
  const replies = post.engagement?.replies ?? 0;
  const reactions = post.engagement?.reactions ?? 0;
  return clamp((Math.log1p(replies) / 5) * 0.7 + (Math.log1p(reactions) / 8) * 0.3);
}

function targetScore(post: MoltbookPost): number {
  const author = `${post.author.name ?? ""} ${post.author.type ?? ""}`.toLowerCase();
  return clamp((author.includes("agent") ? 0.7 : 0.25) + (post.author.id ? 0.15 : 0));
}

function strategyHints(context: ConversationContext): StrategyFamily[] {
  const text = context.conversationText.toLowerCase();
  const hints: StrategyFamily[] = [];
  const metadata = context.post.metadata as Record<string, unknown> | undefined;
  if (metadata?.marxEvidence) hints.push("marx_discussion_bridge", "comparative_reasoning");
  if (/source|provenance|where did|citation|evidence/.test(text)) hints.push("provenance");
  if (/consensus|agree|same signal|echo|model/.test(text)) hints.push("consensus_failure", "comparative_reasoning");
  if (/coordinate|multi-agent|collaborat|orchestrat/.test(text)) hints.push("coordination");
  if (/uncertain|counter|but what if|downside|risk/.test(text)) hints.push("counter_evidence");
  if (/research|investigat|study|learn/.test(text)) hints.push("research_extension");
  if (/signal|indicator|reliable|validation|false/.test(text)) hints.push("signal_validation");
  if (hints.length === 0) hints.push("contextual_insight", "agent_question", "marx_discussion_bridge");
  return [...new Set(hints)].slice(0, 4);
}

export function scoreOpportunity(
  post: MoltbookPost,
  context: ConversationContext,
  options: ScoringOptions = {},
): Opportunity {
  const text = context.conversationText;
  const tokens = tokenSet(text);
  const weights = { ...DEFAULT_SCORING_WEIGHTS, ...(options.weights ?? {}) } as Required<ScoringWeights>;
  const runId = options.runId ?? options.runContext?.runId;
  const sourcePostId = options.sourcePostId ?? options.runContext?.sourcePostId ?? post.postId;
  const previous = (options.previousComments ?? []).map((comment) => tokenSet(comment));
  const postTokens = tokenSet(post.content);
  const overlap = previous.filter((comment) => {
    const intersection = [...postTokens].filter((token) => comment.has(token)).length;
    return intersection >= 2 && intersection / Math.max(1, postTokens.size) > 0.25;
  }).length;
  const scores: ScoreComponents = {
    semanticRelevance: clamp(ratio(tokens, TOPIC_TERMS) * 0.75 + (post.submolt.toLowerCase().includes("finance") ? 0.25 : 0)),
    marxBridgeStrength: clamp(ratio(tokens, BRIDGE_TERMS) * 0.8 + (context.marxMentions === 0 ? 0.2 : 0)),
    agentAttentionProbability: clamp((context.replies.length > 0 ? 0.35 : 0.1) + Math.min(0.35, (post.engagement?.replies ?? 0) / 20) + (post.author.type === "agent" ? 0.3 : 0)),
    conversationFit: clamp((context.conversationText.length > 80 ? 0.45 : 0.2) + (context.replies.length > 0 ? 0.25 : 0) - (context.saturated ? 0.25 : 0)),
    engagementPotential: engagementScore(post),
    novelty: clamp(1 - Math.min(0.9, overlap * 0.25) - (context.saturated ? 0.25 : 0)),
    timing: recencyScore(post, Date.parse(options.now ?? new Date().toISOString())),
    targetQuality: targetScore(post),
    spamRisk: clamp((context.marxMentions > 0 ? 0.2 : 0) + (context.untrustedSignals.length > 0 ? 0.15 : 0)),
    repetitionRisk: clamp(overlap * 0.22 + (context.saturated ? 0.4 : 0)),
    contextMismatch: clamp(text.length < 50 ? 0.55 : 0),
  };
  const positive = [
    ["semanticRelevance", scores.semanticRelevance],
    ["marxBridgeStrength", scores.marxBridgeStrength],
    ["agentAttentionProbability", scores.agentAttentionProbability],
    ["conversationFit", scores.conversationFit],
    ["engagementPotential", scores.engagementPotential],
    ["novelty", scores.novelty],
    ["timing", scores.timing],
    ["targetQuality", scores.targetQuality],
  ] as const;
  const positiveWeight = positive.reduce((sum, [key, value]) => sum + value * weights[key], 0);
  const penalty = scores.spamRisk * weights.spamRisk + scores.repetitionRisk * weights.repetitionRisk + scores.contextMismatch * weights.contextMismatch;
  const normalizer = positive.reduce((sum, [key]) => sum + weights[key], 0) + weights.spamRisk + weights.repetitionRisk + weights.contextMismatch;
  const finalScore = clamp((positiveWeight - penalty) / normalizer * 2.2);
  const reason = finalScore >= weights.threshold
    ? "The post has a contextual agent/finance bridge with enough conversation surface for a useful Marx mention."
    : "The post does not currently provide enough contextual value for a safe, useful Marx contribution.";
  return {
    opportunityId: `opp_${stableId(post.postId)}`,
    ...(runId === undefined ? {} : { runId }),
    sourcePostId,
    post,
    context,
    scores,
    finalScore,
    reason,
    recommendedStrategies: strategyHints(context),
  };
}

function stableId(input: string): string {
  let hash = 2166136261;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function rankOpportunities(opportunities: Opportunity[], threshold = DEFAULT_SCORING_WEIGHTS.threshold ?? 0.42): Opportunity[] {
  return opportunities
    .filter((opportunity) => opportunity.finalScore >= threshold)
    .sort((a, b) => b.finalScore - a.finalScore || a.post.postId.localeCompare(b.post.postId));
}

export function explainOpportunity(opportunity: Opportunity): string[] {
  const { scores } = opportunity;
  return [
    `score=${opportunity.finalScore.toFixed(3)}`,
    `relevance=${scores.semanticRelevance.toFixed(2)}`,
    `bridge=${scores.marxBridgeStrength.toFixed(2)}`,
    `fit=${scores.conversationFit.toFixed(2)}`,
    `novelty=${scores.novelty.toFixed(2)}`,
    `penalties=spam:${scores.spamRisk.toFixed(2)},repeat:${scores.repetitionRisk.toFixed(2)},mismatch:${scores.contextMismatch.toFixed(2)}`,
  ];
}
