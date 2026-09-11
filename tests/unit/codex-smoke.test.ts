import { describe, expect, it } from "vitest";
import { DeterministicMockExecutor } from "../../src/models";
import { runCodexModelSmoke } from "../../src/operations";

describe("Codex model smoke check", () => {
  it("returns a structured pass result without publishing side effects", async () => {
    const result = await runCodexModelSmoke({
      executor: new DeterministicMockExecutor({
        maxAttempts: 1,
        handler: async () => ({ status: "ok" }),
      }),
    });

    expect(result).toMatchObject({ status: "PASS", model: "gpt-5.6-luna", attempts: 1 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates model boundary failures for the doctor to report", async () => {
    const executor = new DeterministicMockExecutor({
      maxAttempts: 1,
      handler: async () => { throw new Error("model unavailable"); },
    });

    await expect(runCodexModelSmoke({ executor })).rejects.toThrow("model unavailable");
  });
});
