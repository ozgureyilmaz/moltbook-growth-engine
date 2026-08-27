import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export type RuntimeConfig = {
  config_version?: string;
  environment?: string;
  execution?: {
    mode?: string;
    discovery_candidates_per_run?: number;
    target_actions_per_run?: number;
    max_generated_candidates_per_opportunity?: number;
    dry_run_by_default?: boolean;
  };
  model?: {
    provider?: string;
    model_name?: string | null;
    prompt_root?: string;
    request_timeout_ms?: number;
    max_retries?: number;
    retry_backoff_ms?: number;
    max_concurrency?: number;
  };
  storage?: { database_path?: string; strategy_stats_path?: string };
  publishing?: {
    enabled?: boolean;
    mode?: string;
    platform?: string;
    outbox?: { pending_path?: string; acknowledged_path?: string; failed_path?: string };
  };
  safety?: { allowed_domains?: string[]; allowed_redirect_domains?: string[] };
  strategy_selection?: { exploration_rate?: number };
  thresholds?: RuntimeThresholds;
  observability?: {
    structured_logs?: boolean;
    log_level?: string;
    run_log_directory?: string;
    error_log_directory?: string;
  };
};

export type RuntimeThresholds = {
  minimum_opportunity_score?: number;
  minimum_evaluation_score?: number;
  minimum_confidence?: number;
  maximum_spam_risk?: number;
  maximum_repetition_risk?: number;
  maximum_marx_mentions?: number;
};

export type SubmoltsConfig = {
  config_version?: string;
  submolts?: { include?: string[]; exclude?: string[] };
  lookback?: { hours?: number };
  candidate_limit?: { per_run?: number };
  sources?: Array<{ id?: string; adapter?: string; enabled?: boolean; access_method?: string; max_pages?: number }>;
  filtering?: {
    deduplicate_by?: string;
    require_public_context?: boolean;
    reject_missing_content?: boolean;
    max_content_chars?: number;
    max_context_replies?: number;
  };
};

export type ExperimentsConfig = {
  config_version?: string;
  candidate_generation?: { count?: number; vary_by_strategy?: boolean; reject_superficial_wording_variants?: boolean };
  strategy_selection?: {
    exploration_rate?: number;
    exploitation_rate?: number;
    minimum_observations_before_exploitation?: number;
    deterministic_assignment?: boolean;
    random_seed?: string | number | null;
  };
  strategy_families?: string[];
  tracking?: { strategy_stats_path?: string; dimensions?: string[]; outcome_signals?: string[] };
  learning?: { optimize_for?: string[]; retain_exploration?: boolean };
};

export type RuntimeSettings = { system: RuntimeConfig; submolts: SubmoltsConfig; experiments: ExperimentsConfig };

export type ResolvedRuntimeThresholds = {
  minimumOpportunityScore: number;
  minimumEvaluationScore: number;
  minimumConfidence: number;
  maximumSpamRisk: number;
  maximumRepetitionRisk: number;
  maximumMarxMentions: number;
};

export type ResolvedRuntimeSettings = RuntimeSettings & {
  includeSubmolts: string[];
  excludeSubmolts: string[];
  lookbackHours: number;
  candidateLimit: number;
  targetActions: number;
  maxGeneratedCandidatesPerOpportunity: number;
  retryLimit: number;
  retryBackoffMs: number;
  modelConcurrency: number;
  explorationRate: number;
  minimumObservationsBeforeExploitation: number;
  thresholds: ResolvedRuntimeThresholds;
  allowedDomains: string[];
  publishingEnabled: boolean;
};

export const DEFAULT_RUNTIME_THRESHOLDS: ResolvedRuntimeThresholds = {
  minimumOpportunityScore: 0.6,
  minimumEvaluationScore: 0.72,
  minimumConfidence: 0.7,
  maximumSpamRisk: 0.2,
  maximumRepetitionRisk: 0.25,
  maximumMarxMentions: 2,
};

const DEFAULT_SUBMOLTS = { includeSubmolts: [] as string[], excludeSubmolts: [] as string[], lookbackHours: 24, candidateLimit: 100 };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(name: string, value: unknown, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} must be a positive integer`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function fraction(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a finite number between 0 and 1`);
  return value;
}

function stringList(name: string, value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((entry) => entry.trim()))];
}

function validateConfig(value: unknown): RuntimeConfig {
  const config = object(value);
  if (!config) throw new Error("system config must contain a YAML object");
  const execution = object(config.execution);
  const model = object(config.model);
  const publishing = object(config.publishing);
  const safety = object(config.safety);
  const observability = object(config.observability);
  const thresholds = object(config.thresholds);
  positiveInteger("config.execution.discovery_candidates_per_run", execution?.discovery_candidates_per_run, 100);
  positiveInteger("config.execution.target_actions_per_run", execution?.target_actions_per_run, 5);
  positiveInteger("config.execution.max_generated_candidates_per_opportunity", execution?.max_generated_candidates_per_opportunity, 4);
  if (execution?.dry_run_by_default !== undefined && typeof execution.dry_run_by_default !== "boolean") throw new Error("config.execution.dry_run_by_default must be boolean");
  positiveInteger("config.model.request_timeout_ms", model?.request_timeout_ms, 90_000);
  nonNegativeInteger("config.model.max_retries", model?.max_retries, 2);
  nonNegativeInteger("config.model.retry_backoff_ms", model?.retry_backoff_ms, 1_000);
  positiveInteger("config.model.max_concurrency", model?.max_concurrency, 3);
  if (publishing?.enabled !== undefined && typeof publishing.enabled !== "boolean") throw new Error("config.publishing.enabled must be boolean");
  stringList("config.safety.allowed_domains", safety?.allowed_domains);
  stringList("config.safety.allowed_redirect_domains", safety?.allowed_redirect_domains);
  fraction("config.thresholds.minimum_opportunity_score", thresholds?.minimum_opportunity_score, DEFAULT_RUNTIME_THRESHOLDS.minimumOpportunityScore);
  fraction("config.thresholds.minimum_evaluation_score", thresholds?.minimum_evaluation_score, DEFAULT_RUNTIME_THRESHOLDS.minimumEvaluationScore);
  fraction("config.thresholds.minimum_confidence", thresholds?.minimum_confidence, DEFAULT_RUNTIME_THRESHOLDS.minimumConfidence);
  fraction("config.thresholds.maximum_spam_risk", thresholds?.maximum_spam_risk, DEFAULT_RUNTIME_THRESHOLDS.maximumSpamRisk);
  fraction("config.thresholds.maximum_repetition_risk", thresholds?.maximum_repetition_risk, DEFAULT_RUNTIME_THRESHOLDS.maximumRepetitionRisk);
  if (thresholds?.maximum_marx_mentions !== undefined) positiveInteger("config.thresholds.maximum_marx_mentions", thresholds.maximum_marx_mentions);
  if (observability?.log_level !== undefined && !["debug", "info", "warn", "error"].includes(String(observability.log_level))) throw new Error("config.observability.log_level must be debug, info, warn, or error");
  return config as RuntimeConfig;
}

function validateSubmoltsConfig(value: unknown): SubmoltsConfig {
  const config = object(value);
  if (!config) throw new Error("submolts config must contain a YAML object");
  const submolts = object(config.submolts);
  const lookback = object(config.lookback);
  const limits = object(config.candidate_limit);
  const include = stringList("config.submolts.include", submolts?.include);
  const exclude = stringList("config.submolts.exclude", submolts?.exclude);
  positiveInteger("config.lookback.hours", lookback?.hours, 24);
  positiveInteger("config.candidate_limit.per_run", limits?.per_run, 100);
  if (include.some((entry) => exclude.includes(entry))) throw new Error("config.submolts.include and exclude cannot overlap");
  return config as SubmoltsConfig;
}

function validateExperimentsConfig(value: unknown): ExperimentsConfig {
  const config = object(value);
  if (!config) throw new Error("experiments config must contain a YAML object");
  const generation = object(config.candidate_generation);
  const selection = object(config.strategy_selection);
  positiveInteger("config.candidate_generation.count", generation?.count, 4);
  fraction("config.strategy_selection.exploration_rate", selection?.exploration_rate, 0.25);
  fraction("config.strategy_selection.exploitation_rate", selection?.exploitation_rate, 0.75);
  nonNegativeInteger("config.strategy_selection.minimum_observations_before_exploitation", selection?.minimum_observations_before_exploitation, 20);
  stringList("config.strategy_families", config.strategy_families);
  return config as ExperimentsConfig;
}

async function loadYaml<T>(path: string, label: string, validator: (value: unknown) => T): Promise<T> {
  try {
    return validator(parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return validator({});
    throw new Error(`Unable to load ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveRuntimeThresholds(thresholds?: RuntimeThresholds): ResolvedRuntimeThresholds {
  return {
    minimumOpportunityScore: fraction("minimum_opportunity_score", thresholds?.minimum_opportunity_score, DEFAULT_RUNTIME_THRESHOLDS.minimumOpportunityScore),
    minimumEvaluationScore: fraction("minimum_evaluation_score", thresholds?.minimum_evaluation_score, DEFAULT_RUNTIME_THRESHOLDS.minimumEvaluationScore),
    minimumConfidence: fraction("minimum_confidence", thresholds?.minimum_confidence, DEFAULT_RUNTIME_THRESHOLDS.minimumConfidence),
    maximumSpamRisk: fraction("maximum_spam_risk", thresholds?.maximum_spam_risk, DEFAULT_RUNTIME_THRESHOLDS.maximumSpamRisk),
    maximumRepetitionRisk: fraction("maximum_repetition_risk", thresholds?.maximum_repetition_risk, DEFAULT_RUNTIME_THRESHOLDS.maximumRepetitionRisk),
    maximumMarxMentions: thresholds?.maximum_marx_mentions ?? DEFAULT_RUNTIME_THRESHOLDS.maximumMarxMentions,
  };
}

export async function loadSystemConfig(path = "config/system.yaml"): Promise<RuntimeConfig> {
  return loadYaml(path, "system config", validateConfig);
}

export async function loadSubmoltsConfig(path = "config/submolts.yaml"): Promise<SubmoltsConfig> {
  return loadYaml(path, "submolts config", validateSubmoltsConfig);
}

export async function loadExperimentsConfig(path = "config/experiments.yaml"): Promise<ExperimentsConfig> {
  return loadYaml(path, "experiments config", validateExperimentsConfig);
}

export async function loadRuntimeSettings(configDirectory = "config"): Promise<RuntimeSettings> {
  const [system, submolts, experiments] = await Promise.all([
    loadSystemConfig(`${configDirectory}/system.yaml`),
    loadSubmoltsConfig(`${configDirectory}/submolts.yaml`),
    loadExperimentsConfig(`${configDirectory}/experiments.yaml`),
  ]);
  return { system, submolts, experiments };
}

export function resolveRuntimeSettings(settings: RuntimeSettings): ResolvedRuntimeSettings {
  const execution = settings.system.execution;
  const model = settings.system.model;
  const includeSubmolts = settings.submolts.submolts?.include ?? DEFAULT_SUBMOLTS.includeSubmolts;
  const excludeSubmolts = settings.submolts.submolts?.exclude ?? DEFAULT_SUBMOLTS.excludeSubmolts;
  return {
    ...settings,
    includeSubmolts: [...includeSubmolts],
    excludeSubmolts: [...excludeSubmolts],
    lookbackHours: settings.submolts.lookback?.hours ?? DEFAULT_SUBMOLTS.lookbackHours,
    candidateLimit: settings.submolts.candidate_limit?.per_run ?? execution?.discovery_candidates_per_run ?? DEFAULT_SUBMOLTS.candidateLimit,
    targetActions: execution?.target_actions_per_run ?? 5,
    maxGeneratedCandidatesPerOpportunity: settings.experiments.candidate_generation?.count ?? execution?.max_generated_candidates_per_opportunity ?? 4,
    retryLimit: model?.max_retries ?? 2,
    retryBackoffMs: model?.retry_backoff_ms ?? 1_000,
    modelConcurrency: model?.max_concurrency ?? 3,
    explorationRate: settings.experiments.strategy_selection?.exploration_rate ?? 0.25,
    minimumObservationsBeforeExploitation: settings.experiments.strategy_selection?.minimum_observations_before_exploitation ?? 20,
    thresholds: resolveRuntimeThresholds(settings.system.thresholds),
    allowedDomains: [...new Set([...(settings.system.safety?.allowed_domains ?? []), ...(settings.system.safety?.allowed_redirect_domains ?? [])])],
    publishingEnabled: settings.system.publishing?.enabled === true,
  };
}

export type EffectiveRunConfig = ResolvedRuntimeSettings;
