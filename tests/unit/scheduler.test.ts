import { describe, expect, it } from "vitest";
import { createRunId, nextCronDelay, validateCronExpression } from "../../src/scheduler";

describe("scheduler safety", () => {
  it("creates distinct run IDs within the same second", () => {
    expect(createRunId()).not.toBe(createRunId());
  });

  it("validates five-field cron expressions", () => {
    expect(validateCronExpression("*/5 * * * *")).toBe("*/5 * * * *");
    expect(() => validateCronExpression("every five minutes")).toThrow();
    expect(nextCronDelay("* * * * *", new Date("2026-08-24T00:00:00.000Z"))).toBeGreaterThan(0);
  });
});
