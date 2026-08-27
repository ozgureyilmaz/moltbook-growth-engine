import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type StructuredLog = {
  timestamp: string;
  level: LogLevel;
  event: string;
  runId?: string;
  [key: string]: unknown;
};

export const GROWTH_EVENT_SCHEMA_VERSION = "1.0" as const;
export const GROWTH_EVENT_VERSION = "1.0" as const;

export type GrowthEventName = "action_created" | "action_published" | "outcome_observed";

export type GrowthEvent = {
  schemaVersion: typeof GROWTH_EVENT_SCHEMA_VERSION;
  eventVersion: typeof GROWTH_EVENT_VERSION;
  event: GrowthEventName;
  eventId: string;
  occurredAt: string;
  runId: string;
  actionId: string;
  experimentId: string;
  properties?: Record<string, unknown>;
};

export type GrowthEventInput = {
  event: GrowthEventName;
  runId: string;
  actionId: string;
  experimentId: string;
  occurredAt?: string;
  properties?: Record<string, unknown>;
};

export type ConfiguredLoggerOptions = {
  structured?: boolean;
  level?: LogLevel;
  runDirectory?: string;
  errorDirectory?: string;
  console?: boolean;
};

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  entries(): StructuredLog[];
}

export class JsonLogger implements StructuredLogger {
  private readonly buffer: StructuredLog[] = [];

  public constructor(private readonly runId?: string, private readonly sink: (line: string) => void = (line) => console.log(line)) {}

  public log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const entry: StructuredLog = { timestamp: new Date().toISOString(), level, event, ...(this.runId ? { runId: this.runId } : {}), ...fields };
    this.buffer.push(entry);
    this.sink(JSON.stringify(entry));
  }

  public info(event: string, fields?: Record<string, unknown>): void { this.log("info", event, fields); }
  public warn(event: string, fields?: Record<string, unknown>): void { this.log("warn", event, fields); }
  public error(event: string, fields?: Record<string, unknown>): void { this.log("error", event, fields); }
  public entries(): StructuredLog[] { return this.buffer.map((entry) => ({ ...entry })); }
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Creates a local JSON logger. It has no network or publishing side effects. */
export function createConfiguredLogger(runId: string, options: ConfiguredLoggerOptions = {}): JsonLogger {
  if (options.structured === false) return silentLogger(runId);
  const level = options.level ?? "info";
  const runDirectory = options.runDirectory ?? "logs/runs";
  const errorDirectory = options.errorDirectory ?? "logs/errors";
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(errorDirectory, { recursive: true });
  const runPath = join(runDirectory, `${runId}.jsonl`);
  const errorPath = join(errorDirectory, `${runId}.jsonl`);
  return new JsonLogger(runId, (line) => {
    let parsed: { level?: LogLevel } = {};
    try { parsed = JSON.parse(line) as { level?: LogLevel }; } catch { /* the logger emits JSON */ }
    if (parsed.level && LOG_LEVEL_RANK[parsed.level] < LOG_LEVEL_RANK[level]) return;
    appendFileSync(runPath, `${line}\n`, "utf8");
    if (parsed.level === "error") appendFileSync(errorPath, `${line}\n`, "utf8");
    if (options.console) console.log(line);
  });
}

export type DryRunRecord = {
  schemaVersion: "1.0";
  runId: string;
  dryRun: boolean;
  discoveredPosts: Array<{ postId: string; submolt: string; url: string }>;
  deduplicatedPosts: string[];
  opportunityScores: Array<{ postId: string; opportunityId: string; score: number; components: Record<string, number>; strategies: string[] }>;
  generatedComments: Array<{ candidateId: string; actionId?: string; postId: string; comment: string; strategyFamily: string; hookFamily: string }>;
  evaluatorScores: Array<{ candidateId: string; experimentId?: string; scores?: Record<string, number>; opportunityScore?: number }>;
  qaRejectionReasons: string[];
  finalDecisions: Array<{ action: string; actionId: string; postId?: string; reason?: string }>;
};

export function buildDryRunRecord(result: {
  summary: { runId: string; dryRun: boolean };
  discoveredPosts?: Array<{ postId: string; submolt: string; url: string }>;
  opportunities: Array<{ post: { postId: string; submolt: string; url: string }; opportunityId: string; finalScore: number; scores: Record<string, number>; recommendedStrategies: string[] }>;
  generatedCandidates?: Array<{ candidateId: string; opportunityId: string; comment: string; strategyFamily: string; hookFamily: string }>;
  evaluations?: Array<{ candidateId: string; overallScore: number; scores: Record<string, number> }>;
  actions: Array<{ actionId: string; target: { postId: string }; content: { comment: string; strategyFamily: string; hookFamily: string }; experiment?: { experimentId: string } }>;
  noActions: Array<{ actionId: string; action: string; target?: { postId: string }; reason: string }>;
  experiments: Array<{ experimentId: string; opportunityScore: number; evaluatorScores?: Record<string, number> }>;
  logs?: Array<Record<string, unknown>>;
}): DryRunRecord {
  const rejectionReasons = (result.logs ?? [])
    .filter((entry) => entry.event === "candidate_rejected")
    .flatMap((entry) => Array.isArray(entry.reasons) ? entry.reasons.map(String) : [])
    .filter((reason, index, reasons) => reasons.indexOf(reason) === index);
  return {
    schemaVersion: "1.0",
    runId: result.summary.runId,
    dryRun: result.summary.dryRun,
    discoveredPosts: result.discoveredPosts ?? result.opportunities.map((opportunity) => ({ postId: opportunity.post.postId, submolt: opportunity.post.submolt, url: opportunity.post.url })),
    deduplicatedPosts: result.opportunities.map((opportunity) => opportunity.post.postId),
    opportunityScores: result.opportunities.map((opportunity) => ({ postId: opportunity.post.postId, opportunityId: opportunity.opportunityId, score: opportunity.finalScore, components: { ...opportunity.scores }, strategies: [...opportunity.recommendedStrategies] })),
    generatedComments: (result.generatedCandidates ?? []).map((candidate) => {
      const action = result.actions.find((entry) => entry.content.comment === candidate.comment);
      return { candidateId: candidate.candidateId, ...(action ? { actionId: action.actionId } : {}), postId: result.opportunities.find((opportunity) => opportunity.opportunityId === candidate.opportunityId)?.post.postId ?? "", comment: candidate.comment, strategyFamily: candidate.strategyFamily, hookFamily: candidate.hookFamily };
    }),
    evaluatorScores: (result.evaluations ?? []).map((evaluation) => {
      const candidate = result.generatedCandidates?.find((entry) => entry.candidateId === evaluation.candidateId);
      const action = result.actions.find((entry) => candidate && entry.content.comment === candidate.comment);
      return {
        candidateId: evaluation.candidateId,
        ...(action?.experiment ? { experimentId: action.experiment.experimentId } : {}),
        scores: { ...evaluation.scores },
        opportunityScore: result.opportunities.find((opportunity) => candidate?.opportunityId === opportunity.opportunityId)?.finalScore,
      };
    }),
    qaRejectionReasons: rejectionReasons,
    finalDecisions: [
      ...result.actions.map((action) => ({ action: "COMMENT", actionId: action.actionId, postId: action.target.postId })),
      ...result.noActions.map((action) => ({ action: action.action, actionId: action.actionId, ...(action.target?.postId ? { postId: action.target.postId } : {}), reason: action.reason })),
    ],
  };
}

export async function writeDryRunRecord(record: DryRunRecord, directory = "logs/runs"): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.runId}.dry-run.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export function silentLogger(runId?: string): JsonLogger {
  return new JsonLogger(runId, () => undefined);
}

function eventId(input: GrowthEventInput): string {
  let value = 2166136261;
  const source = `${input.event}:${input.runId}:${input.actionId}:${input.experimentId}`;
  for (const character of source) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return `growth_${(value >>> 0).toString(36)}`;
}

export function createGrowthEvent(input: GrowthEventInput): GrowthEvent {
  if (!input.runId || !input.actionId || !input.experimentId) {
    throw new Error("growth events require runId, actionId, and experimentId");
  }
  return {
    schemaVersion: GROWTH_EVENT_SCHEMA_VERSION,
    eventVersion: GROWTH_EVENT_VERSION,
    event: input.event,
    eventId: eventId(input),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    runId: input.runId,
    actionId: input.actionId,
    experimentId: input.experimentId,
    ...(input.properties ? { properties: { ...input.properties } } : {}),
  };
}

export function validateGrowthEvent(value: unknown): value is GrowthEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<GrowthEvent>;
  return event.schemaVersion === GROWTH_EVENT_SCHEMA_VERSION &&
    event.eventVersion === GROWTH_EVENT_VERSION &&
    (event.event === "action_created" || event.event === "action_published" || event.event === "outcome_observed") &&
    typeof event.eventId === "string" && event.eventId.length > 0 &&
    typeof event.occurredAt === "string" && typeof event.runId === "string" && event.runId.length > 0 &&
    typeof event.actionId === "string" && event.actionId.length > 0 &&
    typeof event.experimentId === "string" && event.experimentId.length > 0;
}

export type ReconciliationReport = {
  validEvents: GrowthEvent[];
  duplicateEventIds: string[];
  invalidEventIndexes: number[];
  orphanOutcomeEventIds: string[];
  actionStates: Record<string, "created" | "published" | "outcome_observed">;
};

/** Reconciles local handoff events without assuming that this process published anything. */
export function reconcileGrowthEvents(events: readonly unknown[]): ReconciliationReport {
  const seen = new Set<string>();
  const validEvents: GrowthEvent[] = [];
  const duplicateEventIds: string[] = [];
  const invalidEventIndexes: number[] = [];
  for (const [index, value] of events.entries()) {
    if (!validateGrowthEvent(value)) {
      invalidEventIndexes.push(index);
      continue;
    }
    if (seen.has(value.eventId)) {
      duplicateEventIds.push(value.eventId);
      continue;
    }
    seen.add(value.eventId);
    validEvents.push(value);
  }
  const created = new Set(validEvents.filter((event) => event.event === "action_created").map((event) => `${event.runId}:${event.actionId}:${event.experimentId}`));
  const actionStates: Record<string, "created" | "published" | "outcome_observed"> = {};
  for (const event of validEvents) {
    const key = `${event.runId}:${event.actionId}:${event.experimentId}`;
    if (event.event === "action_created") actionStates[key] = "created";
    if (event.event === "action_published") actionStates[key] = "published";
    if (event.event === "outcome_observed") actionStates[key] = "outcome_observed";
  }
  return {
    validEvents,
    duplicateEventIds: [...new Set(duplicateEventIds)],
    invalidEventIndexes,
    orphanOutcomeEventIds: validEvents.filter((event) => event.event !== "action_created" && !created.has(`${event.runId}:${event.actionId}:${event.experimentId}`)).map((event) => event.eventId),
    actionStates,
  };
}

export const reconcileEvents = reconcileGrowthEvents;

/**
 * Growth events are logged at the handoff boundary. Logging action_published
 * or outcome_observed is intentionally explicit: this process does not own
 * the downstream publisher or the external outcome source.
 */
export function emitGrowthEvent(logger: StructuredLogger, input: GrowthEventInput): GrowthEvent {
  const event = createGrowthEvent(input);
  logger.info(event.event, {
    schemaVersion: event.schemaVersion,
    eventVersion: event.eventVersion,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    actionId: event.actionId,
    experimentId: event.experimentId,
    ...(event.properties ?? {}),
  });
  return event;
}

export function emitActionCreated(
  logger: StructuredLogger,
  input: Omit<GrowthEventInput, "event">,
): GrowthEvent {
  return emitGrowthEvent(logger, { ...input, event: "action_created" });
}

export function emitActionPublished(
  logger: StructuredLogger,
  input: Omit<GrowthEventInput, "event">,
): GrowthEvent {
  return emitGrowthEvent(logger, { ...input, event: "action_published" });
}

export function emitOutcomeObserved(
  logger: StructuredLogger,
  input: Omit<GrowthEventInput, "event">,
): GrowthEvent {
  return emitGrowthEvent(logger, { ...input, event: "outcome_observed" });
}
