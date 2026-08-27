import type { ActionPayload, EvaluationResult, GeneratedCandidate, NoActionDecision, Opportunity } from "../orchestrator/contracts";
import { actionIdFor, experimentIdFor, noActionIdFor } from "../domain/identifiers";
import { ActionSchema, validateActionSecurity, type ActionSecurityOptions } from "../schemas";

export type OutboxPayload = ActionPayload | NoActionDecision;

export function makeActionPayload(
  runId: string,
  opportunity: Opportunity,
  candidate: GeneratedCandidate,
  evaluation: EvaluationResult,
  createdAt = new Date().toISOString(),
  experimentId = experimentIdFor(actionIdFor(opportunity.post.postId, candidate.comment, candidate.strategyFamily), runId),
): ActionPayload {
  const actionId = actionIdFor(opportunity.post.postId, candidate.comment, candidate.strategyFamily);
  return {
    schemaVersion: "1.0",
    actionId,
    action: "COMMENT",
    platform: "moltbook",
    target: {
      postId: opportunity.post.postId,
      postUrl: opportunity.post.url,
      submolt: opportunity.post.submolt,
      agentId: opportunity.post.author.id,
      agentName: opportunity.post.author.name,
    },
    content: {
      comment: candidate.comment,
      strategyFamily: candidate.strategyFamily,
      hookFamily: candidate.hookFamily,
    },
    decision: {
      opportunityScore: opportunity.finalScore,
      evaluationScore: evaluation.overallScore,
      confidence: evaluation.confidence,
    },
    experiment: {
      experimentId,
      promptVersion: candidate.promptVersion,
      modelVersion: evaluation.modelVersion,
    },
    metadata: { createdAt, runId },
  };
}

export function makeNoAction(
  runId: string,
  postId: string,
  reason: NoActionDecision["reason"],
  postUrl?: string,
  createdAt = new Date().toISOString(),
): NoActionDecision {
  return {
    schemaVersion: "1.0",
    actionId: noActionIdFor(runId, postId, reason),
    action: "NO_ACTION",
    reason,
    ...(postUrl ? { target: { postId, postUrl } } : {}),
    metadata: { createdAt, runId },
  };
}

export function validateActionPayload(value: unknown, options: ActionSecurityOptions = { mode: "dry-run" }): value is OutboxPayload {
  return validateActionSecurity(value, options).success;
}

export function parseActionPayload(value: unknown, options: ActionSecurityOptions = { mode: "dry-run" }): OutboxPayload {
  const result = validateActionSecurity(value, options);
  if (!result.success) throw result.error;
  return result.data as unknown as OutboxPayload;
}

export { ActionSchema };
