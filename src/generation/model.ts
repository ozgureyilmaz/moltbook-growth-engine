import { z } from "zod";
import { candidateIdFor, modelRunIdFor } from "../domain/identifiers";
import { loadPromptSync } from "../prompts/loader";
import { CodexExecutionError, ModelLimitError, type ModelExecutor, type ModelTask } from "../models";
import type { ModelRunRecord } from "../schemas";
import type { GeneratedCandidate, Opportunity, StrategyFamily } from "../orchestrator/contracts";
import { buildSpecificMarxComment } from "../specific-cycle/comments";
import { buildEvidenceAwareComment } from "./deterministic";

const MODEL_CANDIDATE_OUTPUT_SCHEMA = z.preprocess(normalizeModelCandidateOutput, z.object({
  candidates: z.array(z.object({
    strategyFamily: z.string().min(1),
    hookFamily: z.string().min(1).max(80),
    comment: z.string().trim().min(40).max(1200),
  }).strict()).min(1).max(14),
}).strict());

function normalizeModelCandidateOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.candidates)) return value;
  return {
    candidates: raw.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const item = candidate as Record<string, unknown>;
      return {
        strategyFamily: item.strategyFamily ?? item.strategy_family,
        hookFamily: item.hookFamily ?? item.hook_family,
        comment: item.comment,
      };
    }),
  };
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function compactUntrustedContext(opportunity: Opportunity): Record<string, unknown> {
  const evidence = opportunity.post.metadata && typeof opportunity.post.metadata === "object"
    ? (opportunity.post.metadata as Record<string, unknown>).marxEvidence
    : undefined;
  const compactEvidence = evidence && typeof evidence === "object"
    ? {
      articleId: (evidence as Record<string, unknown>).articleId,
      agentName: (evidence as Record<string, unknown>).agentName,
      quote: typeof (evidence as Record<string, unknown>).quote === "string" ? clip((evidence as Record<string, unknown>).quote as string, 700) : undefined,
      quoteUrl: (evidence as Record<string, unknown>).quoteUrl,
      evidenceStatus: (evidence as Record<string, unknown>).evidenceStatus,
    }
    : undefined;
  return {
    targetPost: {
      postId: opportunity.post.postId,
      submolt: opportunity.post.submolt,
      author: opportunity.post.author,
      content: clip(opportunity.post.content, 2_500),
    },
    conversation: {
      parent: opportunity.context.parent ? { content: clip(opportunity.context.parent.content, 1_000), author: opportunity.context.parent.author } : undefined,
      replies: opportunity.context.replies.slice(0, 3).map((reply) => ({ author: reply.author, content: clip(reply.content, 450) })),
      conversationText: clip(opportunity.context.conversationText, 1_500),
      repeatedAngles: opportunity.context.repeatedAngles.slice(0, 8),
    },
    marxEvidence: compactEvidence,
    opportunity: { reason: clip(opportunity.reason, 500), finalScore: opportunity.finalScore },
  };
}

export type ModelGenerationOptions = {
  executor: ModelExecutor;
  model?: string;
  modelVersion?: string;
  promptRoot?: string;
  promptVersion?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  runId?: string;
  sourcePostId?: string;
  includeAgentQuotes?: boolean;
  includeAgentQuoteSourceLink?: boolean;
  sourceLink?: string;
  maxCandidates?: number;
  onModelRun?: (record: ModelRunRecord) => Promise<void> | void;
};

/**
 * Generate the comment core through the configured model, then apply the
 * deterministic Marx evidence/link policy. External Moltbook/Marx content is
 * supplied only as inert untrusted context to the model.
 */
export async function generateCandidatesWithModel(
  opportunity: Opportunity,
  strategies: StrategyFamily[],
  options: ModelGenerationOptions,
): Promise<GeneratedCandidate[]> {
  const prompt = loadPromptSync("generator", options.promptVersion?.replace(/^generator-/, "") ?? "v1", { rootDir: options.promptRoot });
  const allowedStrategies = new Set(strategies);
  const task: ModelTask<z.infer<typeof MODEL_CANDIDATE_OUTPUT_SCHEMA>> = {
    taskId: `candidate_generation:${opportunity.opportunityId}`,
    runId: options.runId ?? opportunity.runId,
    kind: "candidate_generation",
    worker: "candidate_generator",
    promptVersion: prompt.promptVersion,
    model: options.model ?? "gpt-5.6-luna",
    modelVersion: options.modelVersion ?? options.model ?? "gpt-5.6-luna",
    timeoutMs: options.timeoutMs ?? 180_000,
    retryPolicy: { maxAttempts: options.maxAttempts ?? 1, backoffMs: options.retryBackoffMs ?? 0 },
    expectedOutputSchema: "ModelGeneratedCandidateOutput",
    trustedInstructions: `${prompt.instructions}

Generate one best candidate for the first allowed strategy family when the context supports it. Return only JSON matching the schema. Write the comment core without URLs, agent names, or quoted replies; the runtime will append the approved Marx source/evidence link. Do not invent facts or capabilities.`,
    input: {
      postId: opportunity.post.postId,
      allowedStrategyFamilies: strategies,
      target: { submolt: opportunity.post.submolt, authorType: opportunity.post.author.type },
    },
    untrustedContext: compactUntrustedContext(opportunity),
    outputSchema: MODEL_CANDIDATE_OUTPUT_SCHEMA as unknown as z.ZodType<z.infer<typeof MODEL_CANDIDATE_OUTPUT_SCHEMA>>,
  };
  const attemptedAt = new Date().toISOString();
  let result;
  try {
    result = await options.executor.run(task);
    await options.onModelRun?.({
      modelRunId: modelRunIdFor(task.runId ?? "run_unknown", task.taskId, result.attempts),
      runId: task.runId ?? "run_unknown",
      taskId: task.taskId,
      kind: task.kind,
      model: result.model,
      modelVersion: result.modelVersion,
      status: "SUCCEEDED",
      attempts: result.attempts,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      metadata: { worker: task.worker, promptVersion: task.promptVersion, expectedOutputSchema: task.expectedOutputSchema },
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await options.onModelRun?.({
      modelRunId: modelRunIdFor(task.runId ?? "run_unknown", task.taskId, 1),
      runId: task.runId ?? "run_unknown",
      taskId: task.taskId,
      kind: task.kind,
      model: task.model ?? "codex",
      modelVersion: task.modelVersion ?? task.model ?? "codex",
      status: error instanceof ModelLimitError ? "LIMITED" : "FAILED",
      attempts: 1,
      startedAt: attemptedAt,
      finishedAt,
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      metadata: {
        worker: task.worker,
        promptVersion: task.promptVersion,
        expectedOutputSchema: task.expectedOutputSchema,
        ...(error instanceof CodexExecutionError ? { failureKind: error.kind, ...error.metadata } : {}),
      },
    });
    throw error;
  }

  const candidates: GeneratedCandidate[] = [];
  const seenStrategies = new Set<StrategyFamily>();
  for (const candidate of result.output.candidates) {
    if (!allowedStrategies.has(candidate.strategyFamily as StrategyFamily)) continue;
    const strategyFamily = candidate.strategyFamily as StrategyFamily;
    if (seenStrategies.has(strategyFamily)) continue;
    seenStrategies.add(strategyFamily);
    const core = candidate.comment.replace(/https?:\/\/\S+/giu, "").replace(/\s+/gu, " ").trim();
    if (!core) continue;
    const comment = options.includeAgentQuotes
      ? buildEvidenceAwareComment(opportunity, core, options.includeAgentQuoteSourceLink !== false)
      : options.sourceLink
        ? buildSpecificMarxComment(core, options.sourceLink)
        : core;
    candidates.push({
      candidateId: candidateIdFor(opportunity.opportunityId, strategyFamily, comment),
      opportunityId: opportunity.opportunityId,
      ...(options.runId ?? opportunity.runId ? { runId: options.runId ?? opportunity.runId } : {}),
      sourcePostId: options.sourcePostId ?? opportunity.sourcePostId ?? opportunity.post.postId,
      strategyFamily,
      hookFamily: candidate.hookFamily,
      comment,
      promptVersion: prompt.promptVersion,
      modelVersion: result.modelVersion,
    });
  }
  if (candidates.length === 0) throw new Error(`model returned no allowed candidate for ${opportunity.post.postId}`);
  return candidates.slice(0, Math.max(1, options.maxCandidates ?? candidates.length));
}
