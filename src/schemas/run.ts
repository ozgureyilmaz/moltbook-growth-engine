import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const RunStatusSchema = z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED"]);

export const RunCountsSchema = z
  .object({
    postsDiscovered: z.number().int().nonnegative(),
    postsDeduplicated: z.number().int().nonnegative(),
    postsAnalyzed: z.number().int().nonnegative(),
    opportunitiesQualified: z.number().int().nonnegative(),
    commentsGenerated: z.number().int().nonnegative(),
    commentsRejected: z.number().int().nonnegative(),
    actionsEmitted: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
  })
  .strict();

export const RunSchema = z
  .object({
    runId: IdSchema,
    status: RunStatusSchema,
    startedAt: IsoDateSchema,
    finishedAt: IsoDateSchema.optional(),
    counts: RunCountsSchema,
    errorMessages: z.array(z.string()),
    estimatedResourceConsumption: MetadataSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export const ModelRunRecordSchema = z
  .object({
    modelRunId: IdSchema,
    runId: IdSchema,
    taskId: IdSchema,
    kind: z.string().trim().min(1),
    model: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1),
    status: z.enum(["SUCCEEDED", "FAILED", "LIMITED"]),
    attempts: z.number().int().positive(),
    startedAt: IsoDateSchema,
    finishedAt: IsoDateSchema,
    errorMessage: z.string().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunCounts = z.infer<typeof RunCountsSchema>;
export type Run = z.infer<typeof RunSchema>;
export type ModelRunRecord = z.infer<typeof ModelRunRecordSchema>;

export const RunSummarySchema = z
  .object({
    runId: IdSchema,
    startTime: IsoDateSchema,
    endTime: IsoDateSchema.optional(),
    discovered: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    qualified: z.number().int().nonnegative(),
    generated: z.number().int().nonnegative(),
    passedEvaluator: z.number().int().nonnegative(),
    actionsEmitted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    workerCalls: z.number().int().nonnegative(),
    dryRun: z.boolean(),
  })
  .passthrough();
export type RunSummary = z.infer<typeof RunSummarySchema>;
