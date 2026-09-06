import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfiguredMoltbookSource,
  AuthorizedMoltbookSource,
  DisabledMoltbookSource,
  FixtureMoltbookSource,
  MoltbookHttpClient,
  type MoltbookSource,
} from "../discovery";
import { SolOrchestrator, type ObservableRunSummary } from "../orchestrator";
import { createRunId, runDaemon, runOnce, validateCronExpression } from "../scheduler";
import type { MoltbookPost, PersistenceLike } from "../orchestrator";
import { openRuntimePersistence } from "../persistence";
import { loadRuntimeSettings, resolveRuntimeSettings, type RuntimeConfig, type ResolvedRuntimeSettings } from "../config";
import { LocalOutbox } from "../outbox";
import { buildDryRunRecord, createConfiguredLogger, ingestVerifiedOutcomeEvents, writeDryRunRecord, type JsonLogger, type OutcomeEvidencePersistence } from "../telemetry";
import { StrategyStatsStore } from "../experiments";
import { EnvironmentSecretProvider, MacOsKeychainSecretProvider, requireSecret, type SecretProvider } from "../secrets";
import { commandHealthCheck, EmergencyKillSwitch, installTerminationHandlers, KillSwitchClearanceSchema, LocalSupervisor, runHealthChecks, signKillSwitchClearance, writableDirectoryCheck, type HealthCheckRunner } from "../operations";
import { buildMoltbookActionRequest, MoltbookPublicationReceiptSchema, PublicationReceiptProcessor, PublisherHandoffStore, verifyAutonomousGrant, type AutonomousGrant, type ContractVerificationOptions } from "../publisher";

export type CliDependencies = {
  source?: ConstructorParameters<typeof SolOrchestrator>[0];
  persistence?: PersistenceLike;
  orchestrator?: SolOrchestrator;
  stdout?: (line: string) => void;
  configDirectory?: string;
};

export type ParsedCli = {
  command: "run" | "status" | "experiments" | "replay" | "daemon" | "doctor" | "handoff" | "outcomes" | "ops";
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
  if (!["run", "status", "experiments", "replay", "daemon", "doctor", "handoff", "outcomes", "ops"].includes(command)) throw new Error(`Unknown command: ${command}`);
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

function numeric(value: string | boolean | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`--${name} requires an integer value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function booleanOption(value: string | boolean | undefined): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== "string") return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function evaluationModeOption(options: Record<string, string | boolean>): "deterministic_mock" | "real_model" | undefined {
  const realModel = booleanOption(options["real-model"]);
  return realModel === true ? "real_model" : realModel === false ? "deterministic_mock" : undefined;
}

type FixtureInput = { posts: MoltbookPost[]; contexts?: Record<string, unknown> };

async function sourceFromOptions(
  options: Record<string, string | boolean>,
  settings: ResolvedRuntimeSettings,
  supplied?: CliDependencies["source"],
): Promise<MoltbookSource> {
  const fixturePath = typeof options.fixture === "string" ? options.fixture : undefined;
  const liveRead = booleanOption(options["live-read"]) === true || settings.system.source?.mode === "live_read_only" || settings.system.source?.mode === "authorized_autonomous";
  const base: MoltbookSource = supplied ?? (fixturePath
    ? await (async () => {
      const data = JSON.parse(await readFile(fixturePath, "utf8")) as Partial<FixtureInput>;
      if (!Array.isArray(data.posts)) throw new Error(`Fixture ${fixturePath} must contain a posts array`);
      return new FixtureMoltbookSource(data as ConstructorParameters<typeof FixtureMoltbookSource>[0]);
    })()
    : liveRead
      ? await buildAuthorizedSource(settings)
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

async function buildAuthorizedSource(settings: ResolvedRuntimeSettings): Promise<AuthorizedMoltbookSource> {
  const client = buildMoltbookClient(settings);
  await client.checkAuthorization();
  return new AuthorizedMoltbookSource(client, {
    authorized: true,
    allowedDomains: settings.allowedDomains,
    maxPages: settings.system.source?.max_pages,
    maxAttempts: settings.retryLimit,
    retryBackoffMs: settings.retryBackoffMs,
  });
}

function buildMoltbookClient(settings: ResolvedRuntimeSettings): MoltbookHttpClient {
  const source = settings.system.source;
  const provider: SecretProvider = source?.secret_provider === "environment"
    ? new EnvironmentSecretProvider()
    : new MacOsKeychainSecretProvider();
  return new MoltbookHttpClient({
    secretProvider: provider,
    secretReference: {
      name: "moltbook-read-api-key",
      environmentVariable: source?.api_key_environment_variable ?? "MOLTBOOK_API_KEY",
      keychainService: source?.keychain_service ?? "marx-moltbook-growth-engine",
      keychainAccount: source?.keychain_account ?? "moltbook-read-client",
    },
    baseUrl: source?.api_base_url,
    timeoutMs: source?.request_timeout_ms,
  });
}

async function publisherContractVerification(settings: ResolvedRuntimeSettings): Promise<ContractVerificationOptions> {
  const bridge = settings.system.publisher_bridge;
  const provider: SecretProvider = bridge?.contract_secret_provider === "environment"
    ? new EnvironmentSecretProvider()
    : new MacOsKeychainSecretProvider();
  const secret = await requireSecret(provider, {
    name: "moltbook-publisher-contract-secret",
    environmentVariable: bridge?.contract_secret_environment_variable ?? "MOLTBOOK_PUBLISHER_CONTRACT_SECRET",
    keychainService: bridge?.contract_keychain_service ?? "marx-moltbook-growth-engine",
    keychainAccount: bridge?.contract_keychain_account ?? "publisher-contract",
  });
  return { contractSecret: secret, expectedKeyId: bridge?.contract_key_id ?? "contract-v1", requireSignature: true };
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

function sourceMode(options: Record<string, string | boolean>, dependencies: CliDependencies, settings?: ResolvedRuntimeSettings): ObservableRunSummary["sourceMode"] {
  if (typeof options.fixture === "string") return "fixture";
  if (booleanOption(options["live-read"]) === true) return "live_read_only";
  if (settings?.system.source?.mode === "live_read_only") return "live_read_only";
  if (settings?.system.source?.mode === "authorized_autonomous") return "authorized_autonomous";
  if (dependencies.source instanceof AuthorizedMoltbookSource) return "authorized";
  if (dependencies.source || dependencies.orchestrator) return "injected";
  return "disabled";
}

function killSwitchFor(config: RuntimeConfig): EmergencyKillSwitch {
  return new EmergencyKillSwitch(config.operations?.kill_switch_path ?? "data/runtime/kill-switch.json", undefined, config.operations?.kill_switch_audit_path);
}

function assertAutonomousConfiguration(settings: ResolvedRuntimeSettings, mode: ObservableRunSummary["sourceMode"]): void {
  if (!settings.publishingEnabled) throw new Error("Publishing is disabled by configuration; use --dry-run or explicitly enable publishing.enabled");
  if (mode !== "authorized_autonomous") throw new Error("Production handoff requires source.mode=authorized_autonomous; --live-read is always read-only");
  if (settings.allowedDomains.length === 0) throw new Error("Production handoff requires a non-empty source/action domain allow-list");
  if (settings.system.publisher_bridge?.enabled !== true) throw new Error("Production handoff requires publisher_bridge.enabled=true");
}

function gatedProductionOutbox(config: RuntimeConfig, settings: ResolvedRuntimeSettings, killSwitch: EmergencyKillSwitch): LocalOutbox {
  return new LocalOutbox(outboxRoot(config), {
    mode: "production",
    allowedDomains: settings.allowedDomains,
    productionGate: async () => { await killSwitch.assertAutonomousAllowed(); },
  });
}

async function persistenceRuns(persistence: PersistenceLike): Promise<unknown[] | undefined> {
  const listRuns = (persistence as PersistenceLike & { listRuns?: (limit?: number) => Promise<unknown[]> | unknown[] }).listRuns;
  if (typeof listRuns !== "function") return undefined;
  return await listRuns.call(persistence, 100);
}

function outcomeEvidencePersistence(persistence: PersistenceLike): OutcomeEvidencePersistence {
  const required: Array<keyof OutcomeEvidencePersistence> = [
    "saveOutcomeEvent",
    "listOutcomeEvents",
    "getPublicationByActionId",
    "getExperimentAttribution",
    "saveOutcome",
  ];
  for (const method of required) {
    if (typeof persistence[method] !== "function") throw new Error(`Outcome import requires a persistence adapter with ${method}()`);
  }
  return persistence as OutcomeEvidencePersistence;
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
    const help = "Usage: marx-growth <run|status|experiments|replay|daemon|doctor|handoff|outcomes|ops> [options]\n\nrun options: --fixture <path> | --live-read --limit <n> --actions <n> --lookback <hours> --dry-run [--real-model]\nstatus: status [run_id]\nexperiments: experiments\nreplay: replay <run_id> --fixture <path> --dry-run\ndaemon: daemon --once --supervised --interval <ms> | --cron \"<expression>\"\ndoctor: doctor [--live-read] [--publisher] [--autonomous]\nhandoff: promote <run_id> <action_id>... | prepare <action_id> --grant <file> --publisher-account <name> | import-receipt <request_id> --receipt <file>\noutcomes: outcomes import --events <file>\nops: kill-status | kill-engage --reason <text> --actor <name> | kill-clearance-create --output <file> [--minutes <n>] | kill-clear --clearance <file>";
    (dependencies.stdout ?? ((line: string) => console.log(line)))(help);
    return help;
  }
  const parsed = parseArgs(argv);
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  if (parsed.options.help) {
    const help = "Usage: marx-growth <run|status|experiments|replay|daemon|doctor|handoff|outcomes|ops> [options]\n\nrun options: --fixture <path> | --live-read --limit <n> --actions <n> --lookback <hours> --dry-run [--real-model]";
    output(help);
    return help;
  }
  const settings = resolveRuntimeSettings(await loadRuntimeSettings(dependencies.configDirectory ?? process.env.MARX_GROWTH_CONFIG_DIR ?? "config"));
  const config = settings.system;
  const requestedDryRun = booleanOption(parsed.options["dry-run"]);
  const defaultDryRun = requestedDryRun ?? config.execution?.dry_run_by_default ?? true;
  const selectedSourceMode = sourceMode(parsed.options, dependencies, settings);
  const actionMode = (parsed.command === "run" || parsed.command === "daemon") && !defaultDryRun && settings.publishingEnabled && selectedSourceMode === "authorized_autonomous" ? "production" as const : "dry-run" as const;
  const persistence = dependencies.persistence ?? (await openRuntimePersistence(process.env.MARX_GROWTH_DB ?? config.storage?.database_path, {
    actionValidation: { mode: actionMode, allowedDomains: settings.allowedDomains },
  })).persistence;

  if (parsed.command === "doctor") {
    const checkedAt = new Date();
    const operations = config.operations;
    const runtimeDirectory = operations?.runtime_directory ?? "data/runtime";
    const killSwitch = killSwitchFor(config);
    const runners: HealthCheckRunner[] = [
      async () => ({ name: "configuration", status: "PASS", message: "Runtime configuration loaded", checkedAt: checkedAt.toISOString() }),
      async () => writableDirectoryCheck(runtimeDirectory, checkedAt),
      async () => {
        const state = await killSwitch.status();
        const autonomous = booleanOption(parsed.options.autonomous) === true;
        return {
          name: "emergency-kill-switch",
          status: state.status === "CLEARED" ? "PASS" : autonomous ? "FAIL" : "WARN",
          message: state.status === "CLEARED" ? "Emergency kill switch is cleared by a valid clearance" : `Emergency kill switch is engaged: ${state.reason}`,
          checkedAt: checkedAt.toISOString(),
          metadata: { status: state.status, clearanceExpiresAt: state.clearanceExpiresAt },
        };
      },
    ];
    if (booleanOption(parsed.options["live-read"]) === true) {
      runners.push(async () => {
        const client = buildMoltbookClient(settings);
        try {
          await client.checkAuthorization();
          return { name: "moltbook-read-authorization", status: "PASS", message: "Authorized Moltbook read probe succeeded", checkedAt: checkedAt.toISOString() };
        } catch (error) {
          const name = error instanceof Error && error.name === "SecretNotFoundError" ? "missing-secret" : "moltbook-read-authorization";
          return { name, status: "FAIL", message: error instanceof Error ? error.message : "Authorized Moltbook read probe failed", checkedAt: checkedAt.toISOString() };
        }
      });
    }
    if (booleanOption(parsed.options.publisher) === true) {
      const bridge = config.publisher_bridge;
      runners.push(async () => ({
        name: "publisher-contract",
        status: bridge?.provider === "openai-codex" && bridge.model === "gpt-5.6-luna" && bridge.reasoning_effort === "xhigh" ? (bridge.enabled ? "PASS" : "WARN") : "FAIL",
        message: bridge?.enabled ? "Hermes publisher contract is enabled" : "Hermes publisher contract is configured but disabled",
        checkedAt: checkedAt.toISOString(),
        metadata: { provider: bridge?.provider, model: bridge?.model, reasoningEffort: bridge?.reasoning_effort, enabled: bridge?.enabled === true },
      }));
      runners.push(async () => commandHealthCheck("hermes-gateway", bridge?.binary ?? "hermes", ["gateway", "status"], checkedAt));
    }
    if (booleanOption(parsed.options.autonomous) === true) {
      runners.push(async () => {
        const bridge = config.publisher_bridge;
        const checks = {
          source_mode: settings.system.source?.mode === "authorized_autonomous",
          publishing_enabled: settings.publishingEnabled,
          publisher_bridge_enabled: bridge?.enabled === true,
          domain_allowlist: settings.allowedDomains.length > 0,
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        return {
          name: "autonomous-configuration",
          status: failed.length === 0 ? "PASS" : "FAIL",
          message: failed.length === 0 ? "Autonomous production gates are configured" : `Autonomous production gates are missing: ${failed.join(", ")}`,
          checkedAt: checkedAt.toISOString(),
          metadata: checks,
        };
      });
      runners.push(async () => {
        try {
          const verification = await publisherContractVerification(settings);
          return { name: "publisher-contract-secret", status: "PASS", message: "Publisher contract secret is available", checkedAt: checkedAt.toISOString(), metadata: { keyId: verification.expectedKeyId } };
        } catch (error) {
          return { name: "publisher-contract-secret", status: "FAIL", message: error instanceof Error ? error.message : "Publisher contract secret is unavailable", checkedAt: checkedAt.toISOString() };
        }
      });
      runners.push(async () => commandHealthCheck("codex", "codex", ["--version"], checkedAt));
    }
    const report = await runHealthChecks(runners, checkedAt);
    const text = JSON.stringify(report, null, 2);
    output(text);
    if (booleanOption(parsed.options.autonomous) === true && report.status !== "READY") {
      throw new CliExecutionError(`doctor --autonomous is ${report.status}`);
    }
    return text;
  }

  if (parsed.command === "ops") {
    const operation = parsed.positional[0] ?? "kill-status";
    const killSwitch = killSwitchFor(config);
    if (operation === "kill-status") {
      const text = JSON.stringify(await killSwitch.status(), null, 2);
      output(text);
      return text;
    }
    if (operation === "kill-engage") {
      const reason = typeof parsed.options.reason === "string" ? parsed.options.reason : "operator emergency stop";
      const actor = typeof parsed.options.actor === "string" ? parsed.options.actor : "operator";
      const text = JSON.stringify(await killSwitch.engage(reason, actor), null, 2);
      output(text);
      return text;
    }
    if (operation === "kill-clear") {
      const clearancePath = typeof parsed.options.clearance === "string" ? parsed.options.clearance : undefined;
      if (!clearancePath) throw new Error("ops kill-clear requires --clearance <file>");
      const clearance = KillSwitchClearanceSchema.parse(JSON.parse(await readFile(clearancePath, "utf8")) as unknown);
      const text = JSON.stringify(await killSwitch.clear(clearance, await publisherContractVerification(settings)), null, 2);
      output(text);
      return text;
    }
    if (operation === "kill-clearance-create") {
      const outputPath = typeof parsed.options.output === "string" ? parsed.options.output : undefined;
      if (!outputPath) throw new Error("ops kill-clearance-create requires --output <file>");
      const minutes = numeric(parsed.options.minutes, 30, "minutes", 1);
      if (minutes > 1440) throw new Error("--minutes must be <= 1440 for a bounded clearance");
      const actor = typeof parsed.options.actor === "string" ? parsed.options.actor : "operator";
      const reason = typeof parsed.options.reason === "string" ? parsed.options.reason : "bounded live publishing pilot";
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + minutes * 60_000);
      const verification = await publisherContractVerification(settings);
      if (!verification.contractSecret || !verification.expectedKeyId) throw new Error("Publisher contract signing is unavailable");
      const clearance = signKillSwitchClearance({
        authorizationId: createRunId("clearance"),
        actor,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        reason,
      }, verification.expectedKeyId, verification.contractSecret);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(clearance, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const text = JSON.stringify({ written: true, path: outputPath, expiresAt: clearance.expiresAt }, null, 2);
      output(text);
      return text;
    }
    throw new Error(`Unknown ops operation: ${operation}`);
  }

  if (parsed.command === "handoff") {
    const operation = parsed.positional[0];
    const handoff = new PublisherHandoffStore(config.publisher_bridge?.handoff_path ?? "outbox/handoff");
    if (operation === "promote") {
      const runId = parsed.positional[1];
      const actionIds = parsed.positional.slice(2);
      if (!runId || actionIds.length === 0) throw new Error("handoff promote requires <run_id> and at least one <action_id>");
      assertAutonomousConfiguration(settings, selectedSourceMode);
      const killSwitch = killSwitchFor(config);
      await killSwitch.assertAutonomousAllowed();
      const run = await persistence.getRun?.(runId);
      const recordedRun = run as (typeof run & { sourceMode?: string }) | undefined;
      if (!recordedRun || recordedRun.dryRun !== true || recordedRun.sourceMode !== "live_read_only" || recordedRun.errors !== 0) {
        throw new Error(`handoff promote requires a completed, error-free live-read dry-run: ${runId}`);
      }
      const outbox = gatedProductionOutbox(config, settings, killSwitch);
      const promoted: Array<{ actionId: string; written: boolean; filePath: string }> = [];
      for (const actionId of actionIds) {
        const action = await persistence.getAction?.(actionId);
        if (!action || action.action === "NO_ACTION") throw new Error(`No COMMENT action found for action_id=${actionId}`);
        if (action.metadata.runId !== runId) throw new Error(`Action ${actionId} does not belong to live-read dry-run ${runId}`);
        const result = await outbox.enqueue(action);
        promoted.push({ actionId, ...result });
      }
      const text = JSON.stringify({ runId, promoted }, null, 2);
      output(text);
      return text;
    }
    if (operation === "prepare") {
      const actionId = parsed.positional[1];
      const grantPath = typeof parsed.options.grant === "string" ? parsed.options.grant : undefined;
      const publisherAccount = typeof parsed.options["publisher-account"] === "string" ? parsed.options["publisher-account"] : undefined;
      if (!actionId || !grantPath || !publisherAccount) throw new Error("handoff prepare requires <action_id>, --grant <file>, and --publisher-account <name>");
      if (config.publisher_bridge?.enabled !== true) throw new Error("Publisher bridge is disabled by configuration");
      assertAutonomousConfiguration(settings, selectedSourceMode);
      const killSwitch = killSwitchFor(config);
      await killSwitch.assertAutonomousAllowed();
      const outbox = gatedProductionOutbox(config, settings, killSwitch);
      const entry = (await outbox.listPending()).find((candidate) => candidate.payload.actionId === actionId);
      if (!entry || entry.payload.action === "NO_ACTION") throw new Error(`No pending COMMENT action found for action_id=${actionId}`);
      const grant = JSON.parse(await readFile(grantPath, "utf8")) as AutonomousGrant;
      const contractVerification = await publisherContractVerification(settings);
      const verifiedGrant = verifyAutonomousGrant(grant, contractVerification);
      const request = buildMoltbookActionRequest({
        action: entry.payload,
        grant: verifiedGrant,
        publisherAccount,
        publisher: {
          provider: config.publisher_bridge?.provider ?? "openai-codex",
          model: config.publisher_bridge?.model ?? "gpt-5.6-luna",
          reasoningEffort: config.publisher_bridge?.reasoning_effort ?? "xhigh",
        },
      });
      const result = await handoff.writeRequest(request);
      const text = JSON.stringify({ ...result, request }, null, 2);
      output(text);
      return text;
    }
    if (operation === "import-receipt") {
      const requestId = parsed.positional[1];
      const receiptPath = typeof parsed.options.receipt === "string" ? parsed.options.receipt : undefined;
      if (!requestId || !receiptPath) throw new Error("handoff import-receipt requires <request_id> and --receipt <file>");
      const request = await handoff.readRequest(requestId);
      if (!request) throw new Error(`Unknown publisher request: ${requestId}`);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
      const outbox = new LocalOutbox(outboxRoot(config), { mode: "production", allowedDomains: settings.allowedDomains, productionGate: async () => undefined });
      const result = await new PublicationReceiptProcessor(outbox, persistence, await publisherContractVerification(settings)).process(request, MoltbookPublicationReceiptSchema.parse(receipt));
      const text = JSON.stringify({ disposition: result.disposition, publication: result.publication, receipt: result.receipt }, null, 2);
      output(text);
      return text;
    }
    throw new Error("handoff requires prepare or import-receipt");
  }

  if (parsed.command === "outcomes") {
    const operation = parsed.positional[0];
    const eventsPath = typeof parsed.options.events === "string" ? parsed.options.events : undefined;
    if (operation !== "import" || !eventsPath) throw new Error("outcomes import requires --events <file>");
    const result = await ingestVerifiedOutcomeEvents(
      outcomeEvidencePersistence(persistence),
      JSON.parse(await readFile(eventsPath, "utf8")) as unknown,
    );
    const experiments = await persistence.getExperiments?.();
    const statsPath = settings.experiments.tracking?.strategy_stats_path ?? config.storage?.strategy_stats_path ?? "data/strategy-stats.json";
    const strategyStats = experiments && settings.experiments.learning?.update_priors_after_verified_outcome_import !== false
      ? await new StrategyStatsStore(statsPath).replaceExperiments(experiments.map((experiment) => ({ experiment })))
      : undefined;
    const text = JSON.stringify({ ...result, ...(strategyStats ? { strategyStats } : {}) }, null, 2);
    output(text);
    return text;
  }

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
      evaluationMode: evaluationModeOption(parsed.options),
      allowedDomains: settings.allowedDomains,
      sourceMode: selectedSourceMode,
      discoveryLimit: numeric(parsed.options.limit, Math.min(originalRun.discovered, settings.candidateLimit), "limit", 1),
      targetActions: numeric(parsed.options.actions, Math.min(originalRun.actionsEmitted, settings.targetActions), "actions", 0),
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
      lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours, "lookback", 1),
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
    if (!daemonDryRun) assertAutonomousConfiguration(settings, selectedSourceMode);
    const killSwitch = killSwitchFor(config);
    if (!daemonDryRun) await killSwitch.assertAutonomousAllowed();
    const removeTerminationHandlers = installTerminationHandlers(controller);
    const supervised = booleanOption(parsed.options.supervised) === true;
    const once = booleanOption(parsed.options.once) === true;
    const supervisor = supervised ? new LocalSupervisor({
      mode: daemonDryRun ? "FIXTURE_OR_READ_DRY_RUN" : "AUTHORIZED_AUTONOMOUS",
      lockPath: config.operations?.supervisor_lock_path,
      heartbeatPath: config.operations?.heartbeat_path,
      heartbeatStaleAfterMs: config.operations?.heartbeat_stale_after_ms,
    }) : undefined;
    let supervisorAcquired = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatFailure: Error | undefined;
    try {
      if (supervisor) {
        await supervisor.acquire();
        supervisorAcquired = true;
        const staleAfterMs = config.operations?.heartbeat_stale_after_ms ?? 900_000;
        const heartbeatEveryMs = Math.max(1_000, Math.floor(staleAfterMs / 3));
        heartbeatTimer = setInterval(() => {
          void supervisor.heartbeat("RUNNING").catch((error: unknown) => {
            heartbeatFailure = error instanceof Error ? error : new Error(String(error));
            controller.abort();
          });
        }, heartbeatEveryMs);
        heartbeatTimer.unref?.();
      }
      const daemonOrchestrator = dependencies.orchestrator ?? new SolOrchestrator(
        await sourceFromOptions(parsed.options, settings, dependencies.source),
        persistence,
        !daemonDryRun && settings.publishingEnabled ? gatedProductionOutbox(config, settings, killSwitch) : undefined,
      );
      await runDaemon(daemonOrchestrator, {
      dryRun: daemonDryRun,
      evaluationMode: evaluationModeOption(parsed.options),
      allowedDomains: settings.allowedDomains,
      sourceMode: selectedSourceMode,
      discoveryLimit: numeric(parsed.options.limit, settings.candidateLimit, "limit", 1),
      targetActions: numeric(parsed.options.actions, settings.targetActions, "actions", 0),
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
      lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours, "lookback", 1),
      explorationRate: settings.explorationRate,
      minimumObservationsBeforeExploitation: settings.minimumObservationsBeforeExploitation,
      scoringThreshold: settings.thresholds.minimumOpportunityScore,
      evaluationPolicy: config.thresholds,
      intervalMs: numeric(parsed.options.interval, 60 * 60 * 1000, "interval", 1),
      cronExpression: cron,
      signal: controller.signal,
      beforeRun: !daemonDryRun ? async () => { await killSwitch.assertAutonomousAllowed(); } : undefined,
      onRun: async (result) => {
        first ??= result;
        await supervisor?.heartbeat(result.summary.errors > 0 ? "FAILED" : "RUNNING", { runId: result.summary.runId, message: result.summary.errors > 0 ? `${result.summary.errors} run error(s)` : "Run completed" });
        if (result.summary.errors > 0 || once) controller.abort();
      },
      });
      if (heartbeatFailure) throw heartbeatFailure;
    } catch (error) {
      if (supervisorAcquired) await supervisor?.heartbeat("FAILED", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      removeTerminationHandlers();
      if (supervisorAcquired) await supervisor?.release();
    }
    const text = first ? formatRun(first) : "Daemon stopped before a run completed";
    output(text);
    if (first) assertRunHealthy(first);
    return text;
  }

  const dryRun = requestedDryRun ?? config.execution?.dry_run_by_default ?? true;
  if (!dryRun) assertAutonomousConfiguration(settings, selectedSourceMode);
  if (!dryRun) await killSwitchFor(config).assertAutonomousAllowed();
  const runId = createRunId();
  const logger = configuredLogger(runId, settings);
  const runKillSwitch = killSwitchFor(config);
  const runOutbox = !dryRun && settings.publishingEnabled ? gatedProductionOutbox(config, settings, runKillSwitch) : undefined;
  const runOrchestrator = dependencies.orchestrator ?? new SolOrchestrator(await sourceFromOptions(parsed.options, settings, dependencies.source), persistence, runOutbox);
  const result = await runOnce(runOrchestrator, {
    runId,
    dryRun,
    evaluationMode: evaluationModeOption(parsed.options),
    allowedDomains: settings.allowedDomains,
    sourceMode: selectedSourceMode,
    discoveryLimit: numeric(parsed.options.limit, settings.candidateLimit, "limit", 1),
    targetActions: numeric(parsed.options.actions, settings.targetActions, "actions", 0),
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
    lookbackHours: numeric(parsed.options.lookback, settings.lookbackHours, "lookback", 1),
    explorationRate: settings.explorationRate,
    minimumObservationsBeforeExploitation: settings.minimumObservationsBeforeExploitation,
    scoringThreshold: settings.thresholds.minimumOpportunityScore,
    evaluationPolicy: config.thresholds,
    logger,
  });
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
