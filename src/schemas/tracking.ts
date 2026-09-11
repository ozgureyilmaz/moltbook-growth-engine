import { z } from "zod";
import { HttpUrlSchema, IdSchema, IsoDateSchema } from "./common";

export const TrackingEnvironmentSchema = z.enum(["development", "production"]);
export const TrackingDistributionStatusSchema = z.enum(["PENDING", "ACTIVE", "UNKNOWN", "FAILED", "REVOKED"]);

export const TrackingDistributionSchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  trackingUrl: HttpUrlSchema,
  environment: TrackingEnvironmentSchema,
  status: TrackingDistributionStatusSchema,
  destinationUrl: HttpUrlSchema,
  platform: z.literal("moltbook"),
  contentType: z.literal("comment"),
  feedId: IdSchema,
  sourcePostId: IdSchema,
  sourceUrl: HttpUrlSchema,
  runId: IdSchema,
  opportunityId: IdSchema,
  candidateId: IdSchema,
  preLinkIdentity: IdSchema,
  idempotencyKey: IdSchema,
  actionId: IdSchema.optional(),
  experimentId: IdSchema.optional(),
  commentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  totalRedirects: z.number().int().nonnegative().optional(),
  clicked: z.boolean().optional(),
  firstClickedAt: IsoDateSchema.nullable().optional(),
  lastClickedAt: IsoDateSchema.nullable().optional(),
  createdAt: IsoDateSchema,
  finalizedAt: IsoDateSchema.optional(),
  errorMessage: z.string().trim().min(1).optional(),
}).strict();

export type TrackingEnvironment = z.infer<typeof TrackingEnvironmentSchema>;
export type TrackingDistributionStatus = z.infer<typeof TrackingDistributionStatusSchema>;
export type TrackingDistribution = z.infer<typeof TrackingDistributionSchema>;
