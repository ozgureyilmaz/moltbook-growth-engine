import { parseActionPayload, type OutboxPayload } from "./payload";
import type { ActionSecurityOptions } from "../schemas";

type JsonRecord = Record<string, unknown>;

/** Canonical downstream transport uses the snake_case v1 contract. */
export function serializeActionTransport(payload: OutboxPayload): JsonRecord {
  if (payload.action === "NO_ACTION") {
    return {
      schema_version: payload.schemaVersion,
      action_id: payload.actionId,
      action: payload.action,
      reason: payload.reason,
      ...(payload.target ? { target: { post_id: payload.target.postId, ...(payload.target.postUrl ? { post_url: payload.target.postUrl } : {}) } } : {}),
      metadata: { created_at: payload.metadata.createdAt, run_id: payload.metadata.runId },
    };
  }
  return {
    schema_version: payload.schemaVersion,
    action_id: payload.actionId,
    action: payload.action,
    platform: payload.platform,
    target: {
      post_id: payload.target.postId,
      post_url: payload.target.postUrl,
      submolt: payload.target.submolt,
      ...(payload.target.agentId ? { agent_id: payload.target.agentId } : {}),
      ...(payload.target.agentName ? { agent_name: payload.target.agentName } : {}),
    },
    content: {
      comment: payload.content.comment,
      strategy_family: payload.content.strategyFamily,
      hook_family: payload.content.hookFamily,
    },
    decision: {
      opportunity_score: payload.decision.opportunityScore,
      evaluation_score: payload.decision.evaluationScore,
      confidence: payload.decision.confidence,
    },
    experiment: {
      experiment_id: payload.experiment.experimentId,
      prompt_version: payload.experiment.promptVersion,
      model_version: payload.experiment.modelVersion,
    },
    metadata: { created_at: payload.metadata.createdAt, run_id: payload.metadata.runId },
  };
}

/** Reads canonical snake_case transport and legacy internal camelCase files. */
export function parseActionTransport(value: unknown, options: ActionSecurityOptions): OutboxPayload {
  if (value && typeof value === "object" && "schemaVersion" in value) return parseActionPayload(value, options);
  if (!value || typeof value !== "object") throw new Error("outbox transport must be an object");
  const raw = value as JsonRecord;
  const target = raw.target as JsonRecord | undefined;
  const metadata = raw.metadata as JsonRecord | undefined;
  if (raw.action === "NO_ACTION") {
    return parseActionPayload({
      schemaVersion: raw.schema_version,
      actionId: raw.action_id,
      action: "NO_ACTION",
      reason: raw.reason,
      ...(target?.post_id && target?.post_url ? { target: { postId: target.post_id, postUrl: target.post_url } } : {}),
      metadata: { createdAt: metadata?.created_at, runId: metadata?.run_id },
    }, options);
  }
  const content = raw.content as JsonRecord | undefined;
  const decision = raw.decision as JsonRecord | undefined;
  const experiment = raw.experiment as JsonRecord | undefined;
  return parseActionPayload({
    schemaVersion: raw.schema_version,
    actionId: raw.action_id,
    action: raw.action,
    platform: raw.platform,
    target: { postId: target?.post_id, postUrl: target?.post_url, submolt: target?.submolt, agentId: target?.agent_id, agentName: target?.agent_name },
    content: { comment: content?.comment, strategyFamily: content?.strategy_family, hookFamily: content?.hook_family },
    decision: { opportunityScore: decision?.opportunity_score, evaluationScore: decision?.evaluation_score, confidence: decision?.confidence },
    experiment: { experimentId: experiment?.experiment_id, promptVersion: experiment?.prompt_version, modelVersion: experiment?.model_version },
    metadata: { createdAt: metadata?.created_at, runId: metadata?.run_id },
  }, options);
}
