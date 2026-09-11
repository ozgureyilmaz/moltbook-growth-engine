export type StrategyGenerationBatchOptions = {
  targetActions: number;
  fillTargetActions: boolean;
  batchSize?: number;
  taskBudget?: number;
};

export type StrategyGenerationBatchPlan<T> = {
  batches: T[][];
  budget: number;
};

/**
 * Keep discovery broad while bounding the expensive model-generation stage.
 * Explicit target sets bypass the fill policy and are never expanded.
 */
export function planStrategyGenerationBatches<T>(
  opportunities: readonly T[],
  options: StrategyGenerationBatchOptions,
): StrategyGenerationBatchPlan<T> {
  if (!Number.isSafeInteger(options.targetActions) || options.targetActions < 0) {
    throw new Error("targetActions must be a non-negative integer");
  }
  if (options.targetActions === 0) return { batches: [], budget: 0 };
  const requestedBudget = options.fillTargetActions
    ? options.taskBudget ?? options.targetActions * 2
    : options.targetActions;
  const budget = Math.min(opportunities.length, Math.max(options.targetActions, requestedBudget));
  const batchSize = Math.min(
    budget || options.targetActions,
    Math.max(1, options.batchSize ?? options.targetActions),
  );
  const selected = opportunities.slice(0, budget);
  const batches: T[][] = [];
  for (let index = 0; index < selected.length; index += batchSize) {
    batches.push(selected.slice(index, index + batchSize));
  }
  return { batches, budget };
}
