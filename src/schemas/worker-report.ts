import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const WorkerReportSchema = z
  .object({
    reportId: IdSchema,
    runId: IdSchema,
    taskId: IdSchema,
    worker: z.string().trim().min(1),
    status: z.enum(["SUCCEEDED", "PARTIAL", "FAILED"]),
    summary: z.string().trim().min(1),
    findings: z.array(z.string()),
    artifacts: z.array(IdSchema),
    metrics: MetadataSchema.optional(),
    errors: z.array(z.string()),
    createdAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type WorkerReport = z.infer<typeof WorkerReportSchema>;
