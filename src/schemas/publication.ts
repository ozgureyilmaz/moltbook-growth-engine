import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const PublicationStatusSchema = z.enum(["pending", "acknowledged", "published", "failed"]);

export const PublicationSchema = z
  .object({
    publicationId: IdSchema,
    actionId: IdSchema,
    experimentId: IdSchema.optional(),
    status: PublicationStatusSchema,
    attemptedAt: IsoDateSchema.optional(),
    acknowledgedAt: IsoDateSchema.optional(),
    errorMessage: z.string().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type Publication = z.infer<typeof PublicationSchema>;
