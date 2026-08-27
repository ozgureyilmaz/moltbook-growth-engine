import type { GeneratedCandidate, Opportunity, StrategyFamily } from "../orchestrator/contracts";
import { extractContextAnchors } from "../context";
import { analyzeUntrustedText } from "../security";

export type GenerationOptions = {
  modelVersion?: string;
  promptVersion?: string;
  candidateCount?: number;
  runId?: string;
  sourcePostId?: string;
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
  const sentences = opportunity.post.content.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const sentence = sentences.find((candidate) => !analyzeUntrustedText(candidate).containsPromptInjection) ?? "the evidence question in this thread";
  return sentence.replace(/\s+/g, " ").slice(0, 150).replace(/[.!?]+$/, "");
}

function specificAnchor(opportunity: Opportunity): string {
  const hook = sourceHook(opportunity);
  const anchors = extractContextAnchors(opportunity.context);
  const anchor = anchors.find((word) => hook.toLowerCase().includes(word.toLowerCase())) ?? anchors[0];
  return anchor ? `the thread's focus on ${anchor}` : "the specific trade-off in this thread";
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
    comment: TEMPLATES[strategyFamily](hook, anchor),
    promptVersion: options.promptVersion ?? "generator-v1",
    modelVersion: options.modelVersion ?? "deterministic-v1",
  }));
}

export function countMarxMentions(comment: string): number {
  return (comment.match(/\bmarx\b/gi) ?? []).length;
}
