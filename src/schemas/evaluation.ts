import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  MetadataSchema,
  RecommendationSchema,
  ScoreSchema,
} from "./common";

export const EvaluationScoresSchema = z
  .object({
    contextFit: ScoreSchema,
    agentInterestProbability: ScoreSchema,
    marxRelevance: ScoreSchema,
    novelty: ScoreSchema,
    usefulness: ScoreSchema,
    naturalness: ScoreSchema,
    conversationContribution: ScoreSchema,
    nonSpamQuality: ScoreSchema,
    brandFit: ScoreSchema,
    followupProbability: ScoreSchema,
    investigationProbability: ScoreSchema,
    genericness: ScoreSchema,
    promotionIntensity: ScoreSchema,
    repetition: ScoreSchema,
    unsupportedClaimRisk: ScoreSchema,
  })
  .strict();

export const DeterministicQaResultSchema = z
  .object({
    sourcePostPresent: z.boolean(),
    contextPresent: z.boolean(),
    contextualAnchorPresent: z.boolean(),
    newIdeaCount: z.number().int().nonnegative(),
    marxMentionCount: z.number().int().nonnegative(),
    featureDump: z.boolean(),
    genericStartupPitch: z.boolean(),
    hiddenRedirect: z.boolean(),
    unapprovedDomain: z.boolean(),
    duplicateComment: z.boolean(),
    nearDuplicateComment: z.boolean(),
    threadAngleSaturated: z.boolean(),
    unsupportedPerformanceClaim: z.boolean(),
    deceptiveIdentityClaim: z.boolean(),
    standaloneMarketing: z.boolean(),
    passed: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

export const EvaluationSchema = z
  .object({
    evaluationId: IdSchema,
    candidateId: IdSchema,
    runId: IdSchema,
    recommendation: RecommendationSchema,
    scores: EvaluationScoresSchema,
    overallScore: ScoreSchema,
    confidence: ScoreSchema,
    concerns: z.array(z.string()),
    rejectionReasons: z.array(z.string()),
    deterministicQa: DeterministicQaResultSchema.optional(),
    evaluatorModel: z.string().trim().min(1),
    evaluatorVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1).optional(),
    createdAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type EvaluationScores = z.infer<typeof EvaluationScoresSchema>;
export type DeterministicQaResult = z.infer<typeof DeterministicQaResultSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;

/** Runtime evaluator contract used by the pre-schema orchestrator adapter. */
export const EvaluationResultSchema = z
  .object({
    candidateId: IdSchema,
    runId: IdSchema.optional(),
    sourcePostId: IdSchema.optional(),
    scores: z
      .object({
        contextFit: ScoreSchema,
        agentInterestProbability: ScoreSchema,
        marxRelevance: ScoreSchema,
        novelty: ScoreSchema,
        usefulness: ScoreSchema,
        naturalness: ScoreSchema,
        conversationContribution: ScoreSchema,
        nonSpamQuality: ScoreSchema,
        brandFit: ScoreSchema,
        likelihoodOfAgentFollowup: ScoreSchema,
        likelihoodOfMarxInvestigation: ScoreSchema,
        genericness: ScoreSchema,
        promotionIntensity: ScoreSchema,
        repetition: ScoreSchema,
        unsupportedClaimRisk: ScoreSchema,
      })
      .strict(),
    overallScore: ScoreSchema,
    confidence: ScoreSchema,
    recommendation: RecommendationSchema,
    reasons: z.array(z.string()),
    modelVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1).optional(),
    qa: z.object({
      passed: z.boolean(),
      checks: z.record(z.string(), z.boolean()),
      reasons: z.array(z.string()),
      marxMentionCount: z.number().int().nonnegative(),
      runId: IdSchema.optional(),
      sourcePostId: IdSchema.optional(),
    }).strict().optional(),
  })
  .strict();
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const QAResultSchema = z.object({
  passed: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  reasons: z.array(z.string()),
  marxMentionCount: z.number().int().nonnegative(),
  runId: IdSchema.optional(),
  sourcePostId: IdSchema.optional(),
}).strict();

export type QAResult = z.infer<typeof QAResultSchema>;
