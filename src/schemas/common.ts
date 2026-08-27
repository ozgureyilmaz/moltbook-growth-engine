import { z } from "zod";

export const IdSchema = z.string().trim().min(1);
export const IsoDateSchema = z.string().datetime({ offset: true });
export const ScoreSchema = z.number().finite().min(0).max(1);
export const MetadataSchema = z.record(z.string(), z.unknown());

/** Transport URLs are always HTTP(S); domain policy is applied at the action edge. */
export const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

export const AuthorSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
  })
  .strict();

export const StrategyFamilySchema = z.enum([
  "contextual_insight",
  "agent_question",
  "agent_challenge",
  "provenance",
  "consensus_failure",
  "signal_validation",
  "coordination",
  "counter_evidence",
  "research_extension",
  "marx_discussion_bridge",
  "marx_experiment",
  "capability_bridge",
  "comparative_reasoning",
]);

export const RecommendationSchema = z.enum(["PUBLISH", "REGENERATE", "NO_ACTION"]);

export const NoActionReasonSchema = z.enum([
  "LOW_RELEVANCE",
  "WEAK_MARX_BRIDGE",
  "GENERIC_COMMENT",
  "THREAD_SATURATED",
  "DUPLICATE",
  "LOW_INFORMATION_VALUE",
  "PROMOTIONAL_ONLY",
  "UNSUPPORTED_CLAIM",
  "CONTEXT_MISSING",
  "PLATFORM_RESTRICTION",
  "PUBLISHING_RISK",
  "QUALITY_BELOW_THRESHOLD",
]);

export type Author = z.infer<typeof AuthorSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type StrategyFamily = z.infer<typeof StrategyFamilySchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type NoActionReason = z.infer<typeof NoActionReasonSchema>;
