import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfiguredMoltbookSource,
  AuthorizedMoltbookSource,
  DisabledMoltbookSource,
  FixtureMoltbookSource,
  type MoltbookSource,
} from "../discovery";
import { SolOrchestrator, type ObservableRunSummary } from "../orchestrator";
import { createRunId, runDaemon, runOnce, validateCronExpression } from "../scheduler";
import type { MoltbookPost, PersistenceLike } from "../orchestrator";
import { openRuntimePersistence } from "../persistence";
import { loadRuntimeSettings, resolveRuntimeSettings, type RuntimeConfig, type ResolvedRuntimeSettings } from "../config";
import { LocalOutbox } from "../outbox";
import { buildDryRunRecord, createConfiguredLogger, writeDryRunRecord, type JsonLogger } from "../telemetry";
import { StrategyStatsStore } from "../experiments";

export type CliDependencies = {
  source?: ConstructorParameters<typeof SolOrchestrator>[0];
  persistence?: PersistenceLike;
  orchestrator?: SolOrchestrator;
  stdout?: (line: string) => void;
  configDirectory?: string;
};

export type ParsedCli = {
  command: "run" | "status" | "experiments" | "replay" | "daemon";
  options: Record<string, string | boolean>;
  positional: string[];
};

export class CliExecutionError extends Error {
  public constructor(message: string, public readonly runId?: string) {
    super(message);
    this.name = "CliExecutionError";
  }
}

export function parseArgs(argv: string[]): ParsedCli {
  const command = (argv[0] ?? "run") as ParsedCli["command"];
  if (!["run", "status", "experiments", "replay", "daemon"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      const [key, inline] = value.slice(2).split("=", 2);
      if (!key) continue;
      if (inline !== undefined) options[key] = inline;
      else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
        index += 1;
        options[key] = argv[index]!;
      } else options[key] = true;
    } else positional.push(value);
  }
  return { command, options, positional };
}

function numeric(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanOption(value: string | boolean | undefined): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== "string") return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

type FixtureInput = { posts: MoltbookPost[]; contexts?: Record<string, unknown> };

async function sourceFromOptions(
  options: Record<string, string | boolean>,
  settings: ResolvedRuntimeSettings,
  supplied?: CliDependencies["source"],
): Promise<MoltbookSource> {
  const fixturePath = typeof options.fixture === "string" ? options.fixture : undefined;
  const base: MoltbookSource = supplied ?? (fixturePath
    ? await (async () => {
      const data = JSON.parse(await readFile(fixturePath, "utf8")) as Partial<FixtureInput>;
      if (!Array.isArray(data.posts)) throw new Error(`Fixture ${fixturePath} must contain a posts array`);
      return new FixtureMoltbookSource(data as ConstructorParameters<typeof FixtureMoltbookSource>[0]);
    })()
    : new DisabledMoltbookSource());
  return new ConfiguredMoltbookSource(base, {
    includeSubmolts: settings.includeSubmolts,
    excludeSubmolts: settings.excludeSubmolts,
    lookbackHours: settings.lookbackHours,
    allowedDomains: settings.allowedDomains,
    allowLocalDomains: Boolean(fixturePath),
    allowFutureTimestamps: Boolean(fixturePath),
    ignoreLookback: Boolean(fixturePath),
    maxContentChars: settings.submolts.filtering?.max_content_chars,
    maxContextReplies: settings.submolts.filtering?.max_context_replies,
  });
}

function dryRunDetails(result: Awaited<ReturnType<SolOrchestrator["run"]>>): string[] {
  const record = buildDryRunRecord(result);
  return [
    `Discovered posts: ${JSON.stringify(record.discoveredPosts)}`,
    `Opportunity scores: ${JSON.stringify(record.opportunityScores)}`,
    `Selected strategies: ${JSON.stringify(record.opportunityScores.map((entry) => ({ postId: entry.postId, strategies: entry.strategies })))}`,
    `Generated comments: ${JSON.stringify(record.generatedComments)}`,
    `Evaluator scores: ${JSON.stringify(record.evaluatorScores)}`,
    `QA rejection reasons: ${JSON.stringify(record.qaRejectionReasons)}`,
    `Final decisions: ${JSON.stringify(record.finalDecisions)}`,
  ];
}

export function formatRun(result: Awaited<ReturnType<SolOrchestrator["run"]>>): string {
  const summary = result.summary;
  return [
    `Run: ${summary.runId}`,
    `Discovered:        ${summary.discovered}`,
    `Analyzed:          ${summary.analyzed}`,
    `Qualified:         ${summary.qualified}`,
    `Generated:         ${summary.generated}`,
    `Passed evaluator:  ${summary.passedEvaluator}`,
    `Actions emitted:   ${summary.actionsEmitted}`,
    `Rejected:           ${summary.rejected}`,
    `Errors:             ${summary.errors}`,
    `Dry run:            ${summary.dryRun}`,
    `Evaluation mode:    ${summary.evaluationMode}`,
    `Mock evaluations:   ${summary.deterministicMockEvaluations}`,
    `Real model calls:   ${summary.realModelEvaluations}`,
    `Source mode:        ${summary.sourceMode}`,
    ...(summary.dryRun ? dryRunDetails(result) : []),
  ].join("\n");
}

function outboxRoot(config: RuntimeConfig): string {
  return dirname(config.publishing?.outbox?.pending_path ?? "outbox/pending");
}

function sourceMode(options: Record<string, string | boolean>, dependencies: CliDependencies): ObservableRunSummary["sourceMode"] {
  if (dependencies.source instanceof AuthorizedMoltbookSource) return "authorized";
  if (dependencies.source || dependencies.orchestrator) return "injected";
  if (typeof options.fixture === "string") return "fixture";
  return "disabled";
}

async function persistenceRuns(persistence: PersistenceLike): Promise<unknown[] | undefined> {
  const listRuns = (persistence as PersistenceLike & { listRuns?: (limit?: number) => Promise<unknown[]> | unknown[] }).listRuns;
  if (typeof listRuns !== "function") return undefined;
  return await listRuns.call(persistence, 100);
}

function assertRunHealthy(result: Awaited<ReturnType<SolOrchestrator["run"]>>): void {
  if (result.summary.errors > 0) throw new CliExecutionError(`Run ${result.summary.runId} completed with ${result.summary.errors} error(s)`, result.summary.runId);
}

async function persistDryRunRecord(result: Awaited<ReturnType<SolOrchestrator["run"]>>, logger: JsonLogger, settings: ResolvedRuntimeSettings): Promise<void> {
  const record = buildDryRunRecord({ ...result, logs: logger.entries() });
  logger.info("dry_run_record", record as unknown as Record<string, unknown>);
  await writeDryRunRecord(record, settings.system.observability?.run_log_directory ?? "logs/runs");
}

function configuredLogger(runId: string, settings: ResolvedRuntimeSettings): JsonLogger {
  return createConfiguredLogger(runId, {
    structured: settings.system.observability?.structured_logs ?? true,
    level: (settings.system.observability?.log_level as "debug" | "info" | "warn" | "error" | undefined) ?? "info",
    runDirectory: settings.system.observability?.run_log_directory ?? "logs/runs",
    errorDirectory: settings.system.observability?.error_log_directory ?? "logs/errors",
  });
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<string> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    const help = "Usage: marx-growth <run|status|experiments|replay|daemon> [options]\n\nrun options: --fixture <path> --limit <n> --actions <n> --lookback <hours> --dry-run\nstatus: status [run_id]\nexperiments: experiments\nreplay: replay <run_id> --fixture <path> --dry-run\ndaemon: daemon --once --interval <ms> | --cron \"<expression>\"";
    (dependencies.stdout ?? ((line: string) => console.log(line)))(help);
    return help;
  }
  const parsed = parseArgs(argv);
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  if (parsed.options.help) {
    const help = "Usage: marx-growth <run|status|experiments|replay|daemon> [options]\n\nrun options: --fixture <path> --limit <n> --actions <n> --lookback <hours> --dry-run";
    output(help);
    return help;
  }
  const settings = resolveRuntimeSettings(await loadRuntimeSettings(dependencies.configDirectory ?? process.env.MARX_GROWTH_CONFIG_DIR ?? "config"));
  const config = settings.system;
  const requestedDryRun = booleanOption(parsed.options["dry-run"]);
  const defaultDryRun = requestedDryRun ?? config.execution?.dry_run_by_default ?? true;
  const actionMode = (parsed.command === "run" || parsed.command === "daemon") && !defaultDryRun && settings.publishingEnabled ? "production" as const : "dry-run" as const;
  const persistence = dependencies.persistence ?? (await openRuntimePersistence(process.env.MARX_GROWTH_DB ?? config.storage?.database_path, {
    actionValidation: { mode: actionMode, allowedDomains: settings.allowedDomains },
  })).persistence;

  if (parsed.command === "status") {
    const runId = parsed.positional[0];
    if (!runId) {
      const runs = await persistenceRuns(persistence);
      const text = runs ? JSON.stringify(runs, null, 2) : "Status requires <run_id>; this persistence adapter does not expose run listing";
      output(text);
      return text;
    }
    const status = await persistence.getRun?.(runId);
    if (!status) throw new Error(`No run found for run_id=${runId}`);
    const text = JSON.stringify(status, null, 2);
    output(text);
    return text;
  }

  if (parsed.command === "experiments") {
    const experiments = (await persistence.getExperiments?.()) ?? [];
    const statsPath = settings.experiments.tracking?.strategy_stats_path ?? config.storage?.strategy_stats_path ?? "data/strategy-stats.json";
    const stats = new StrategyStatsStore(statsPath);
    await stats.recordExperiments(experiments.map((experiment) => ({ experiment })));
    const text = JSON.stringify({ experiments, strategyStats: await stats.load() }, null, 2);
    output(text);
    return text;
  }

  if (parsed.command === "replay") {
    const replayRunId = parsed.positional[0];
    if (!replayRunId) throw new Error("replay requires <run_id>");
    const originalRun = await persistence.getRun?.(replayRunId);
    if (!originalRun) throw new Error(`Cannot replay unknown run: ${replayRunId}`);
    if (!dependencies.orchestrator && !dependencies.source && typeof parsed.options.fixture !== "string") throw new Error("Replay requires --fixture <path> or an injected source; stored run summaries do not contain source content");
    if (booleanOption(parsed.options["dry-run"]) === false) throw new Error("Replay is always dry-run and cannot hand off publishing actions");
    const replayExecutionId = `${replayRunId}_replay_${Date.now().toString(36)}_${createRunId("x").slice(-8)}`;
    const logger = configuredLogger(replayExecutionId, settings);
    const replayOrchestrator = dependencies.orchestrator ?? new SolOrchestrator(await sourceFromOptions(parsed.options, settings, dependencies.source), persistence);
    const result = await runOnce(replayOrchestrator, {
      runId: replayExecutionId,
      replayOf: replayRunId,
      dryRun: true,
      sourceMode: sourceMode(parsed.options, dependencies),
      discoveryLimit: numeric(parsed.options.limit, Math.min(originalRun.discovered, settings.candidateLimit)),
      targetActions: numeric(parsed.options.actions, Math.min(originalRun.actionsEmitted, settings.targetActions)),
      candidateCount: settings.maxGeneratedCandidatesPerOpportunity,
      workerConcurrency: settings.modelConcurrency,
      workerMaxAttempts: settings.retryLimit,
      workerRetryBackoffMs: settings.retryBackoffMs,
      modelTimeoutMs: settings.system.model?.request_timeout_ms,
      modelMaxAttempts: settings.retryLimit,
      modelConcurrency: settings.modelConcurrency,
      modelRetryBackoffMs: settings.retryBackoffMs,
      model: config.model?.model_name ?? undefined,
      promptRoot: config.model?.prompt_root,
      lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours),
      explorationRate: settings.explorationRate,
      minimumObservationsBeforeExploitation: settings.minimumObservationsBeforeExploitation,
      scoringThreshold: settings.thresholds.minimumOpportunityScore,
      evaluationPolicy: config.thresholds,
      logger,
    });
    await persistDryRunRecord(result, logger, settings);
    const text = [`Replay of:          ${replayRunId}`, formatRun(result)].join("\n");
    output(text);
    assertRunHealthy(result);
    return text;
  }

  if (parsed.command === "daemon") {
    if (parsed.options.interval !== undefined && parsed.options.cron !== undefined) throw new Error("daemon accepts either --interval or --cron, not both");
    const cron = typeof parsed.options.cron === "string" ? validateCronExpression(parsed.options.cron) : undefined;
    let first: Awaited<ReturnType<SolOrchestrator["run"]>> | undefined;
    const controller = new AbortController();
    const daemonDryRun = booleanOption(parsed.options["dry-run"]) ?? config.execution?.dry_run_by_default ?? true;
    if (!daemonDryRun && !settings.publishingEnabled) throw new Error("Publishing is disabled by configuration; use --dry-run or explicitly enable publishing.enabled");
    if (!daemonDryRun && sourceMode(parsed.options, dependencies) !== "authorized") throw new Error("Production handoff requires an explicitly authorized Moltbook source mode");
    const daemonOrchestrator = dependencies.orchestrator ?? new SolOrchestrator(
      await sourceFromOptions(parsed.options, settings, dependencies.source),
      persistence,
      !daemonDryRun && settings.publishingEnabled ? new LocalOutbox(outboxRoot(config), { mode: "production", allowedDomains: settings.allowedDomains }) : undefined,
    );
    await runDaemon(daemonOrchestrator, {
      dryRun: daemonDryRun,
      sourceMode: sourceMode(parsed.options, dependencies),
      discoveryLimit: numeric(parsed.options.limit, settings.candidateLimit),
      targetActions: numeric(parsed.options.actions, settings.targetActions),
      candidateCount: settings.maxGeneratedCandidatesPerOpportunity,
      workerConcurrency: settings.modelConcurrency,
      workerMaxAttempts: settings.retryLimit,
      workerRetryBackoffMs: settings.retryBackoffMs,
      modelTimeoutMs: settings.system.model?.request_timeout_ms,
      modelMaxAttempts: settings.retryLimit,
      modelConcurrency: settings.modelConcurrency,
      modelRetryBackoffMs: settings.retryBackoffMs,
      model: config.model?.model_name ?? undefined,
      promptRoot: config.model?.prompt_root,
      lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours),
      explorationRate: settings.explorationRate,
      minimumObservationsBeforeExploitation: settings.minimumObservationsBeforeExploitation,
      scoringThreshold: settings.thresholds.minimumOpportunityScore,
      evaluationPolicy: config.thresholds,
      intervalMs: numeric(parsed.options.interval, 60 * 60 * 1000),
      cronExpression: cron,
      signal: controller.signal,
      onRun: async (result) => {
        first ??= result;
        if (result.summary.errors > 0 || parsed.options.once) controller.abort();
      },
    });
    const text = first ? formatRun(first) : "Daemon stopped before a run completed";
    output(text);
    if (first) assertRunHealthy(first);
    return text;
  }

  const dryRun = requestedDryRun ?? config.execution?.dry_run_by_default ?? true;
  if (!dryRun && !settings.publishingEnabled) throw new Error("Publishing is disabled by configuration; use --dry-run or explicitly enable publishing.enabled");
  if (!dryRun && sourceMode(parsed.options, dependencies) !== "authorized") throw new Error("Production handoff requires an explicitly authorized Moltbook source mode");
  const runId = createRunId();
  const logger = configuredLogger(runId, settings);
  const runOutbox = !dryRun && settings.publishingEnabled ? new LocalOutbox(outboxRoot(config), { mode: "production", allowedDomains: settings.allowedDomains }) : undefined;
  const runOrchestrator = dependencies.orchestrator ?? new SolOrchestrator(await sourceFromOptions(parsed.options, settings, dependencies.source), persistence, runOutbox);
  const result = await runOnce(runOrchestrator, {
    runId,
    dryRun,
    sourceMode: sourceMode(parsed.options, dependencies),
    discoveryLimit: numeric(parsed.options.limit, settings.candidateLimit),
    targetActions: numeric(parsed.options.actions, settings.targetActions),
    candidateCount: settings.maxGeneratedCandidatesPerOpportunity,
    workerConcurrency: settings.modelConcurrency,
    workerMaxAttempts: settings.retryLimit,
    workerRetryBackoffMs: settings.retryBackoffMs,
    modelTimeoutMs: settings.system.model?.request_timeout_ms,
    modelMaxAttempts: settings.retryLimit,
    modelConcurrency: settings.modelConcurrency,
    modelRetryBackoffMs: settings.retryBackoffMs,
    model: config.model?.model_name ?? undefined,
    promptRoot: config.model?.prompt_root,
    lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours),
    explorationRate: settings.explorationRate,
    minimumObservationsBeforeExploitation: settings.minimumObservationsBeforeExploitation,
    scoringThreshold: settings.thresholds.minimumOpportunityScore,
    evaluationPolicy: config.thresholds,
    logger,
  });
  if (result.experiments.length > 0) {
    const statsPath = settings.experiments.tracking?.strategy_stats_path ?? config.storage?.strategy_stats_path ?? "data/strategy-stats.json";
    await new StrategyStatsStore(statsPath).recordExperiments(result.experiments.map((experiment) => ({ experiment })));
  }
  if (dryRun) await persistDryRunRecord(result, logger, settings);
  const text = formatRun(result);
  output(text);
  assertRunHealthy(result);
  return text;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
