import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  MetadataSchema,
  ScoreSchema,
  StrategyFamilySchema,
} from "./common";
import { ConversationContextSchema, MoltbookPostSchema } from "./post";

export const OpportunityScoresSchema = z
  .object({
    semanticRelevance: ScoreSchema,
    marxBridgeStrength: ScoreSchema,
    agentAttentionProbability: ScoreSchema,
    conversationFit: ScoreSchema,
    engagementPotential: ScoreSchema,
    novelty: ScoreSchema,
    timing: ScoreSchema,
    targetQuality: ScoreSchema,
    spamRisk: ScoreSchema,
    repetitionRisk: ScoreSchema,
    contextMismatch: ScoreSchema,
  })
  .strict();

export const OpportunitySchema = z
  .object({
    opportunityId: IdSchema,
    runId: IdSchema,
    postId: IdSchema,
    contextId: IdSchema.optional(),
    relevant: z.boolean(),
    reason: z.string().trim().min(1),
    marxBridge: z.string().trim().min(1).optional(),
    scores: OpportunityScoresSchema,
    finalScore: ScoreSchema,
    recommendedStrategies: z.array(StrategyFamilySchema),
    targetAgentId: IdSchema.optional(),
    targetAgentName: z.string().trim().min(1).optional(),
    createdAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export const CommentCandidateSchema = z
  .object({
    candidateId: IdSchema,
    opportunityId: IdSchema,
    runId: IdSchema,
    postId: IdSchema,
    strategyFamily: StrategyFamilySchema,
    hookFamily: z.string().trim().min(1),
    comment: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    generatedAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type OpportunityScores = z.infer<typeof OpportunityScoresSchema>;
export type Opportunity = z.infer<typeof OpportunitySchema>;
export type CommentCandidate = z.infer<typeof CommentCandidateSchema>;
export const GeneratedCandidateSchema = CommentCandidateSchema;
export type GeneratedCandidate = CommentCandidate;

/** Runtime-stage contracts before persistence adapters add storage metadata. */
export const RuntimeOpportunitySchema = z.object({
  opportunityId: IdSchema,
  runId: IdSchema.optional(),
  sourcePostId: IdSchema.optional(),
  post: MoltbookPostSchema,
  context: ConversationContextSchema,
  scores: OpportunityScoresSchema,
  finalScore: ScoreSchema,
  reason: z.string().trim().min(1),
  recommendedStrategies: z.array(StrategyFamilySchema),
}).strict();

export const RuntimeGeneratedCandidateSchema = z.object({
  candidateId: IdSchema,
  opportunityId: IdSchema,
  runId: IdSchema.optional(),
  sourcePostId: IdSchema.optional(),
  strategyFamily: StrategyFamilySchema,
  hookFamily: z.string().trim().min(1),
  comment: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
  modelVersion: z.string().trim().min(1),
}).strict();

export type RuntimeOpportunity = z.infer<typeof RuntimeOpportunitySchema>;
export type RuntimeGeneratedCandidate = z.infer<typeof RuntimeGeneratedCandidateSchema>;
