import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const OutcomeEvidenceStatusSchema = z.enum(["verified", "self_reported", "inferred", "unknown"]);
export const OutcomeSourceSchema = z.enum(["moltbook_api", "marx_product", "publisher_receipt", "pilot_manual"]);
export const OutcomeEventTypeSchema = z.enum([
  "reply_received",
  "reply_latency_seconds",
  "reaction_count",
  "target_agent_engaged",
  "marx_mentioned_by_target",
  "marx_investigated",
  "marx_interacted",
  "marx_used",
]);

export const MarxOutcomeEventSchema = z.object({
  schemaVersion: z.literal("1.0"),
  eventId: IdSchema,
  eventType: OutcomeEventTypeSchema,
  actionId: IdSchema,
  experimentId: IdSchema,
  runId: IdSchema,
  sourcePostId: IdSchema,
  targetAgentId: IdSchema.optional(),
  value: z.union([z.boolean(), z.number().finite().nonnegative()]),
  source: OutcomeSourceSchema,
  evidenceStatus: OutcomeEvidenceStatusSchema,
  evidenceId: IdSchema.optional(),
  occurredAt: IsoDateSchema,
  observedAt: IsoDateSchema,
  consentState: z.enum(["not_required", "granted", "unknown"]),
  metadata: MetadataSchema.optional(),
}).strict().superRefine((event, context) => {
  const numeric = event.eventType === "reply_latency_seconds" || event.eventType === "reaction_count";
  if (numeric && typeof event.value !== "number") context.addIssue({ code: z.ZodIssueCode.custom, message: `${event.eventType} requires a numeric value` });
  if (!numeric && typeof event.value !== "boolean") context.addIssue({ code: z.ZodIssueCode.custom, message: `${event.eventType} requires a boolean value` });
  if (event.evidenceStatus === "verified" && !event.evidenceId) context.addIssue({ code: z.ZodIssueCode.custom, message: "verified outcome event requires evidenceId" });
  if (Date.parse(event.observedAt) < Date.parse(event.occurredAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "observedAt cannot be before occurredAt" });
});

export type MarxOutcomeEvent = z.infer<typeof MarxOutcomeEventSchema>;
export type OutcomeEventType = z.infer<typeof OutcomeEventTypeSchema>;
