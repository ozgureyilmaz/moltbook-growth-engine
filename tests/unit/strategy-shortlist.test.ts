import { describe, expect, it } from "vitest";
import { planStrategyGenerationBatches } from "../../src/orchestrator/shortlist";

describe("strategy generation shortlist", () => {
  it("keeps a large discovery pool but dispatches only two five-item batches for five actions", () => {
    const plan = planStrategyGenerationBatches(
      Array.from({ length: 28 }, (_, index) => `opportunity-${index + 1}`),
      { targetActions: 5, fillTargetActions: true },
    );

    expect(plan.batches).toEqual([
      ["opportunity-1", "opportunity-2", "opportunity-3", "opportunity-4", "opportunity-5"],
      ["opportunity-6", "opportunity-7", "opportunity-8", "opportunity-9", "opportunity-10"],
    ]);
    expect(plan.budget).toBe(10);
  });

  it("does not expand an explicit bounded action set", () => {
    const plan = planStrategyGenerationBatches(
      ["opportunity-1", "opportunity-2", "opportunity-3"],
      { targetActions: 5, fillTargetActions: false },
    );

    expect(plan.batches).toEqual([["opportunity-1", "opportunity-2", "opportunity-3"]]);
    expect(plan.budget).toBe(3);
  });
});
