import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { livePlan } from "../../scripts/live.mjs";
import { assertNode, findNode22 } from "../../scripts/runtime.mjs";
import { hermesConfig, shellQuote } from "../../scripts/setup-hermes.mjs";
import { checkPublisherFiles, publisherRuntime } from "../../src/operations/publisher-runtime";
import { resolveCodexBinary } from "../../src/models/codex";

const article = "https://marx.finance/feed/example123";

describe("operator entry points", () => {
  it("uses the same configured Codex executable for real workflow calls", () => {
    expect(resolveCodexBinary({ env: { MARX_GROWTH_CODEX_BIN: "/tmp/team/codex" } })).toBe("/tmp/team/codex");
    expect(resolveCodexBinary({ binary: "/tmp/explicit/codex", env: { MARX_GROWTH_CODEX_BIN: "/tmp/ignored" } })).toBe("/tmp/explicit/codex");
    expect(resolveCodexBinary({ env: {} })).toBe("codex");
  });
  it("rejects runtime ABI changes before installing or running", () => {
    expect(() => assertNode("22.17.0")).not.toThrow();
    for (const version of ["20.19.0", "24.1.0", "26.8.1"]) expect(() => assertNode(version)).toThrow("Node 22");
  });
  it("forces actual models and read-only article workflow in the default live command", () => {
    const plan = livePlan(["--article-url", article]);
    expect(plan.publish).toBe(false);
    expect(plan.doctor).toEqual(["doctor", "--public-read", "--article-url", article, "--model-smoke"]);
    expect(plan.run[0]).toBe("article-run");
    expect(plan.run).toContain("--real-model");
    expect(plan.run).toContain("--dry-run");
    expect(plan.run).not.toContain("--publish");
  });
  it("accepts copied Markdown links without changing the destination", () => {
    const plan = livePlan(["--article-url", `[${article}](${article})`]);
    expect(plan.doctor).toContain(article);
    expect(plan.run).toContain(article);
    expect(plan.run).not.toContain(`[${article}](${article})`);
  });
  it("rejects deceptive Markdown destinations and malformed feed IDs", () => {
    for (const input of [`[${article}](https://evil.example/feed/a)`, `[https://marx.finance/feed/different](${article})`, `${article}é`, `[${article}](${article}`, `${article}\n--publish`]) {
      expect(() => livePlan(["--article-url", input])).toThrow();
    }
  });
  it("selects only a verified Node 22 executable when another major is active", () => {
    const env = { MARX_GROWTH_NODE: "/team/node22", PATH: "/other/bin" };
    expect(findNode22({ env, home: "/nonexistent-team-home", execPath: "/current/node", version: "26.8.1", probe: (path: string) => path === "/team/node22" })).toBe("/team/node22");
    expect(findNode22({ env, home: "/nonexistent-team-home", version: "26.8.1", probe: () => false })).toBeUndefined();
    expect(findNode22({ env, execPath: "/current/node22", version: "22.17.0", probe: () => { throw new Error("unnecessary probe"); } })).toBe("/current/node22");
  });
  it("requires all production preflights for explicit publication", () => {
    const plan = livePlan(["--article-url", article, "--publish", "--actions", "1"]);
    expect(plan.doctor).toEqual(expect.arrayContaining(["--autonomous", "--publisher", "--live-read", "--model-smoke"]));
    expect(plan.run[0]).toBe("marx-specific-cycle");
    expect(plan.run).toContain("--publish");
  });
  it("uses directory output consistently for both live modes", () => {
    expect(livePlan(["--article-url", article, "--publish", "--output", "team reports"]).run).toContain("team reports/");
    expect(livePlan(["--article-url", article, "--output", "team reports/review.md"]).run).toContain("team reports/review.md");
  });
  it("forwards verified Marx agent quote mode to publication", () => {
    const plan = livePlan(["--article-url", article, "--publish", "--with-agent-quotes"]);
    expect(plan.run).toContain("--with-agent-quotes");
    expect(plan.run).not.toContain("--no-agent-quotes");
  });
  it.each([
    ["--real-model=false"], ["--dry-run=false"], ["--fixture", "x"], ["--publish=false"],
    ["--actions", "0"], ["--actions", "1.5"], ["--actions", "2", "--actions", "3"],
    ["--publisher-script", "untrusted.py"], ["--limit"],
  ])("rejects unsafe, ambiguous or unsupported forwarded flags: %j", (...args) => {
    expect(() => livePlan(["--article-url", article, ...args])).toThrow();
  });
  it("rejects off-origin or credential-bearing article URLs", () => {
    for (const url of ["http://marx.finance/feed/a", "https://evil.example/feed/a", "https://user:secret@marx.finance/feed/a"]) {
      expect(() => livePlan(["--article-url", url])).toThrow();
    }
  });
  it("keeps shell metacharacters literal in generated path exports", () => {
    const value = "/tmp/team's $(echo injected) `echo injected` folder";
    const output = execFileSync("/bin/sh", ["-c", `TEST_LOCAL_PATH=${shellQuote(value)}; printf '%s' "$TEST_LOCAL_PATH"`], { encoding: "utf8" });
    expect(output).toBe(value);
  });
  it("generates configuration using only this clone's paths", () => {
    const config = hermesConfig("team_agent", "/tmp/team clone");
    expect(config.project_dir).toBe("/tmp/team clone");
    expect(config.pending_dir).toBe("/tmp/team clone/outbox/pending");
    expect(config.allowed_domains).toEqual(["www.moltbook.com"]);
    expect(JSON.stringify(config)).not.toContain("/Users/0x79de");
  });
  it("uses the operator Hermes home and respects explicit overrides", () => {
    const runtime = publisherRuntime({}, { HERMES_HOME: "/tmp/team hermes" });
    expect(runtime.script.startsWith("/tmp/team hermes/")).toBe(true);
    expect(runtime.python).toBe("python3");
    expect(publisherRuntime({ "publisher-script": "/tmp/explicit.py" }, {}).script).toBe("/tmp/explicit.py");
  });
  it("rejects mismatched publisher outboxes without running a script", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marx-publisher-config-"));
    const runtime = { python: "must-not-run", script: join(directory, "publisher.py"), config: join(directory, "config.json") };
    try {
      await writeFile(runtime.script, "raise RuntimeError('must not run')");
      await writeFile(runtime.config, JSON.stringify(hermesConfig("team_agent", directory)));
      await expect(checkPublisherFiles(runtime, {}, directory)).resolves.toBeUndefined();
      await expect(checkPublisherFiles(runtime, { publisher_bridge: { contract_keychain_account: "different-contract" } }, directory)).rejects.toThrow("contract_keychain_account");
      await expect(checkPublisherFiles(runtime, { publishing: { outbox: { pending_path: "other-outbox" } } }, directory)).rejects.toThrow("pending_dir");
      await writeFile(runtime.config, JSON.stringify({ ...hermesConfig("team_agent", directory), allowed_domains: ["evil.example"] }));
      await expect(checkPublisherFiles(runtime, {}, directory)).rejects.toThrow("allowed_domains");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
