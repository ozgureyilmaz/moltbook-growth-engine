import {
  Action,
  ActionSchema,
  CommentAction,
  Experiment,
  ExperimentSchema,
  NoAction,
  NoActionReason,
  NoActionSchema,
  StrategyFamily,
} from "../schemas";
import {
  actionIdFor,
  experimentIdFor,
  normalizeText,
  noActionIdFor,
} from "./identifiers";

export interface CreateCommentActionInput {
  runId: string;
  postId: string;
  postUrl: string;
  submolt?: string;
  agentId?: string;
  agentName?: string;
  comment: string;
  strategyFamily: StrategyFamily;
  hookFamily: string;
  opportunityScore: number;
  evaluationScore: number;
  confidence: number;
  promptVersion: string;
  modelVersion: string;
  now: string;
}

export function createCommentAction(input: CreateCommentActionInput): CommentAction {
  const actionId = actionIdFor(input.postId, input.comment, input.strategyFamily);
  return ActionSchema.parse({
    schemaVersion: "1.0",
    actionId,
    action: "COMMENT",
    platform: "moltbook",
    target: {
      postId: input.postId,
      postUrl: input.postUrl,
      submolt: input.submolt,
      agentId: input.agentId,
      agentName: input.agentName,
    },
    content: {
      comment: normalizeText(input.comment),
      strategyFamily: input.strategyFamily,
      hookFamily: normalizeText(input.hookFamily),
    },
    decision: {
      opportunityScore: input.opportunityScore,
      evaluationScore: input.evaluationScore,
      confidence: input.confidence,
    },
    experiment: {
      experimentId: experimentIdFor(actionId, input.runId),
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
    },
    metadata: { createdAt: input.now, runId: input.runId },
  }) as CommentAction;
}

export function createNoAction(input: {
  runId: string;
  reason: NoActionReason;
  now: string;
  postId?: string;
  postUrl?: string;
  submolt?: string;
  agentId?: string;
  agentName?: string;
}): NoAction {
  const target = input.postId && input.postUrl
    ? {
        postId: input.postId,
        postUrl: input.postUrl,
        submolt: input.submolt,
        agentId: input.agentId,
        agentName: input.agentName,
      }
    : undefined;
  const actionId = noActionIdFor(input.runId, input.postId ?? "unknown", input.reason);
  return NoActionSchema.parse({
    schemaVersion: "1.0",
    actionId,
    action: "NO_ACTION",
    reason: input.reason,
    target,
    metadata: { createdAt: input.now, runId: input.runId },
  });
}

export function parseAction(value: unknown): Action {
  return ActionSchema.parse(value);
}

export function parseExperiment(value: unknown): Experiment {
  return ExperimentSchema.parse(value);
}
