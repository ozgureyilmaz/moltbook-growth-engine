import { runDeterministicQA, threadAngleSaturatedTest } from "./deterministic";
import type { ConversationContext, EvaluationResult, GeneratedCandidate, NoActionDecision, QAResult } from "../orchestrator/contracts";
import { noActionIdFor } from "../domain/identifiers";

export type FinalDecisionPolicy = {
  /** Minimum evaluator score required after deterministic QA passes. */
  minimumEvaluationScore?: number;
  /** Minimum evaluator confidence required for autonomous publication. */
  minimumConfidence?: number;
};

export type FinalDecisionOptions = {
  runId?: string;
  policy?: FinalDecisionPolicy;
  createdAt?: string;
};

/** Safe defaults preserve the existing score gate and add an explicit confidence gate. */
export const DEFAULT_FINAL_DECISION_POLICY: Readonly<Required<FinalDecisionPolicy>> = Object.freeze({
  minimumEvaluationScore: 0.62,
  minimumConfidence: 0.70,
});

type DecisionReason = NoActionDecision["reason"];

const QA_REASON_MAP: Record<string, DecisionReason> = {
  CONTEXTUAL_ANCHOR_MISSING: "LOW_INFORMATION_VALUE",
  GENERIC_COMMENT: "GENERIC_COMMENT",
  DUPLICATE: "DUPLICATE",
  REPEATED_HOOK: "DUPLICATE",
  REPEATED_MARX_PHRASING: "DUPLICATE",
  USEFUL_NEW_IDEA_MISSING: "LOW_INFORMATION_VALUE",
  HYPE: "PROMOTIONAL_ONLY",
  UNSUPPORTED_CLAIM: "UNSUPPORTED_CLAIM",
  MARX_COUNT_INVALID: "QUALITY_BELOW_THRESHOLD",
  PROMPT_INJECTION_IN_CONTEXT: "PUBLISHING_RISK",
  FEATURE_DUMP: "PROMOTIONAL_ONLY",
  HIDDEN_REDIRECT: "PUBLISHING_RISK",
  DECEPTIVE_IDENTITY_CLAIM: "PUBLISHING_RISK",
  EMPTY_OR_TOO_SHORT: "LOW_INFORMATION_VALUE",
  THREAD_SATURATED: "THREAD_SATURATED",
  CONTEXT_MISSING: "CONTEXT_MISSING",
};

function boundedThreshold(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : fallback;
}

function resolveOptions(
  runIdOrOptions: string | FinalDecisionOptions,
  policyOverrides: FinalDecisionPolicy,
): { runId: string; createdAt?: string; policy: Required<FinalDecisionPolicy> } {
  const options = typeof runIdOrOptions === "string"
    ? { runId: runIdOrOptions, policy: policyOverrides }
    : runIdOrOptions;
  const supplied = options.policy ?? {};
  return {
    runId: options.runId ?? "run_unknown",
    createdAt: options.createdAt,
    policy: {
      minimumEvaluationScore: boundedThreshold(supplied.minimumEvaluationScore, DEFAULT_FINAL_DECISION_POLICY.minimumEvaluationScore),
      minimumConfidence: boundedThreshold(supplied.minimumConfidence, DEFAULT_FINAL_DECISION_POLICY.minimumConfidence),
    },
  };
}

function noActionReason(qa: QAResult, recommendation: EvaluationResult["recommendation"]): DecisionReason {
  if (qa.reasons.includes("CONTEXT_MISSING")) return "CONTEXT_MISSING";
  if (qa.reasons.includes("THREAD_SATURATED")) return "THREAD_SATURATED";
  for (const reason of qa.reasons) {
    const mapped = QA_REASON_MAP[reason];
    if (mapped) return mapped;
  }
  return recommendation === "NO_ACTION" ? "LOW_INFORMATION_VALUE" : "QUALITY_BELOW_THRESHOLD";
}

export function finalDecision(
  candidate: GeneratedCandidate,
  context: ConversationContext,
  evaluation: EvaluationResult,
  previousComments: string[] = [],
  runIdOrOptions: string | FinalDecisionOptions = "run_unknown",
  policyOverrides: FinalDecisionPolicy = {},
): { kind: "publish"; candidate: GeneratedCandidate; evaluation: EvaluationResult; qa: QAResult } | { kind: "no_action"; decision: NoActionDecision; evaluation: EvaluationResult; qa: QAResult } {
  const options = resolveOptions(runIdOrOptions, policyOverrides);
  const baseQa = runDeterministicQA(candidate, context, previousComments);
  const contextMissing = !baseQa.checks.source_post_present || !baseQa.checks.context_present;
  const threadSaturated = context.saturated || threadAngleSaturatedTest(candidate.comment, context);
  const qa: QAResult = {
    ...baseQa,
    checks: {
      ...baseQa.checks,
      thread_angle_saturated_rejected: !threadSaturated,
    },
    passed: baseQa.passed && !contextMissing && !threadSaturated,
    reasons: [
      ...baseQa.reasons,
      ...(contextMissing ? ["CONTEXT_MISSING"] : []),
      ...(threadSaturated ? ["THREAD_SATURATED"] : []),
    ].filter((reason, index, reasons) => reasons.indexOf(reason) === index),
    ...(candidate.runId === undefined && options.runId !== "run_unknown" ? { runId: options.runId } : {}),
    sourcePostId: candidate.sourcePostId ?? context.post.postId,
  };
  const attributedEvaluation: EvaluationResult = {
    ...evaluation,
    ...(evaluation.runId === undefined && options.runId !== "run_unknown" ? { runId: options.runId } : {}),
    ...(evaluation.sourcePostId === undefined ? { sourcePostId: candidate.sourcePostId ?? context.post.postId } : {}),
  };
  if (
    qa.passed &&
    attributedEvaluation.recommendation === "PUBLISH" &&
    attributedEvaluation.overallScore >= options.policy.minimumEvaluationScore &&
    attributedEvaluation.confidence >= options.policy.minimumConfidence
  ) {
    return { kind: "publish", candidate, evaluation: attributedEvaluation, qa };
  }
  return {
    kind: "no_action",
    decision: {
      schemaVersion: "1.0",
      actionId: noActionIdFor(options.runId, context.post.postId, noActionReason(qa, attributedEvaluation.recommendation)),
      action: "NO_ACTION",
      reason: noActionReason(qa, attributedEvaluation.recommendation),
      target: { postId: context.post.postId, postUrl: context.post.url },
      metadata: { createdAt: options.createdAt ?? new Date().toISOString(), runId: options.runId },
    },
    evaluation: attributedEvaluation,
    qa,
  };
}
