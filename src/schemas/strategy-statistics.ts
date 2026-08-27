import { z } from "zod";
import { IdSchema, IsoDateSchema, MetadataSchema, ScoreSchema, StrategyFamilySchema } from "./common";

export const StrategyStatisticsSchema = z
  .object({
    statisticsId: IdSchema,
    strategyFamily: StrategyFamilySchema,
    trials: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    prior: ScoreSchema,
    posterior: ScoreSchema,
    dimensions: MetadataSchema.optional(),
    updatedAt: IsoDateSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .refine((value) => value.successes <= value.trials, { message: "successes cannot exceed trials" });

export type StrategyStatistics = z.infer<typeof StrategyStatisticsSchema>;
