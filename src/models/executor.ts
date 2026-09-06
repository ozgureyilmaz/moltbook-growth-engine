import { ZodError, ZodType } from "zod";
import { deterministicId } from "../domain/identifiers";

export interface ModelTask<T> {
  taskId: string;
  runId?: string;
  kind: string;
  /** Structured input. External post content must remain data in this value. */
  input: unknown;
  outputSchema: ZodType<T>;
  /** Runtime worker identity. Optional for compatibility with older callers. */
  worker?: string;
  /** Alias accepted at integration boundaries that call the identity workerId. */
  workerId?: string;
  /** Versioned prompt metadata. Optional for compatibility with older callers. */
  promptVersion?: string;
  /** The schema name carried alongside the runtime Zod validator. */
  expectedOutputSchema?: string;
  /** Per-task execution limits. Executor defaults apply when omitted. */
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  trustedInstructions?: string;
  untrustedContext?: unknown;
  /** A serialized, inert representation of external data for runtime inspection. */
  untrustedData?: string;
  model?: string;
  modelVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export type NormalizedModelTask<T> = Omit<ModelTask<T>, "runId" | "worker" | "workerId" | "promptVersion" | "expectedOutputSchema" | "timeoutMs" | "retryPolicy" | "model" | "modelVersion" | "untrustedData" | "metadata"> & {
  runId: string;
  worker: string;
  workerId: string;
  promptVersion: string;
  expectedOutputSchema: string;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  model: string;
  modelVersion: string;
  untrustedData: string;
  metadata: Record<string, unknown>;
};

export interface ModelResult<T> {
  output: T;
  taskId: string;
  requestId: string;
  attempts: number;
  model: string;
  modelVersion: string;
  startedAt: string;
  finishedAt: string;
}

export interface ModelExecutor {
  run<T>(task: ModelTask<T>): Promise<ModelResult<T>>;
}

export interface ExecutorLimits {
  maxAttempts?: number;
  maxConcurrent?: number;
  maxCalls?: number;
  retryDelayMs?: number;
}

export interface DeterministicMockExecutorOptions extends ExecutorLimits {
  handler?: (task: ModelTask<unknown>, attempt: number) => unknown | Promise<unknown>;
  responses?: Record<string, unknown>;
  defaultOutput?: unknown;
  model?: string;
  modelVersion?: string;
  retryable?: (error: unknown) => boolean;
  clock?: () => Date;
}

export type ModelDefaults = {
  runId?: string;
  model?: string;
  modelVersion?: string;
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
};

export class ModelExecutorError extends Error {
  readonly taskId: string;

  constructor(message: string, taskId: string) {
    super(message);
    this.name = "ModelExecutorError";
    this.taskId = taskId;
  }
}

export class ModelValidationError extends ModelExecutorError {
  readonly cause: ZodError;

  constructor(taskId: string, cause: ZodError) {
    super(`structured model output failed validation for task ${taskId}`, taskId);
    this.name = "ModelValidationError";
    this.cause = cause;
  }
}

export class ModelLimitError extends ModelExecutorError {
  constructor(message: string, taskId: string) {
    super(message, taskId);
    this.name = "ModelLimitError";
  }
}

/**
 * A deterministic, network-free executor for tests and dry runs. It treats
 * task input and untrusted context as inert data, validates every response,
 * and bounds both retries and concurrency.
 */
export class DeterministicMockExecutor implements ModelExecutor {
  private readonly handler: (task: ModelTask<unknown>, attempt: number) => unknown | Promise<unknown>;
  private readonly responses: Record<string, unknown>;
  private readonly defaultOutput: unknown;
  private readonly maxAttempts: number;
  private readonly maxConcurrent: number;
  private readonly maxCalls?: number;
  private readonly retryDelayMs: number;
  private readonly retryable: (error: unknown) => boolean;
  private readonly model: string;
  private readonly modelVersion: string;
  private readonly clock: () => Date;
  private active = 0;
  private callsStarted = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: DeterministicMockExecutorOptions = {}) {
    this.responses = options.responses ?? {};
    this.defaultOutput = options.defaultOutput;
    this.handler = options.handler ?? (async (task) => {
      if (Object.prototype.hasOwnProperty.call(this.responses, task.taskId)) {
        return this.responses[task.taskId];
      }
      if (this.defaultOutput !== undefined) return this.defaultOutput;
      throw new ModelExecutorError(`no deterministic response for task ${task.taskId}`, task.taskId);
    });
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 1, "maxConcurrent");
    this.maxCalls = options.maxCalls === undefined
      ? undefined
      : positiveInteger(options.maxCalls, "maxCalls");
    this.retryDelayMs = nonnegativeInteger(options.retryDelayMs ?? 0, "retryDelayMs");
    this.retryable = options.retryable ?? ((error) => !(error instanceof ModelLimitError));
    this.model = options.model ?? "mock";
    this.modelVersion = options.modelVersion ?? "mock-v1";
    this.clock = options.clock ?? (() => new Date());
  }

  get callCount(): number {
    return this.callsStarted;
  }

  async run<T>(task: ModelTask<T>): Promise<ModelResult<T>> {
    const runtimeTask = normalizeModelTask(task, {
      model: task.model ?? this.model,
      modelVersion: task.modelVersion ?? this.modelVersion,
      retryPolicy: {
        maxAttempts: this.maxAttempts,
        backoffMs: this.retryDelayMs,
      },
    });
    const startedAt = this.clock().toISOString();
    let lastError: unknown;

    for (let attempt = 1; attempt <= runtimeTask.retryPolicy.maxAttempts; attempt += 1) {
      try {
        await this.acquire(runtimeTask.taskId);
        try {
          this.reserveCall(runtimeTask.taskId);
          const raw = await this.handler(runtimeTask as ModelTask<unknown>, attempt);
          const parsed = runtimeTask.outputSchema.safeParse(raw);
          if (!parsed.success) throw new ModelValidationError(runtimeTask.taskId, parsed.error);
          const finishedAt = this.clock().toISOString();
          return {
            output: parsed.data,
            taskId: runtimeTask.taskId,
            requestId: deterministicId("model", runtimeTask.taskId, attempt),
            attempts: attempt,
            model: runtimeTask.model,
            modelVersion: runtimeTask.modelVersion,
            startedAt,
            finishedAt,
          };
        } finally {
          this.release();
        }
      } catch (error) {
        lastError = error;
        if (attempt >= runtimeTask.retryPolicy.maxAttempts || !this.retryable(error)) break;
        if (runtimeTask.retryPolicy.backoffMs > 0) await delay(runtimeTask.retryPolicy.backoffMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ModelExecutorError(`model task ${runtimeTask.taskId} failed`, runtimeTask.taskId);
  }

  private reserveCall(taskId: string): void {
    if (this.maxCalls !== undefined && this.callsStarted >= this.maxCalls) {
      throw new ModelLimitError(`model call limit reached (${this.maxCalls})`, taskId);
    }
    this.callsStarted += 1;
  }

  private async acquire(taskId: string): Promise<void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.active >= this.maxConcurrent) {
      throw new ModelLimitError("model concurrency limit could not be acquired", taskId);
    }
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}

/**
 * Normalizes legacy tasks at the executor boundary. This keeps existing
 * callers source-compatible while ensuring every actual runtime request has
 * the metadata and inert external-data fence required by the model boundary.
 */
export function normalizeModelTask<T>(task: ModelTask<T>, defaults: ModelDefaults = {}): NormalizedModelTask<T> {
  if (!task.taskId.trim()) throw new ModelExecutorError("model task requires taskId", task.taskId);
  if (!task.kind.trim()) throw new ModelExecutorError("model task requires kind", task.taskId);
  const timeoutMs = positiveInteger(task.timeoutMs ?? defaults.timeoutMs ?? 90_000, "timeoutMs");
  const retryPolicy: RetryPolicy = {
    maxAttempts: positiveInteger(task.retryPolicy?.maxAttempts ?? defaults.retryPolicy?.maxAttempts ?? 1, "retryPolicy.maxAttempts"),
    backoffMs: nonnegativeInteger(task.retryPolicy?.backoffMs ?? defaults.retryPolicy?.backoffMs ?? 0, "retryPolicy.backoffMs"),
  };
  const model = task.model ?? defaults.model ?? "default";
  const runId = task.runId ?? defaults.runId ?? "run_unknown";
  const modelVersion = task.modelVersion ?? defaults.modelVersion ?? model;
  const worker = task.worker ?? task.workerId ?? task.kind;
  const promptVersion = task.promptVersion ?? "runtime-v1";
  const expectedOutputSchema = task.expectedOutputSchema ?? task.outputSchema.description ?? `${task.kind}.output`;
  const externalData = task.untrustedContext !== undefined ? task.untrustedContext : task.untrustedData ?? null;
  const untrustedData = fenceUntrustedData(externalData);
  const metadata = {
    ...(task.metadata ?? {}),
    modelTask: {
      taskId: task.taskId,
      runId,
      worker,
      promptVersion,
      modelVersion,
      timeoutMs,
      retryPolicy,
      expectedOutputSchema,
    },
  };
  return {
    ...task,
    runId,
    worker,
    workerId: worker,
    promptVersion,
    expectedOutputSchema,
    timeoutMs,
    retryPolicy,
    model,
    modelVersion,
    untrustedData,
    metadata,
  };
}

export function fenceUntrustedData(value: unknown): string {
  let serialized: string;
  try {
    const json = JSON.stringify(value);
    serialized = json === undefined ? "null" : json;
  } catch {
    serialized = JSON.stringify(String(value));
  }
  // Prevent external strings from manufacturing the closing delimiter.
  return `<untrusted-data>\n${serialized.replaceAll("<", "\\u003c")}\n</untrusted-data>`;
}

/** Alias useful to callers that want to make the test-only nature explicit. */
export const MockModelExecutor = DeterministicMockExecutor;

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
