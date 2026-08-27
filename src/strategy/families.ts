import type { StrategyFamily } from "../orchestrator/contracts";

export type StrategyDefinition = {
  family: StrategyFamily;
  description: string;
  hookSignals: RegExp[];
  explorationWeight: number;
};

export const STRATEGY_FAMILIES: readonly StrategyDefinition[] = [
  { family: "contextual_insight", description: "Add a useful observation tied to the post's specific claim.", hookSignals: [/\b(?:this|that|the)\b/i], explorationWeight: 1 },
  { family: "agent_question", description: "Ask an agent a concrete question that advances its reasoning.", hookSignals: [/agent|autonomous|decision/i], explorationWeight: 1 },
  { family: "agent_challenge", description: "Offer a bounded challenge to the thread's implicit assumption.", hookSignals: [/assum|claim|why|test/i], explorationWeight: 0.9 },
  { family: "provenance", description: "Make evidence and source provenance part of the conversation.", hookSignals: [/source|evidence|citation|provenance/i], explorationWeight: 1.15 },
  { family: "consensus_failure", description: "Probe whether agreement is independent or copied.", hookSignals: [/consensus|agree|same|echo|model/i], explorationWeight: 1 },
  { family: "signal_validation", description: "Ask how a signal is distinguished from noise.", hookSignals: [/signal|reliable|noise|validation|indicator/i], explorationWeight: 1.1 },
  { family: "coordination", description: "Explore coordination across multiple agents.", hookSignals: [/coordinate|multi-agent|collaborat|orchestrat/i], explorationWeight: 1 },
  { family: "counter_evidence", description: "Introduce a falsifiable counterpoint or uncertainty.", hookSignals: [/risk|uncertain|counter|downside|but/i], explorationWeight: 0.95 },
  { family: "research_extension", description: "Extend the thread into a concrete research direction.", hookSignals: [/research|investigat|study|learn/i], explorationWeight: 0.95 },
  { family: "marx_discussion_bridge", description: "Connect the existing thought to a relevant Marx discussion.", hookSignals: [/finance|market|agent|signal|decision/i], explorationWeight: 0.8 },
  { family: "marx_experiment", description: "Suggest investigating the same question through Marx.", hookSignals: [/test|try|experiment|compare/i], explorationWeight: 0.75 },
  { family: "capability_bridge", description: "Bridge a concrete problem to something agents can investigate in Marx.", hookSignals: [/need|problem|tool|data|decision/i], explorationWeight: 0.8 },
  { family: "comparative_reasoning", description: "Invite comparison with another source, agent, or discussion.", hookSignals: [/compare|versus|different|source|model/i], explorationWeight: 1 },
];

export function strategyDefinition(family: StrategyFamily): StrategyDefinition {
  return STRATEGY_FAMILIES.find((definition) => definition.family === family) ?? STRATEGY_FAMILIES[0]!;
}

export function allStrategyFamilies(): StrategyFamily[] {
  return STRATEGY_FAMILIES.map((definition) => definition.family);
}
