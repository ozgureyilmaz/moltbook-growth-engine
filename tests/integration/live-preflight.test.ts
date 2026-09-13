import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli";
import { MoltbookHttpClient } from "../../src/discovery";

afterEach(() => { vi.restoreAllMocks(); });

describe("live preflight failure boundary", () => {
  it("fails the CLI when a model smoke fails without --autonomous", async () => {
    const output: string[] = [];
    await expect(runCli(["doctor", "--model-smoke"], {
      persistence: {}, stdout: (line) => output.push(line),
      modelSmoke: async () => { throw new Error("model access unavailable"); },
    })).rejects.toThrow("doctor is NOT_READY");
    expect(JSON.parse(output[0]!).checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "codex-real-model-smoke", status: "FAIL" })]));
  });
  it("fails when the public source probe is unavailable", async () => {
    vi.spyOn(MoltbookHttpClient.prototype, "searchPosts").mockRejectedValue(new Error("source unavailable"));
    await expect(runCli(["doctor", "--public-read"], { persistence: {}, stdout: () => undefined })).rejects.toThrow("doctor is NOT_READY");
  });
  it("accepts public reads with no credential check and an engaged publication kill switch", async () => {
    const search = vi.spyOn(MoltbookHttpClient.prototype, "searchPosts").mockResolvedValue([]);
    const auth = vi.spyOn(MoltbookHttpClient.prototype, "checkAuthorization").mockRejectedValue(new Error("must not read credential"));
    const text = await runCli(["doctor", "--public-read"], { persistence: {}, stdout: () => undefined });
    expect(JSON.parse(text).checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "moltbook-public-read", status: "PASS" })]));
    expect(search).toHaveBeenCalledWith("agents", 1);
    expect(auth).not.toHaveBeenCalled();
  });
});
