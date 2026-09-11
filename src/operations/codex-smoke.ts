import { z } from "zod";
import { CodexExecExecutor } from "../models";
import type { ModelExecutor } from "../models";

const SmokeOutputSchema = z.object({ status: z.literal("ok") }).strict();

export type CodexModelSmokeOptions = {
  executor?: ModelExecutor;
  binary?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
};

export type CodexModelSmokeResult = {
  status: "PASS";
  model: string;
  attempts: number;
  elapsedMs: number;
};

/** Run one structured, read-only model request without touching the engine or publisher. */
export async function runCodexModelSmoke(options: CodexModelSmokeOptions = {}): Promise<CodexModelSmokeResult> {
  const model = options.model ?? "gpt-5.6-luna";
  const executor = options.executor ?? new CodexExecExecutor({
    binary: options.binary ?? process.env.MARX_GROWTH_CODEX_BIN ?? "codex",
    cwd: options.cwd ?? "/tmp",
    model,
    reasoningEffort: options.reasoningEffort ?? "low",
    timeoutMs: options.timeoutMs ?? 120_000,
    maxAttempts: 1,
    maxConcurrent: 1,
  });
  const startedAt = Date.now();
  const result = await executor.run({
    taskId: "codex-smoke",
    runId: "codex-smoke",
    kind: "codex_smoke",
    model,
    modelVersion: model,
    trustedInstructions: "Return only JSON matching this schema: {\"status\":\"ok\"}. Do not use tools.",
    input: { probe: "structured-output" },
    outputSchema: SmokeOutputSchema,
  });
  return {
    status: "PASS",
    model,
    attempts: result.attempts,
    elapsedMs: Date.now() - startedAt,
  };
}
