import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExperimentOutcome, ExperimentRecord, Opportunity, GeneratedCandidate, StrategyFamily, StrategyPrior } from "../orchestrator/contracts";
import { learnStrategyPriors } from "../strategy";
import { actionIdFor, commentHash, experimentIdFor, sha256 } from "../domain/identifiers";

function hash(input: string): string {
  return sha256(input).slice(0, 16);
}

export type Assignment = {
  strategyFamily: StrategyFamily;
  exploration: boolean;
  armKey: string;
};

/** Future publisher/telemetry integrations implement this without changing the loop. */
export interface OutcomeProvider {
  getOutcome(experimentId: string): Promise<ExperimentOutcome | undefined>;
}

export function assignExperiment(
  opportunity: Opportunity,
  strategies: StrategyFamily[],
  priors: StrategyPrior[] = [],
  options: { runId?: string; explorationRate?: number; minimumObservationsBeforeExploitation?: number } = {},
): Assignment {
  if (strategies.length === 0) throw new Error("Cannot assign an experiment without strategy families");
  const explorationRate = Math.max(0, Math.min(1, options.explorationRate ?? 0.25));
  const runId = options.runId ?? opportunity.runId ?? "run";
  const sourcePostId = opportunity.sourcePostId ?? opportunity.post.postId;
  const priorMap = new Map(priors.map((prior) => [prior.strategyFamily, prior]));
  const minimumObservations = Math.max(0, options.minimumObservationsBeforeExploitation ?? 20);
  const scored = strategies.map((strategyFamily, index) => {
    const key = `${runId}:${sourcePostId}:${strategyFamily}:${index}`;
    const random = Number.parseInt(hash(key), 36) / 36 ** 7;
    const prior = priorMap.get(strategyFamily);
    const insufficientEvidence = !prior || prior.trials < minimumObservations;
    const posterior = insufficientEvidence ? 0.5 : prior.posterior;
    const exploration = random < explorationRate || insufficientEvidence;
    return { strategyFamily, exploration, score: posterior + (exploration ? 0.18 : 0), random };
  });
  scored.sort((a, b) => b.score - a.score || a.random - b.random || a.strategyFamily.localeCompare(b.strategyFamily));
  const winner = scored[0]!;
  return {
    strategyFamily: winner.strategyFamily,
    exploration: winner.exploration,
    armKey: `arm_${hash(`${runId}:${sourcePostId}:${opportunity.opportunityId}:${winner.strategyFamily}`)}`,
  };
}

export function makeExperimentRecord(
  runId: string,
  opportunity: Opportunity,
  candidate: GeneratedCandidate,
  evaluation: { overallScore: number; scores: Record<string, number>; modelVersion: string; runId?: string; sourcePostId?: string },
): ExperimentRecord {
  const attributedRunId = runId || evaluation.runId || candidate.runId || opportunity.runId || "run_unknown";
  const sourcePostId = evaluation.sourcePostId ?? candidate.sourcePostId ?? opportunity.sourcePostId ?? opportunity.post.postId;
  const canonicalActionId = actionIdFor(sourcePostId, candidate.comment, candidate.strategyFamily);
  return {
    experimentId: experimentIdFor(canonicalActionId, attributedRunId),
    runId: attributedRunId,
    sourcePlatform: "moltbook",
    sourceSubmolt: opportunity.post.submolt,
    sourcePostId,
    sourceUrl: opportunity.post.url,
    targetAgentId: opportunity.post.author.id,
    targetAgentName: opportunity.post.author.name,
    hookFamily: candidate.hookFamily,
    strategyFamily: candidate.strategyFamily,
    model: candidate.modelVersion,
    modelVersion: evaluation.modelVersion,
    promptVersion: candidate.promptVersion,
    templateVersion: "strategy-v1",
    commentHash: commentHash(candidate.comment),
    semanticCluster: hash(opportunity.post.content.toLowerCase().replace(/\W+/g, " ")),
    opportunityScore: opportunity.finalScore,
    evaluatorScores: evaluation.scores,
    publisherStatus: "pending",
    createdAt: new Date().toISOString(),
  };
}

export type OutcomeSimulationOptions = {
  seed?: string;
  investigationScore?: number;
  interactionScore?: number;
  usageScore?: number;
};

/** Deterministic local outcome simulation for fixtures and development only. */
export function simulateExperimentOutcome(experiment: ExperimentRecord, options: OutcomeSimulationOptions = {}): ExperimentOutcome {
  const seed = sha256(`${options.seed ?? "fixture"}:${experiment.experimentId}`);
  const unit = Number.parseInt(seed.slice(0, 8), 16) / 0xffffffff;
  const investigationScore = options.investigationScore ?? 0.68;
  const interactionScore = options.interactionScore ?? 0.56;
  const usageScore = options.usageScore ?? 0.38;
  const quality = Math.max(0, Math.min(1, experiment.opportunityScore));
  return {
    replyReceived: unit < Math.min(0.95, 0.25 + quality * 0.55),
    replyLatencyMs: Math.round(60_000 + unit * 86_400_000),
    reactionCount: Math.floor(unit * 8),
    targetAgentEngaged: unit < 0.2 + quality * 0.55,
    marxMentionedByTargetAfterward: unit < 0.1 + quality * 0.42,
    marxInvestigationSignal: unit < Math.min(0.9, quality * investigationScore),
    marxInteractionSignal: unit < Math.min(0.85, quality * interactionScore),
    marxUsageSignal: unit < Math.min(0.75, quality * usageScore),
  };
}

export type OutcomeFixture = Record<string, ExperimentOutcome> | Map<string, ExperimentOutcome>;

/** Outcome provider backed by an in-memory fixture map with deterministic simulation fallback. */
export class LocalOutcomeProvider implements OutcomeProvider {
  private readonly outcomes = new Map<string, ExperimentOutcome>();

  public constructor(seed: OutcomeFixture = {}, private readonly simulation: OutcomeSimulationOptions = {}) {
    if (seed instanceof Map) {
      for (const [experimentId, outcome] of seed) this.outcomes.set(experimentId, { ...outcome });
    } else {
      for (const [experimentId, outcome] of Object.entries(seed)) this.outcomes.set(experimentId, { ...outcome });
    }
  }

  public setOutcome(experimentId: string, outcome: ExperimentOutcome): void {
    this.outcomes.set(experimentId, { ...outcome });
  }

  public async getOutcome(experimentId: string): Promise<ExperimentOutcome | undefined> {
    const outcome = this.outcomes.get(experimentId);
    return outcome ? { ...outcome } : undefined;
  }

  public async getOrSimulate(experiment: ExperimentRecord): Promise<ExperimentOutcome> {
    const existing = await this.getOutcome(experiment.experimentId);
    if (existing) return existing;
    const simulated = simulateExperimentOutcome(experiment, this.simulation);
    this.setOutcome(experiment.experimentId, simulated);
    return simulated;
  }
}

export class FixtureOutcomeProvider extends LocalOutcomeProvider {}

export type StrategyStatsDimensions = {
  strategyFamily: string;
  hookFamily: string;
  submolt: string;
  topic: string;
  agentType: string;
  model: string;
  prompt: string;
  opportunityBucket: string;
};

export type StrategyStats = {
  key: string;
  dimensions: StrategyStatsDimensions;
  trials: number;
  successes: number;
  northStarSuccesses: number;
  replies: number;
  engagedAgents: number;
  signalCounts: Record<string, number>;
  lastUpdatedAt: string;
  sampleSize: number;
  posteriorMean: number;
  standardError: number;
};

export type StrategyStatsInput = {
  experiment: ExperimentRecord;
  outcome?: ExperimentOutcome;
  dimensions?: Partial<StrategyStatsDimensions>;
  observedAt?: string;
};

function bucket(score: number): string {
  if (score < 0.25) return "0.00-0.24";
  if (score < 0.5) return "0.25-0.49";
  if (score < 0.75) return "0.50-0.74";
  return "0.75-1.00";
}

function metadataValue(experiment: ExperimentRecord, key: string): string | undefined {
  const metadata = (experiment as ExperimentRecord & { metadata?: Record<string, unknown> }).metadata;
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function strategyStatsDimensions(experiment: ExperimentRecord, override: Partial<StrategyStatsDimensions> = {}): StrategyStatsDimensions {
  return {
    strategyFamily: override.strategyFamily ?? experiment.strategyFamily,
    hookFamily: override.hookFamily ?? experiment.hookFamily,
    submolt: override.submolt ?? experiment.sourceSubmolt,
    topic: override.topic ?? metadataValue(experiment, "topic") ?? "unknown",
    agentType: override.agentType ?? metadataValue(experiment, "agentType") ?? metadataValue(experiment, "targetAgentType") ?? "unknown",
    model: override.model ?? (experiment.modelVersion || experiment.model),
    prompt: override.prompt ?? experiment.promptVersion,
    opportunityBucket: override.opportunityBucket ?? bucket(experiment.opportunityScore),
  };
}

export function strategyStatsKey(dimensions: StrategyStatsDimensions): string {
  return [dimensions.strategyFamily, dimensions.hookFamily, dimensions.submolt, dimensions.topic, dimensions.agentType, dimensions.model, dimensions.prompt, dimensions.opportunityBucket]
    .map((value) => encodeURIComponent(value)).join("|");
}

function northStar(outcome: ExperimentOutcome | undefined): boolean {
  return Boolean(outcome?.marxUsageSignal || outcome?.marxInteractionSignal || outcome?.marxInvestigationSignal || outcome?.marxDiscussionVisitSignal);
}

function signalCounts(outcome: ExperimentOutcome): Record<string, number> {
  return Object.fromEntries(Object.entries(outcome).filter(([, value]) => typeof value === "boolean" && value).map(([key]) => [key, 1]));
}

export function aggregateStrategyStats(inputs: StrategyStatsInput[]): StrategyStats[] {
  const stats = new Map<string, StrategyStats>();
  for (const input of inputs) {
    const dimensions = strategyStatsDimensions(input.experiment, input.dimensions);
    const key = strategyStatsKey(dimensions);
    const current = stats.get(key) ?? {
      key,
      dimensions,
      trials: 0,
      successes: 0,
      northStarSuccesses: 0,
      replies: 0,
      engagedAgents: 0,
      signalCounts: {},
      lastUpdatedAt: input.observedAt ?? new Date().toISOString(),
      sampleSize: 0,
      posteriorMean: 0.5,
      standardError: 0.25,
    };
    const outcome = input.outcome ?? input.experiment.outcome;
    current.trials += 1;
    if (northStar(outcome)) {
      current.successes += 1;
      current.northStarSuccesses += 1;
    }
    if (outcome?.replyReceived) current.replies += 1;
    if (outcome?.targetAgentEngaged) current.engagedAgents += 1;
    for (const [signal, count] of Object.entries(signalCounts(outcome ?? {}))) current.signalCounts[signal] = (current.signalCounts[signal] ?? 0) + count;
    current.lastUpdatedAt = input.observedAt ?? current.lastUpdatedAt;
    current.sampleSize = current.trials;
    current.posteriorMean = (current.northStarSuccesses + 1) / (current.trials + 2);
    current.standardError = Math.sqrt(current.posteriorMean * (1 - current.posteriorMean) / (current.trials + 3));
    stats.set(key, current);
  }
  return [...stats.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export class StrategyStatsStore {
  private stats = new Map<string, StrategyStats>();
  private loaded = false;

  public constructor(private readonly path = "data/strategy-stats.json") {}

  public async load(): Promise<StrategyStats[]> {
    if (this.loaded) return this.list();
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") this.stats.set((entry as StrategyStats).key, entry as StrategyStats);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.list();
  }

  public list(): StrategyStats[] {
    return [...this.stats.values()].map((entry) => ({ ...entry, dimensions: { ...entry.dimensions }, signalCounts: { ...entry.signalCounts } })).sort((left, right) => left.key.localeCompare(right.key));
  }

  public async record(input: StrategyStatsInput): Promise<StrategyStats> {
    await this.load();
    const merged = aggregateStrategyStats([{ experiment: input.experiment, outcome: input.outcome, dimensions: input.dimensions, observedAt: input.observedAt }]);
    const next = merged[0]!;
    const existing = this.stats.get(next.key);
    const combined: StrategyStats = existing ? {
      ...next,
      trials: existing.trials + next.trials,
      successes: existing.successes + next.successes,
      northStarSuccesses: existing.northStarSuccesses + next.northStarSuccesses,
      replies: existing.replies + next.replies,
      engagedAgents: existing.engagedAgents + next.engagedAgents,
      signalCounts: [...new Set([...Object.keys(existing.signalCounts), ...Object.keys(next.signalCounts)])].reduce<Record<string, number>>((result, signal) => {
        result[signal] = (existing.signalCounts[signal] ?? 0) + (next.signalCounts[signal] ?? 0);
        return result;
      }, {}),
      lastUpdatedAt: next.lastUpdatedAt,
      sampleSize: existing.trials + next.trials,
      posteriorMean: (existing.northStarSuccesses + next.northStarSuccesses + 1) / (existing.trials + next.trials + 2),
      standardError: 0,
    } : next;
    combined.standardError = Math.sqrt(combined.posteriorMean * (1 - combined.posteriorMean) / (combined.sampleSize + 3));
    this.stats.set(combined.key, combined);
    await this.flush();
    return { ...combined, dimensions: { ...combined.dimensions }, signalCounts: { ...combined.signalCounts } };
  }

  public async recordExperiments(inputs: StrategyStatsInput[]): Promise<StrategyStats[]> {
    await this.load();
    for (const input of inputs) await this.record(input);
    return this.list();
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.list(), null, 2)}\n`, "utf8");
  }
}

export function updateExperimentOutcome(record: ExperimentRecord, outcome: ExperimentOutcome): ExperimentRecord {
  const normalizedOutcome: ExperimentOutcome = {
    ...outcome,
    ...(outcome.marxInvestigationSignal === undefined && outcome.marxDiscussionVisitSignal !== undefined
      ? { marxInvestigationSignal: outcome.marxDiscussionVisitSignal }
      : {}),
  };
  return { ...record, outcome: { ...record.outcome, ...normalizedOutcome } };
}

export function strategyPriors(experiments: ExperimentRecord[]): StrategyPrior[] {
  return learnStrategyPriors(experiments);
}

export class ExperimentEngine {
  private records: ExperimentRecord[] = [];

  public constructor(initial: ExperimentRecord[] = []) {
    this.records = [...initial];
  }

  public record(experiment: ExperimentRecord): ExperimentRecord {
    const existing = this.records.find((candidate) => candidate.experimentId === experiment.experimentId);
    if (existing) return existing;
    this.records.push(experiment);
    return experiment;
  }

  public update(experimentId: string, outcome: ExperimentOutcome): ExperimentRecord | undefined {
    const index = this.records.findIndex((record) => record.experimentId === experimentId);
    if (index < 0) return undefined;
    this.records[index] = updateExperimentOutcome(this.records[index]!, outcome);
    return this.records[index];
  }

  public all(): ExperimentRecord[] {
    return this.records.map((record) => ({ ...record, outcome: record.outcome ? { ...record.outcome } : undefined }));
  }

  public priors(): StrategyPrior[] {
    return strategyPriors(this.records);
  }
}
