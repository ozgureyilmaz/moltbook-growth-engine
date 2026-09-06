import type { OrchestratorOptions, OrchestratorResult, SolOrchestrator } from "../orchestrator";
import { randomUUID } from "node:crypto";

export type SchedulerOptions = OrchestratorOptions & {
  intervalMs?: number;
  cronExpression?: string;
  signal?: AbortSignal;
  beforeRun?: () => void | Promise<void>;
  onRun?: (result: OrchestratorResult) => void | Promise<void>;
};

export function createRunId(prefix = "run"): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}_${randomUUID().slice(0, 8)}`;
}

export async function runOnce(orchestrator: SolOrchestrator, options: OrchestratorOptions = {}): Promise<OrchestratorResult> {
  return orchestrator.run(options.runId ? options : { ...options, runId: createRunId() });
}

function cronFieldMatches(value: number, field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const [baseValue, stepText] = part.split("/");
    const base = baseValue ?? "*";
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return false;
    const range = base === "*" ? [min, max] : base.includes("-") ? base.split("-").map(Number) : [Number(base), Number(base)];
    if (range.length !== 2 || range.some((entry) => !Number.isInteger(entry))) return false;
    const [start, end] = range as [number, number];
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

export function validateCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*,\-\/]+$/.test(field))) throw new Error("cron must be a standard five-field expression: minute hour day-of-month month day-of-week");
  validateCronField(fields[0]!, 0, 59, "minute");
  validateCronField(fields[1]!, 0, 23, "hour");
  validateCronField(fields[2]!, 1, 31, "day-of-month");
  validateCronField(fields[3]!, 1, 12, "month");
  validateCronField(fields[4]!, 0, 6, "day-of-week");
  return fields.join(" ");
}

function validateCronField(field: string, min: number, max: number, name: string): void {
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error(`cron ${name} field is invalid: ${field}`);
    const base = pieces[0] ?? "";
    const step = pieces[1] === undefined ? 1 : Number(pieces[1]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name} field has an invalid step: ${field}`);
    if (base === "*") continue;
    if (!base) throw new Error(`cron ${name} field is invalid: ${field}`);
    const range = base.includes("-") ? base.split("-").map(Number) : [Number(base), Number(base)];
    if (range.length !== 2 || range.some((value) => !Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`cron ${name} field is outside ${min}-${max}: ${field}`);
    }
    const [start, end] = range as [number, number];
    if (start > end) throw new Error(`cron ${name} field has a descending range: ${field}`);
  }
}

export function nextCronDelay(expression: string, from = new Date()): number {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = validateCronExpression(expression).split(" ");
  for (let offset = 1; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = new Date(from.getTime() + offset * 60_000);
    if (cronFieldMatches(candidate.getMinutes(), minute!, 0, 59) &&
      cronFieldMatches(candidate.getHours(), hour!, 0, 23) &&
      cronFieldMatches(candidate.getDate(), dayOfMonth!, 1, 31) &&
      cronFieldMatches(candidate.getMonth() + 1, month!, 1, 12) &&
      cronFieldMatches(candidate.getDay(), dayOfWeek!, 0, 6)) return candidate.getTime() - from.getTime();
  }
  throw new Error(`cron expression has no occurrence within one year: ${expression}`);
}

/** Interval scheduling is intentionally in-process and cancellable for local V1 operation. */
export async function runDaemon(orchestrator: SolOrchestrator, options: SchedulerOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("intervalMs must be a positive safe integer");
  const cronExpression = options.cronExpression ? validateCronExpression(options.cronExpression) : undefined;
  let stopped = false;
  const stop = () => { stopped = true; };
  options.signal?.addEventListener("abort", stop, { once: true });
  while (!stopped) {
    await options.beforeRun?.();
    if (stopped) break;
    const result = await orchestrator.run(options.runId ? options : { ...options, runId: createRunId() });
    await options.onRun?.(result);
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const delay = cronExpression ? nextCronDelay(cronExpression) : intervalMs;
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  options.signal?.removeEventListener("abort", stop);
}
