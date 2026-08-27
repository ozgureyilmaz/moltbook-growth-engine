import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const OutcomeSchema = z
  .object({
    outcomeId: IdSchema,
    experimentId: IdSchema,
    runId: IdSchema,
    publisherStatus: z.string().trim().min(1).optional(),
    outcome: z.string().trim().min(1).optional(),
    replyReceived: z.boolean().optional(),
    replyLatencySeconds: z.number().finite().nonnegative().optional(),
    reactionCount: z.number().int().nonnegative().optional(),
    targetAgentEngaged: z.boolean().optional(),
    marxMentionedByTargetAfterward: z.boolean().optional(),
    marxDiscussionVisitSignal: z.boolean().optional(),
    marxInvestigationSignal: z.boolean().optional(),
    marxInteractionSignal: z.boolean().optional(),
    marxUsageSignal: z.boolean().optional(),
    observedAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type Outcome = z.infer<typeof OutcomeSchema>;
