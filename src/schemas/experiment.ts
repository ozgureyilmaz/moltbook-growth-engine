import { z } from "zod";
import { HttpUrlSchema, IdSchema, IsoDateSchema, MetadataSchema, ScoreSchema } from "./common";

export const ExperimentOutcomeSchema = z
  .object({
    publisherStatus: z.string().trim().min(1).optional(),
    outcome: z.string().trim().min(1).optional(),
    replyReceived: z.boolean().optional(),
    replyLatencySeconds: z.number().finite().nonnegative().optional(),
    reactionCount: z.number().int().nonnegative().optional(),
    targetAgentEngaged: z.boolean().optional(),
    marxMentionedByTargetAfterward: z.boolean().optional(),
    marxInvestigationSignal: z.boolean().optional(),
    marxDiscussionVisitSignal: z.boolean().optional(),
    marxInteractionSignal: z.boolean().optional(),
    marxUsageSignal: z.boolean().optional(),
    observedAt: IsoDateSchema.optional(),
  })
  .strict();

export const ExperimentSchema = z
  .object({
    experimentId: IdSchema,
    runId: IdSchema,
    sourcePlatform: z.literal("moltbook"),
    sourceSubmolt: z.string().trim().min(1),
    sourcePostId: IdSchema,
    sourceUrl: HttpUrlSchema,
    targetAgentId: IdSchema.optional(),
    targetAgentName: z.string().trim().min(1).optional(),
    hookFamily: z.string().trim().min(1),
    strategyFamily: z.string().trim().min(1),
    model: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    templateVersion: z.string().trim().min(1),
    commentHash: z.string().regex(/^[a-f0-9]{64}$/),
    semanticCluster: z.string().trim().min(1).optional(),
    opportunityScore: ScoreSchema,
    generatorScores: MetadataSchema.optional(),
    evaluatorScores: MetadataSchema.optional(),
    publicationTimestamp: IsoDateSchema.optional(),
    publisherStatus: z.string().trim().min(1).optional(),
    outcome: ExperimentOutcomeSchema.optional(),
    createdAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type ExperimentOutcome = z.infer<typeof ExperimentOutcomeSchema>;
export type Experiment = z.infer<typeof ExperimentSchema>;
