import type { ConversationContext, EvaluationResult, GeneratedCandidate } from "../orchestrator/contracts";
import { countMarxMentions } from "../generation";
import { deterministicId, modelRunIdFor } from "../domain/identifiers";
import { loadPromptSync, type PromptLoaderOptions } from "../prompts/loader";
import { ModelLimitError, type ModelExecutor, type ModelTask, type RetryPolicy } from "../models";
import type { ModelRunRecord } from "../schemas";
import { z } from "zod";

export interface CandidateEvaluator {
  evaluate(candidate: GeneratedCandidate, context: ConversationContext): Promise<EvaluationResult>;
}

const scoreKeys = [
  "contextFit",
  "agentInterestProbability",
  "marxRelevance",
  "novelty",
  "usefulness",
  "naturalness",
  "conversationContribution",
  "nonSpamQuality",
  "brandFit",
  "likelihoodOfAgentFollowup",
  "likelihoodOfMarxInvestigation",
  "genericness",
  "promotionIntensity",
  "repetition",
  "unsupportedClaimRisk",
] as const;

const scoreSchema = z.number().finite().min(0).max(1);
const canonicalScoresSchema = z.object(Object.fromEntries(scoreKeys.map((key) => [key, scoreSchema])) as Record<typeof scoreKeys[number], typeof scoreSchema>).strict();
const snakeToCamel: Record<string, string> = {
  context_fit: "contextFit",
  agent_interest_probability: "agentInterestProbability",
  marx_relevance: "marxRelevance",
  novelty: "novelty",
  usefulness: "usefulness",
  naturalness: "naturalness",
  conversation_contribution: "conversationContribution",
  non_spam_quality: "nonSpamQuality",
  brand_fit: "brandFit",
  likelihood_of_agent_followup: "likelihoodOfAgentFollowup",
  likelihood_of_marx_investigation: "likelihoodOfMarxInvestigation",
  genericness: "genericness",
  promotion_intensity: "promotionIntensity",
  repetition: "repetition",
  unsupported_claim_risk: "unsupportedClaimRisk",
};

function normalizeModelEvaluation(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const scores = raw.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return value;
  const normalizedScores: Record<string, unknown> = {};
  for (const [key, score] of Object.entries(scores as Record<string, unknown>)) {
    normalizedScores[snakeToCamel[key] ?? key] = score;
  }
  const reasons = raw.reasons ?? (Array.isArray(raw.violations) ? raw.violations : raw.reason ? [String(raw.reason)] : []);
  return {
    scores: normalizedScores,
    overallScore: raw.overallScore ?? raw.overall_score ?? raw.overall,
    confidence: raw.confidence ?? 0.7,
    recommendation: raw.recommendation ?? raw.decision,
    reasons,
  };
}

export const ModelEvaluationOutputSchema = z.preprocess(
  normalizeModelEvaluation,
  z.object({
    scores: canonicalScoresSchema,
    overallScore: scoreSchema,
    confidence: scoreSchema,
    recommendation: z.enum(["PUBLISH", "REGENERATE", "NO_ACTION"]),
    reasons: z.array(z.string()).max(12).default([]),
  }).strict(),
);

export type ModelEvaluationOutput = z.infer<typeof ModelEvaluationOutputSchema>;

export type ModelEvaluatorOptions = PromptLoaderOptions & {
  model?: string;
  modelVersion?: string;
  promptVersion?: string;
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  onModelRun?: (record: ModelRunRecord) => Promise<void> | void;
};

/** Candidate evaluator backed by the replaceable ModelExecutor boundary. */
export class ModelBackedCandidateEvaluator implements CandidateEvaluator {
  public constructor(
    private readonly executor: ModelExecutor,
    private readonly options: ModelEvaluatorOptions = {},
  ) {}

  public async evaluate(candidate: GeneratedCandidate, context: ConversationContext): Promise<EvaluationResult> {
    const prompt = loadPromptSync("evaluator", this.options.promptVersion?.replace(/^evaluator-/, "") ?? "v1", this.options);
    const task: ModelTask<ModelEvaluationOutput> = {
      taskId: deterministicId("evaluation", candidate.candidateId, prompt.promptVersion),
      runId: candidate.runId,
      kind: "candidate_evaluation",
      worker: "evaluator",
      promptVersion: prompt.promptVersion,
      model: this.options.model,
      modelVersion: this.options.modelVersion,
      timeoutMs: this.options.timeoutMs,
      retryPolicy: this.options.retryPolicy,
      expectedOutputSchema: "ModelEvaluationOutputSchema",
      trustedInstructions: `${prompt.instructions}\n\nReturn canonical camelCase score keys and exactly one recommendation.`,
      input: {
        candidateId: candidate.candidateId,
        postId: context.post.postId,
        candidate: { strategyFamily: candidate.strategyFamily, hookFamily: candidate.hookFamily },
      },
      untrustedContext: {
        post: context.post,
        parent: context.parent,
        replies: context.replies,
        conversationText: context.conversationText,
        candidateComment: candidate.comment,
        repeatedAngles: context.repeatedAngles,
        untrustedSignals: context.untrustedSignals,
      },
      metadata: { stage: "evaluator", candidateId: candidate.candidateId },
      outputSchema: ModelEvaluationOutputSchema as unknown as z.ZodType<ModelEvaluationOutput>,
    };
    const attemptedAt = new Date().toISOString();
    let result;
    try {
      result = await this.executor.run(task);
      await this.options.onModelRun?.({
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
      await this.options.onModelRun?.({
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
        metadata: { worker: task.worker, promptVersion: task.promptVersion, expectedOutputSchema: task.expectedOutputSchema },
      });
      throw error;
    }
    return {
      candidateId: candidate.candidateId,
      ...(candidate.runId === undefined ? {} : { runId: candidate.runId }),
      sourcePostId: candidate.sourcePostId ?? context.post.postId,
      scores: result.output.scores,
      overallScore: result.output.overallScore,
      confidence: result.output.confidence,
      recommendation: result.output.recommendation,
      reasons: result.output.reasons,
      modelVersion: result.modelVersion,
      promptVersion: prompt.promptVersion,
    };
  }
}

export const CodexCandidateEvaluator = ModelBackedCandidateEvaluator;
export const ModelCandidateEvaluator = ModelBackedCandidateEvaluator;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** Independent local evaluator used in fixtures and as a safe model fallback. */
export class IndependentMockEvaluator implements CandidateEvaluator {
  public constructor(private readonly modelVersion = "mock-evaluator-v1") {}

  public async evaluate(candidate: GeneratedCandidate, context: ConversationContext): Promise<EvaluationResult> {
    const comment = candidate.comment;
    const commentWords = new Set(comment.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const sourceWords = new Set(context.conversationText.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const overlap = [...commentWords].filter((word) => sourceWords.has(word) && word !== "marx").length;
    const contextFit = clamp(overlap / 8);
    const genericness = clamp(comment.length < 45 ? 0.6 : 0.05);
    const promotionIntensity = clamp((countMarxMentions(comment) - 1) * 0.35 + (/check out|sign up|best product/i.test(comment) ? 0.7 : 0));
    const scores = {
      contextFit,
      agentInterestProbability: clamp(contextFit * 0.55 + (context.replies.length ? 0.3 : 0.1)),
      marxRelevance: clamp(countMarxMentions(comment) > 0 ? 0.75 : 0),
      novelty: clamp(1 - context.marxMentions * 0.2),
      usefulness: clamp(contextFit * 0.6 + 0.25),
      naturalness: clamp(0.85 - promotionIntensity),
      conversationContribution: clamp(contextFit * 0.7 + 0.2),
      nonSpamQuality: clamp(0.95 - promotionIntensity - genericness),
      brandFit: clamp(countMarxMentions(comment) > 0 ? 0.85 : 0),
      likelihoodOfAgentFollowup: clamp(contextFit * 0.65 + 0.15),
      likelihoodOfMarxInvestigation: clamp(contextFit * 0.5 + 0.25),
      genericness,
      promotionIntensity,
      repetition: clamp(context.marxMentions * 0.2),
      unsupportedClaimRisk: clamp(/guarantee|risk-free|always wins/i.test(comment) ? 0.9 : 0.02),
    };
    const overallScore = clamp(
      (scores.contextFit + scores.usefulness + scores.naturalness + scores.conversationContribution + scores.nonSpamQuality + scores.likelihoodOfMarxInvestigation) / 6
      - scores.genericness * 0.3 - scores.promotionIntensity * 0.35 - scores.unsupportedClaimRisk * 0.5,
    );
    const recommendation = overallScore >= 0.62 ? "PUBLISH" : overallScore >= 0.45 ? "REGENERATE" : "NO_ACTION";
    return {
      candidateId: candidate.candidateId,
      scores,
      overallScore,
      confidence: 0.72,
      recommendation,
      reasons: [
        `context overlap=${overlap}`,
        `promotion=${scores.promotionIntensity.toFixed(2)}`,
        `genericness=${scores.genericness.toFixed(2)}`,
      ],
      modelVersion: this.modelVersion,
      promptVersion: candidate.promptVersion,
    };
  }
}

export async function evaluateIndependently(candidate: GeneratedCandidate, context: ConversationContext): Promise<EvaluationResult> {
  return new IndependentMockEvaluator().evaluate(candidate, context);
}
