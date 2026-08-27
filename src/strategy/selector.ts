import { NORTH_STAR_OUTCOME_FIELDS } from "../orchestrator/contracts";
import type { ExperimentOutcome, Opportunity, StrategyFamily, StrategyPrior } from "../orchestrator/contracts";
import { allStrategyFamilies, strategyDefinition } from "./families";

export type SelectionPolicy = {
  explorationRate?: number;
  seed?: string;
};

function hash(input: string): number {
  let value = 2166136261;
  for (const char of input) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 0xffffffff;
}

function posterior(prior: StrategyPrior | undefined): number {
  if (!prior || prior.trials <= 0) return 0.5;
  return (prior.successes + 1) / (prior.trials + 2);
}

function hasNorthStarOutcome(outcome: ExperimentOutcome | undefined): boolean {
  if (!outcome) return false;
  return NORTH_STAR_OUTCOME_FIELDS.some((field) => {
    if (field === "marxInvestigationSignal") {
      return outcome.marxInvestigationSignal ?? outcome.marxDiscussionVisitSignal;
    }
    return outcome[field] === true;
  });
}

/** Deterministic seeded explore/exploit assignment, stable across retries. */
export function selectStrategies(
  opportunity: Opportunity,
  priors: StrategyPrior[] = [],
  policy: SelectionPolicy = {},
): StrategyFamily[] {
  const explorationRate = Math.max(0, Math.min(1, policy.explorationRate ?? 0.25));
  const byFamily = new Map(priors.map((prior) => [prior.strategyFamily, prior]));
  const eligible = opportunity.recommendedStrategies.length > 0 ? opportunity.recommendedStrategies : allStrategyFamilies();
  const scored = eligible.map((family, index) => {
    const random = hash(`${policy.seed ?? "default"}:${opportunity.post.postId}:${family}:${index}`);
    const explore = random < explorationRate;
    const exploitScore = posterior(byFamily.get(family));
    const explorationBonus = explore ? strategyDefinition(family).explorationWeight * 0.25 : 0;
    return { family, score: exploitScore + explorationBonus, random };
  });
  scored.sort((a, b) => b.score - a.score || a.random - b.random || a.family.localeCompare(b.family));
  return scored.slice(0, Math.min(4, scored.length)).map((entry) => entry.family);
}

export function learnStrategyPriors(experiments: Array<{ strategyFamily: StrategyFamily; outcome?: ExperimentOutcome }>): StrategyPrior[] {
  const stats = new Map<StrategyFamily, { trials: number; successes: number }>();
  for (const experiment of experiments) {
    const current = stats.get(experiment.strategyFamily) ?? { trials: 0, successes: 0 };
    current.trials += 1;
    const outcome = experiment.outcome;
    if (hasNorthStarOutcome(outcome)) current.successes += 1;
    stats.set(experiment.strategyFamily, current);
  }
  return [...stats.entries()].map(([strategyFamily, stat]) => ({
    strategyFamily,
    ...stat,
    prior: 0.5,
    posterior: (stat.successes + 1) / (stat.trials + 2),
  })).sort((a, b) => b.posterior - a.posterior || a.strategyFamily.localeCompare(b.strategyFamily));
}
