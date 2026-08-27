import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const AgentSchema = z.object({
  agentId: IdSchema,
  platform: z.literal("moltbook"),
  name: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  firstSeenAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema,
  metadata: MetadataSchema.optional(),
}).strict();

export type Agent = z.infer<typeof AgentSchema>;
