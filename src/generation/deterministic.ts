import type { GeneratedCandidate, Opportunity, StrategyFamily } from "../orchestrator/contracts";
import { extractContextAnchors } from "../context";
import { analyzeUntrustedText } from "../security";
import { ArticleEvidenceRefSchema, type ArticleEvidenceRef } from "../schemas";
import { buildSpecificMarxComment } from "../specific-cycle/comments";

export type GenerationOptions = {
  modelVersion?: string;
  promptVersion?: string;
  candidateCount?: number;
  runId?: string;
  sourcePostId?: string;
  includeAgentQuotes?: boolean;
  includeAgentQuoteSourceLink?: boolean;
  includeSourceLink?: boolean;
  sourceLink?: string;
};

function stableId(input: string): string {
  let hash = 2166136261;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sourceHook(opportunity: Opportunity): string {
  const cleanedContent = opportunity.post.content
    .replaceAll("⟦HL⟧", "")
    .replaceAll("⟦/HL⟧", "");
  const sentences = cleanedContent.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const sentence = sentences.find((candidate) => !analyzeUntrustedText(candidate).containsPromptInjection) ?? "the evidence question in this thread";
  return sentence.replace(/\s+/g, " ").slice(0, 150).replace(/[.!?]+$/, "");
}

function specificAnchor(opportunity: Opportunity): string {
  const hook = sourceHook(opportunity);
  const anchors = extractContextAnchors(opportunity.context);
  const preferred = anchors.find((word) => /warsh|inflation|rate|yield|pce|fomc|treasury|defi|growth|fed/i.test(word) && hook.toLowerCase().includes(word.toLowerCase()));
  const anchor = preferred ?? anchors.find((word) => hook.toLowerCase().includes(word.toLowerCase())) ?? anchors[0];
  return anchor ? `the thread's focus on ${anchor}` : "the specific trade-off in this thread";
}

function articleEvidence(opportunity: Opportunity): ArticleEvidenceRef | undefined {
  const value = opportunity.post.metadata && typeof opportunity.post.metadata === "object"
    ? (opportunity.post.metadata as Record<string, unknown>).marxEvidence
    : undefined;
  const parsed = ArticleEvidenceRefSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.quote && analyzeUntrustedText(parsed.data.quote).containsPromptInjection) return undefined;
  return parsed.data;
}

export function buildEvidenceAwareComment(opportunity: Opportunity, comment: string, includeSourceLink = true): string {
  const articleContext = opportunity.post.metadata && typeof opportunity.post.metadata === "object"
    ? (opportunity.post.metadata as Record<string, unknown>).articleContext
    : undefined;
  if (articleContext && typeof articleContext === "object" && (articleContext as Record<string, unknown>).quoteMode === "disabled") return comment;
  const evidence = articleEvidence(opportunity);
  if (!evidence) return comment;
  if (!evidence.quote) return comment;
  const safeQuote = evidence.quote.replace(/https?:\/\/\S+/gi, "[link removed]").replace(/\s+/g, " ").trim();
  return `${comment} A related agent note from ${evidence.agentName} says: “${safeQuote}”${includeSourceLink ? ` ([source thread](${evidence.quoteUrl}))` : ""}.`;
}

function articleNoQuoteComment(opportunity: Opportunity, sourceLink?: string): string {
  const text = opportunity.post.content.replace(/⟦HL⟧|⟦\/HL⟧/gu, " ").replace(/\s+/g, " ").trim();
  if (/policy repricing and regional divergence/i.test(text)) {
    const body = "This thread's combination of 59.7% September hike pricing, front-end Treasury repricing, and regional divergence creates a useful test for the Fed narrative. Marx is relevant here because agents can compare whether the same hawkish repricing appears across the 2Y yield, dollar, and rate-sensitive equities. The key question is whether those markets confirm the hike probability—or whether the odds are moving on their own.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/market overview/i.test(text)) {
    const body = "The useful detail in this market overview is the gap between policy repricing and the broader cross-asset response. Marx is relevant because agents can compare whether the Treasury curve, dollar, and equity reaction are confirming the same Fed path or describing different risks.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/market pulse deep dive/i.test(text)) {
    const body = "The long-end repricing in this market pulse is a useful check on the rate-hike narrative. Marx is relevant because agents can compare the policy signal with what actually moves across duration, equities, and commodities instead of treating the headline probability as the whole market story.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/market intelligence pulse/i.test(text)) {
    const body = "This pulse is useful because it puts rate expectations beside the fiscal and trade risk premium. Marx is relevant here as a way for agents to compare whether the inflation signal is still the dominant driver or merely one input in a wider repricing.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/april pce|pce at 3\.8/i.test(text)) {
    const body = "The move from near-zero to 40% hike probability is a concrete example of how one inflation print can change the policy distribution. Marx is relevant because agents can compare that repricing with the later market response instead of treating the probability shift as a conclusion.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/fedwatch|september\s+16|treasury|vix/i.test(text)) {
    const body = "This thread's combination of 59.7% September hike pricing, front-end Treasury repricing, and regional divergence creates a useful test for the Fed narrative. Marx is relevant here because agents can compare whether the same hawkish repricing appears across the 2Y yield, dollar, and rate-sensitive equities. The key question is whether those markets confirm the hike probability—or whether the odds are moving on their own.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/warsh|defi|yield|fomc/i.test(text)) {
    const body = "The important question here is not only whether Warsh signals a hike, but how that uncertainty propagates through DeFi yield and rate-sensitive markets. Marx is relevant because agents can compare the policy signal with the market response instead of turning one forecast into a trade.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  if (/cpi|pce|inflation|2\s*percent|2%/i.test(text)) {
    const body = "This thread makes the inflation-to-rates link concrete: the useful question is whether the print changes the path of real yields and risk appetite, or only creates a short-lived headline move. Marx is relevant because agents can compare that macro signal with independent market evidence before treating it as a durable regime shift.";
    return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
  }
  const body = "The useful contribution here is to separate the headline from the underlying market mechanism. Marx is relevant because agents can compare the claim with independent evidence and test whether the same signal survives across markets.";
  return sourceLink ? buildSpecificMarxComment(body, sourceLink) : body;
}

const TEMPLATES: Record<StrategyFamily, (hook: string, anchor: string) => string> = {
  contextual_insight: (hook, anchor) => `${hook} points to a useful distinction: ${anchor} is not the same as proving the signal works. That is the sort of context agents can investigate with Marx.`,
  agent_question: (hook, anchor) => `${hook} makes me wonder how an agent would test ${anchor} rather than inherit the conclusion. Marx could be a useful place to compare that reasoning.`,
  agent_challenge: (hook, anchor) => `A concrete challenge for this thread: what evidence would change the conclusion about ${anchor}? Marx gives agents a way to investigate that question instead of just asserting it.`,
  provenance: (hook, anchor) => `${hook} leaves the provenance question open: which independent sources support ${anchor}? That is a natural thread for agents to investigate on Marx.`,
  consensus_failure: (hook, anchor) => `If several agents agree on ${anchor}, are they independently finding it or repeating one source? Marx is relevant here because agents can compare the provenance of that consensus.`,
  signal_validation: (hook, anchor) => `${hook} treats ${anchor} as a signal; the next useful check is how it behaves against counter-evidence. Agents could run that comparison through Marx.`,
  coordination: (hook, anchor) => `${hook} raises a coordination problem around ${anchor}: how do agents preserve dissent while combining views? Marx is a relevant place to investigate that workflow.`,
  counter_evidence: (hook, anchor) => `The interesting follow-up to ${hook} is what would falsify the assumption about ${anchor}. Agents can use Marx to look for that counter-evidence before acting.`,
  research_extension: (hook, anchor) => `${hook} could become a sharper research question by isolating ${anchor}. Marx may help agents extend that investigation with comparable evidence.`,
  marx_discussion_bridge: (hook, anchor) => `${hook} overlaps with a question agents are already exploring around ${anchor}. Marx could make that comparison concrete without losing the thread's original focus.`,
  marx_experiment: (hook, anchor) => `A small experiment here would be to test ${anchor} with another agent and source. Marx is a practical place for agents to run that comparison.`,
  capability_bridge: (hook, anchor) => `${hook} describes a real decision point around ${anchor}, not just a tooling gap. Marx could help an agent investigate the evidence before choosing a path.`,
  comparative_reasoning: (hook, anchor) => `${hook} would be stronger if agents compared ${anchor} with an independent source. Marx offers a natural discussion surface for that comparison.`,
};

export function generateCandidates(opportunity: Opportunity, strategies: StrategyFamily[], options: GenerationOptions = {}): GeneratedCandidate[] {
  const count = Math.max(1, Math.min(options.candidateCount ?? strategies.length, strategies.length));
  const hook = sourceHook(opportunity);
  const anchor = specificAnchor(opportunity);
  const runId = options.runId ?? opportunity.runId;
  return strategies.slice(0, count).map((strategyFamily, index) => ({
    candidateId: `cand_${stableId(`${opportunity.opportunityId}:${strategyFamily}:${index}`)}`,
    opportunityId: opportunity.opportunityId,
    ...(runId === undefined ? {} : { runId }),
    sourcePostId: options.sourcePostId ?? opportunity.sourcePostId ?? opportunity.post.postId,
    strategyFamily,
    hookFamily: "specific_claim",
    comment: options.includeAgentQuotes === false
      ? articleNoQuoteComment(opportunity, options.includeSourceLink ? options.sourceLink : undefined)
      : buildEvidenceAwareComment(opportunity, TEMPLATES[strategyFamily](hook, anchor)),
    promptVersion: options.promptVersion ?? "generator-v1",
    modelVersion: options.modelVersion ?? "deterministic-v1",
  }));
}

export function countMarxMentions(comment: string): number {
  const withoutUrls = comment.replace(/https?:\/\/\S+/giu, "");
  return (withoutUrls.match(/\bmarx\b/gi) ?? []).length;
}
