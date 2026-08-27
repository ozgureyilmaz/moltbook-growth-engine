import { commentHash, contextIdFor, deterministicId, normalizeText, sha256 } from "../domain/identifiers";
import {
  ActionSchema,
  ConversationContextSchema,
  EvaluationSchema,
  ExperimentSchema,
  GeneratedCandidateSchema,
  MoltbookPostSchema,
  OpportunitySchema,
  PostContextSchema,
  RunSchema,
  RunSummarySchema,
  validateActionSecurity,
  type Action,
  type CommentCandidate,
  type Evaluation,
  type Experiment,
  type MoltbookPost,
  type Opportunity as PersistedOpportunity,
  type PostContext,
  type Run,
} from "../schemas";
import type {
  ActionPayload,
  ConversationContext,
  EvaluationResult,
  ExperimentRecord,
  GeneratedCandidate,
  MoltbookPost as RuntimePost,
  NoActionDecision,
  Opportunity,
  RunSummary,
} from "../orchestrator/contracts";

export function adaptPost(value: RuntimePost): MoltbookPost {
  return MoltbookPostSchema.parse(value);
}

function replyAsPost(reply: ConversationContext["replies"][number], parent: RuntimePost, fetchedAt: string): MoltbookPost {
  return MoltbookPostSchema.parse({
    postId: reply.replyId,
    url: `https://moltbook.local/reply/${encodeURIComponent(reply.replyId)}`,
    submolt: parent.submolt,
    author: reply.author,
    content: reply.content,
    createdAt: reply.createdAt,
    fetchedAt,
    parentId: reply.parentId ?? parent.postId,
    engagement: reply.engagement,
  });
}

export function adaptContext(value: ConversationContext): PostContext {
  const post = adaptPost(value.post);
  return PostContextSchema.parse({
    contextId: contextIdFor(post.postId),
    post,
    ...(value.parent ? { parent: adaptPost(value.parent) } : {}),
    replies: value.replies.map((reply) => replyAsPost(reply, post, value.fetchedAt)),
    nearbyPosts: [],
    authorContext: value.authorContext ? JSON.stringify(value.authorContext) : undefined,
    conversationDirection: value.saturated ? "saturated" : undefined,
    existingMarxMentions: value.marxMentions,
    saturatedAngles: value.repeatedAngles,
    fetchedAt: value.fetchedAt,
  });
}

export function adaptOpportunity(value: Opportunity, runId: string, now: string): PersistedOpportunity {
  const post = adaptPost(value.post);
  const contextId = contextIdFor(post.postId);
  return OpportunitySchema.parse({
    opportunityId: value.opportunityId,
    runId,
    postId: post.postId,
    contextId,
    relevant: value.finalScore > 0,
    reason: value.reason,
    marxBridge: /marx/i.test(value.reason) ? value.reason : undefined,
    scores: value.scores,
    finalScore: value.finalScore,
    recommendedStrategies: value.recommendedStrategies,
    targetAgentId: post.author.id,
    targetAgentName: post.author.name,
    createdAt: now,
    metadata: {
      sourceUrl: post.url,
      sourceSubmolt: post.submolt,
      context: value.context,
    },
  });
}

export function adaptCandidate(value: GeneratedCandidate, link: { runId: string; sourcePostId: string }, now: string): CommentCandidate {
  return GeneratedCandidateSchema.parse({
    candidateId: value.candidateId,
    opportunityId: value.opportunityId,
    runId: link.runId,
    postId: link.sourcePostId,
    strategyFamily: value.strategyFamily,
    hookFamily: value.hookFamily,
    comment: value.comment,
    modelVersion: value.modelVersion,
    promptVersion: value.promptVersion,
    generatedAt: now,
    metadata: {
      sourcePostId: value.sourcePostId ?? link.sourcePostId,
    },
  });
}

export function adaptEvaluation(value: EvaluationResult, runId: string, now: string): Evaluation {
  return EvaluationSchema.parse({
    evaluationId: deterministicId("evaluation", value.candidateId),
    candidateId: value.candidateId,
    runId,
    recommendation: value.recommendation,
    scores: {
      contextFit: value.scores.contextFit,
      agentInterestProbability: value.scores.agentInterestProbability,
      marxRelevance: value.scores.marxRelevance,
      novelty: value.scores.novelty,
      usefulness: value.scores.usefulness,
      naturalness: value.scores.naturalness,
      conversationContribution: value.scores.conversationContribution,
      nonSpamQuality: value.scores.nonSpamQuality,
      brandFit: value.scores.brandFit,
      followupProbability: value.scores.likelihoodOfAgentFollowup,
      investigationProbability: value.scores.likelihoodOfMarxInvestigation,
      genericness: value.scores.genericness,
      promotionIntensity: value.scores.promotionIntensity,
      repetition: value.scores.repetition,
      unsupportedClaimRisk: value.scores.unsupportedClaimRisk,
    },
    overallScore: value.overallScore,
    confidence: value.confidence,
    concerns: value.reasons,
    rejectionReasons: value.recommendation === "PUBLISH" ? [] : value.reasons,
    evaluatorModel: value.modelVersion,
    evaluatorVersion: value.modelVersion,
    promptVersion: value.promptVersion,
    deterministicQa: value.qa ? {
      sourcePostPresent: Boolean(value.qa.checks.source_post_present),
      contextPresent: Boolean(value.qa.checks.context_present),
      contextualAnchorPresent: Boolean(value.qa.checks.contextual_anchor_present),
      newIdeaCount: value.qa.checks.useful_new_idea_present ? 1 : 0,
      marxMentionCount: value.qa.marxMentionCount,
      featureDump: value.qa.checks.feature_dump_rejected === false,
      genericStartupPitch: value.qa.reasons.includes("GENERIC_COMMENT"),
      hiddenRedirect: value.qa.checks.hidden_redirect === false,
      unapprovedDomain: value.qa.reasons.includes("PUBLISHING_RISK"),
      duplicateComment: value.qa.reasons.includes("DUPLICATE"),
      nearDuplicateComment: value.qa.reasons.includes("DUPLICATE"),
      threadAngleSaturated: value.qa.reasons.includes("THREAD_SATURATED"),
      unsupportedPerformanceClaim: value.qa.reasons.includes("UNSUPPORTED_CLAIM"),
      deceptiveIdentityClaim: value.qa.reasons.includes("DECEPTIVE_IDENTITY_CLAIM"),
      standaloneMarketing: value.qa.checks["standalone-marketing"] === true,
      passed: value.qa.passed,
      reasons: value.qa.reasons,
    } : undefined,
    createdAt: now,
    metadata: {
      sourcePostId: value.sourcePostId,
      promptVersion: value.promptVersion,
    },
  });
}

export function adaptAction(value: ActionPayload | NoActionDecision, options: { mode?: "production" | "fixture" | "dry-run"; allowedDomains?: readonly string[] } = {}): Action {
  const candidate = value.action === "COMMENT"
    ? {
        schemaVersion: value.schemaVersion,
        actionId: value.actionId,
        action: "COMMENT" as const,
        platform: value.platform,
        target: {
          postId: value.target.postId,
          postUrl: value.target.postUrl,
          ...(value.target.submolt ? { submolt: value.target.submolt } : {}),
          ...(value.target.agentId ? { agentId: value.target.agentId } : {}),
          ...(value.target.agentName ? { agentName: value.target.agentName } : {}),
        },
        content: {
          comment: normalizeText(value.content.comment),
          strategyFamily: value.content.strategyFamily,
          hookFamily: normalizeText(value.content.hookFamily),
        },
        decision: value.decision,
        experiment: value.experiment,
        metadata: value.metadata,
      }
    : {
        schemaVersion: value.schemaVersion,
        actionId: value.actionId,
        action: "NO_ACTION" as const,
        reason: value.reason,
        ...(value.target?.postId && value.target.postUrl
          ? { target: { postId: value.target.postId, postUrl: value.target.postUrl } }
          : {}),
        metadata: value.metadata,
      };
  const security = validateActionSecurity(candidate, options);
  if (!security.success) throw security.error;
  return security.data;
}

function adaptOutcome(value: ExperimentRecord["outcome"]): Experiment["outcome"] | undefined {
  if (!value) return undefined;
  return {
    replyReceived: value.replyReceived,
    replyLatencySeconds: value.replyLatencyMs === undefined ? undefined : value.replyLatencyMs / 1000,
    reactionCount: value.reactionCount,
    targetAgentEngaged: value.targetAgentEngaged,
    marxMentionedByTargetAfterward: value.marxMentionedByTargetAfterward,
    marxInvestigationSignal: value.marxInvestigationSignal ?? value.marxDiscussionVisitSignal,
    marxDiscussionVisitSignal: value.marxDiscussionVisitSignal ?? value.marxInvestigationSignal,
    marxInteractionSignal: value.marxInteractionSignal,
    marxUsageSignal: value.marxUsageSignal,
  };
}

export function adaptExperiment(value: ExperimentRecord, candidate: Pick<GeneratedCandidate, "comment" | "candidateId"> | undefined, now: string): Experiment {
  const hash = candidate ? commentHash(candidate.comment) : value.commentHash;
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`experiment ${value.experimentId} must have a SHA-256 comment hash or an attributable candidate`);
  return ExperimentSchema.parse({
    experimentId: value.experimentId,
    runId: value.runId,
    sourcePlatform: value.sourcePlatform,
    sourceSubmolt: value.sourceSubmolt,
    sourcePostId: value.sourcePostId,
    sourceUrl: value.sourceUrl,
    targetAgentId: value.targetAgentId,
    targetAgentName: value.targetAgentName,
    hookFamily: value.hookFamily,
    strategyFamily: value.strategyFamily,
    model: value.model,
    modelVersion: value.modelVersion,
    promptVersion: value.promptVersion,
    templateVersion: value.templateVersion,
    commentHash: hash,
    semanticCluster: value.semanticCluster,
    opportunityScore: value.opportunityScore,
    generatorScores: value.generatorScores,
    evaluatorScores: value.evaluatorScores,
    publicationTimestamp: value.publicationTimestamp,
    publisherStatus: value.publisherStatus,
    outcome: adaptOutcome(value.outcome),
    createdAt: (value as ExperimentRecord & { createdAt?: string }).createdAt ?? now,
    metadata: {
      candidateId: candidate?.candidateId,
      actionAttribution: candidate ? sha256(`${value.runId}:${candidate.candidateId}`) : undefined,
    },
  });
}

export function adaptRun(value: RunSummary): Run {
  const summary = RunSummarySchema.parse(value);
  return RunSchema.parse({
    runId: summary.runId,
    status: summary.errors > 0 ? "PARTIAL" : "COMPLETED",
    startedAt: summary.startTime,
    finishedAt: summary.endTime,
    counts: {
      postsDiscovered: summary.discovered,
      postsDeduplicated: summary.deduplicated,
      postsAnalyzed: summary.analyzed,
      opportunitiesQualified: summary.qualified,
      commentsGenerated: summary.generated,
      commentsRejected: summary.rejected,
      actionsEmitted: summary.actionsEmitted,
      errors: summary.errors,
      modelCalls: summary.modelCalls,
      retries: summary.retries ?? 0,
    },
    errorMessages: summary.errorMessages ?? [],
    estimatedResourceConsumption: summary.resourceMetadata,
    metadata: { ...(summary as unknown as Record<string, unknown>), failureReceipts: summary.failureReceipts ?? [] },
  });
}

export function canonicalAction(value: unknown): Action {
  return ActionSchema.parse(value);
}

export function canonicalContext(value: unknown): PostContext {
  return PostContextSchema.parse(value);
}

export function canonicalConversation(value: unknown): ConversationContext {
  return ConversationContextSchema.parse(value);
}
