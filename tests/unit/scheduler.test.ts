import { describe, expect, it } from "vitest";
import { createRunId, nextCronDelay, runDaemon, validateCronExpression } from "../../src/scheduler";

describe("scheduler safety", () => {
  it("creates distinct run IDs within the same second", () => {
    expect(createRunId()).not.toBe(createRunId());
  });

  it("validates five-field cron expressions", () => {
    expect(validateCronExpression("*/5 * * * *")).toBe("*/5 * * * *");
    expect(() => validateCronExpression("every five minutes")).toThrow();
    expect(() => validateCronExpression("99 * * * *")).toThrow(/outside 0-59/u);
    expect(nextCronDelay("* * * * *", new Date("2026-08-24T00:00:00.000Z"))).toBeGreaterThan(0);
  });

  it("rejects a zero interval instead of entering a tight loop", async () => {
    await expect(runDaemon({ run: async () => { throw new Error("must not run"); } } as never, { intervalMs: 0 })).rejects.toThrow(/positive safe integer/u);
  });

  it("runs the preflight guard before each scheduled cycle", async () => {
    let runs = 0;
    await expect(runDaemon({ run: async () => { runs += 1; throw new Error("must not run"); } } as never, {
      intervalMs: 1,
      beforeRun: () => { throw new Error("kill-switch engaged"); },
    })).rejects.toThrow(/kill-switch engaged/u);
    expect(runs).toBe(0);
  });
});
