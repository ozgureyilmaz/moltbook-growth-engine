import { z } from "zod";
import { deterministicId } from "../domain/identifiers";
import { WorkerReportSchema } from "../schemas";
import type { RuntimeWorkerRole, WorkerReport } from "./contracts";

export const RUNTIME_WORKER_ROLES = [
  "discovery_context",
  "opportunity_analysis",
  "strategy_generation",
] as const satisfies readonly RuntimeWorkerRole[];

export type RuntimeWorkerInput<T> = {
  taskId: string;
  runId: string;
  worker: RuntimeWorkerRole;
  objective: string;
  constraints: string[];
  expectedOutputSchema: string;
  terminationCondition: string;
  promptVersion: string;
  modelVersion: string;
  timeoutMs: number;
  retryPolicy: { maxAttempts: number; backoffMs: number };
  input: T;
};

export type RuntimeWorkerOutput<T> = {
  output: T;
  summary: string;
  findings?: string[];
  artifacts?: string[];
  metrics?: Record<string, unknown>;
};

export type RuntimeWorkerFunction<T, U> = (
  input: T,
  task: RuntimeWorkerInput<T>,
) => Promise<RuntimeWorkerOutput<U> | U> | RuntimeWorkerOutput<U> | U;

export type BoundedWorkerOptions = {
  runId: string;
  maxConcurrent?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  now?: string;
  metadata?: Record<string, unknown>;
};

export type BoundedWorkerItem<T, U> = {
  task: RuntimeWorkerInput<T>;
  output?: U;
  report: WorkerReport;
};

export type BoundedWorkerBatch<T, U> = {
  items: Array<BoundedWorkerItem<T, U>>;
  reports: WorkerReport[];
  failed: WorkerReport[];
};

const RoleSchema = z.enum(RUNTIME_WORKER_ROLES);
let workerExecutionDepth = 0;

/** Validates that the runtime topology remains exactly the three bounded roles. */
export function isRuntimeWorkerRole(value: unknown): value is RuntimeWorkerRole {
  return RoleSchema.safeParse(value).success;
}

/**
 * Run independent worker tasks with a small concurrency pool and bounded
 * retries. Workers receive only their own input and cannot create workers.
 */
export async function runBoundedWorkers<T, U>(
  worker: RuntimeWorkerRole,
  tasks: Array<RuntimeWorkerInput<T>>,
  execute: RuntimeWorkerFunction<T, U>,
  options: BoundedWorkerOptions,
): Promise<BoundedWorkerBatch<T, U>> {
  if (workerExecutionDepth > 0) throw new Error("runtime workers cannot recursively spawn worker batches");
  if (!isRuntimeWorkerRole(worker)) throw new Error(`unsupported runtime worker role: ${String(worker)}`);
  const maxConcurrent = positiveInteger(options.maxConcurrent ?? 3, "maxConcurrent");
  const maxAttempts = positiveInteger(options.maxAttempts ?? 2, "maxAttempts");
  const retryBackoffMs = nonnegativeInteger(options.retryBackoffMs ?? 0, "retryBackoffMs");
  const now = options.now ?? new Date().toISOString();
  const items = new Array<BoundedWorkerItem<T, U> | undefined>(tasks.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (!task) return;
      if (task.worker !== worker || task.runId !== options.runId) throw new Error(`worker task ${task.taskId} has invalid role or run attribution`);
      let output: U | undefined;
      let summary = "worker task failed";
      let findings: string[] = [];
      let artifacts: string[] = [];
      let metrics: Record<string, unknown> = {};
      const errors: string[] = [];
      let attempts = 0;
      for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
        try {
          workerExecutionDepth += 1;
          let result;
          try {
            result = await withWorkerTimeout(Promise.resolve(execute(task.input, task)), task.timeoutMs, task.taskId);
          } finally {
            workerExecutionDepth -= 1;
          }
          const normalized = isWorkerOutput(result)
            ? result
            : { output: result, summary: "worker task completed" };
          output = normalized.output;
          summary = normalized.summary;
          findings = compactStrings(normalized.findings);
          artifacts = compactStrings(normalized.artifacts);
          metrics = normalized.metrics ?? {};
          break;
        } catch (error) {
          errors.push(redactError(error));
          if (attempts < maxAttempts && retryBackoffMs > 0) await delay(retryBackoffMs);
        }
      }
      const succeeded = output !== undefined && errors.length === 0;
      const partial = output !== undefined && errors.length > 0;
      const report = validateRuntimeWorkerReport({
        reportId: deterministicId("worker-report", options.runId, task.taskId),
        runId: options.runId,
        taskId: task.taskId,
        worker,
        status: succeeded ? "SUCCEEDED" : partial ? "PARTIAL" : "FAILED",
        summary: summary.slice(0, 500),
        findings,
        artifacts,
        metrics: { ...metrics, attempts },
        errors: errors.slice(0, 8),
        createdAt: now,
        metadata: {
          ...(options.metadata ?? {}),
          objective: task.objective,
          constraints: task.constraints,
          expectedOutputSchema: task.expectedOutputSchema,
          terminationCondition: task.terminationCondition,
          promptVersion: task.promptVersion,
          modelVersion: task.modelVersion,
          timeoutMs: task.timeoutMs,
          retryPolicy: task.retryPolicy,
        },
      });
      items[index] = { task, ...(output === undefined ? {} : { output }), report };
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrent, Math.max(1, tasks.length)) }, () => consume()));
  const completed = items.filter((item): item is BoundedWorkerItem<T, U> => item !== undefined);
  completed.sort((left, right) => tasks.indexOf(left.task) - tasks.indexOf(right.task));
  const reports = completed.map((item) => item.report);
  return { items: completed, reports, failed: reports.filter((report) => report.status !== "SUCCEEDED") };
}

export function validateRuntimeWorkerReport(value: unknown): WorkerReport {
  const parsed = WorkerReportSchema.parse(value);
  if (!isRuntimeWorkerRole(parsed.worker)) throw new Error(`worker report has unsupported role: ${parsed.worker}`);
  return parsed as WorkerReport;
}

function isWorkerOutput<T>(value: unknown): value is RuntimeWorkerOutput<T> {
  return Boolean(value && typeof value === "object" && "output" in value && "summary" in value && typeof (value as { summary?: unknown }).summary === "string");
}

function compactStrings(values: string[] | undefined): string[] {
  return (values ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 8).map((value) => value.slice(0, 240));
}

function redactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(?:api[_ -]?key|token|password|secret)\s*[=:]\s*\S+/gi, "$1=[REDACTED]").slice(0, 240);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withWorkerTimeout<T>(promise: Promise<T>, timeoutMs: number, taskId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`worker task ${taskId} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
