import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRuntimeSettings, resolveRuntimeSettings } from "../../src/config";

describe("checked-in runtime safety defaults", () => {
  it("keeps the repository configuration read-only and publishing-disabled", async () => {
    const settings = resolveRuntimeSettings(await loadRuntimeSettings("config"));
    expect(settings.system.execution?.dry_run_by_default).toBe(true);
    expect(settings.system.source?.mode).toBe("live_read_only");
    expect(settings.publishingEnabled).toBe(false);
    expect(settings.system.publisher_bridge?.enabled).toBe(false);
  });

  it("keeps the checked-in command fixture-only", async () => {
    const command = await readFile("command.txt", "utf8");
    const activeLines = command
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(activeLines.join("\n")).not.toMatch(/--publish|--dry-run=false/u);
    expect(activeLines.join("\n")).toContain("--fixture tests/fixtures/moltbook.json");
  });
});
