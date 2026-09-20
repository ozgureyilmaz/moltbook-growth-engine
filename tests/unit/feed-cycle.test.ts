import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../../src/persistence/migrations";
import type { SqliteDatabase } from "../../src/persistence/database";
import { FeedStore } from "../../src/feed/store";
import { fetchMarxFeed, type FeedConfig } from "../../src/feed/source";
import { runFeedCycle } from "../../src/feed/cycle";
import { runCli } from "../../src/cli";
import { runFeedCli } from "../../src/feed/cli";
import { loadRuntimeSettings, resolveRuntimeSettings } from "../../src/config";

const config: FeedConfig = { config_version: 1, first_run: "baseline", max_pages: 3, request_timeout_ms: 1000, max_response_bytes: 10000 };
const old = { id: "old", createdAt: "2026-09-10T00:00:00.000Z" };
const fresh = { id: "fresh", createdAt: "2026-09-13T00:00:00.000Z" };
const dbs: Database.Database[] = [];
function store(path = ":memory:") {
  const db = new Database(path);
  dbs.push(db);
  applyMigrations(db as unknown as SqliteDatabase);
  return new FeedStore(db as unknown as SqliteDatabase);
}
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); vi.unstubAllEnvs(); });
function page(data = [old], current = 1, pages = 1, total = data.length) {
  return { data, pagination: { page: current, pages, total, limit: pages > 1 ? 1 : 20 } };
}
const successful = (id: string, actions: string[] = ["action-1"], published = false) => JSON.stringify({
  runId: "specific-test", summary: { errors: 0 }, article: { articleId: id, sourceUrl: `https://marx.finance/feed/${id}` },
  actionIds: actions, records: actions.map((actionId) => ({ actionId, publicationStatus: published ? "PUBLISHED" : "DRY_RUN" })), outputPath: "docs/moltbook-runs/test.md",
});

describe("Marx public feed adapter", () => {
  it("uses the fixed public endpoint and validates all pages, sorting independently of pins", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page([old], 1, 2, 2))).mockResolvedValueOnce(Response.json(page([fresh], 2, 2, 2)));
    expect(await fetchMarxFeed(config, fetcher)).toEqual([fresh, old]);
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://marx.finance/api/posts?sort=new&page=2", expect.objectContaining({ redirect: "error" }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("credentials");
  });
  it.each([
    page([{ ...old, id: "../../evil" }]),
    page([{ ...old, createdAt: "yesterday" }]),
    page([old], 1, 4, 80),
    page([old], 1, 1, 2),
    page([old, old]),
    { data: [] },
  ])("rejects malformed or incomplete listings", async (value) => {
    await expect(fetchMarxFeed(config, vi.fn().mockResolvedValue(Response.json(value)))).rejects.toThrow();
  });
  it("does not accept changed pagination as a complete scan", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page([old], 1, 2, 2))).mockResolvedValueOnce(Response.json(page([fresh], 2, 3, 3)));
    await expect(fetchMarxFeed(config, fetcher)).rejects.toThrow(/changed/);
  });
  it("bounds response bytes and rejects HTTP errors", async () => {
    await expect(fetchMarxFeed(config, vi.fn().mockResolvedValue(new Response("x".repeat(10001))))).rejects.toThrow(/byte limit/);
    await expect(fetchMarxFeed(config, vi.fn().mockResolvedValue(new Response("", { status: 429 })))).rejects.toThrow(/429/);
  });
});

describe("durable feed cycle", () => {
  it("baselines first poll, passes the new canonical URL, and never reruns completed feeds", async () => {
    const db = store();
    const execute = vi.fn().mockResolvedValue(successful(fresh.id));
    const fetchFeed = vi.fn().mockResolvedValueOnce([old]).mockResolvedValue([fresh, old]);
    const input = { store: db, config, fetchFeed, execute };
    expect(await runFeedCycle(input)).toMatchObject({ status: "BASELINED" });
    expect(execute).not.toHaveBeenCalled();
    expect(await runFeedCycle(input)).toMatchObject({ status: "COMPLETED", sourceUrl: "https://marx.finance/feed/fresh" });
    expect(await runFeedCycle(input)).toMatchObject({ status: "NO_NEW_FEED" });
    expect(execute).toHaveBeenCalledExactlyOnceWith("https://marx.finance/feed/fresh", expect.stringMatching(/^specific_feed_/u));
  });
  it("can explicitly process only the newest existing feed at bootstrap", async () => {
    const db = store();
    const execute = vi.fn().mockResolvedValue(successful(fresh.id));
    await runFeedCycle({ store: db, config: { ...config, first_run: "latest" }, fetchFeed: async () => [old, fresh], execute });
    expect(execute).toHaveBeenCalledExactlyOnceWith("https://marx.finance/feed/fresh", expect.stringMatching(/^specific_feed_/u));
    expect(db.list().find((r) => r.feed_id === old.id)?.status).toBe("baseline");
  });
  it("check-only enqueues without consuming and processes one queued item each cycle", async () => {
    const db = store(); db.scan([], "baseline");
    const execute = vi.fn().mockResolvedValue(successful(old.id));
    const input = { store: db, config, fetchFeed: async () => [fresh, old], execute };
    await runFeedCycle({ ...input, checkOnly: true });
    expect(execute).not.toHaveBeenCalled();
    await runFeedCycle(input);
    expect(db.list().find((r) => r.feed_id === fresh.id)?.status).toBe("pending");
  });
  it("a failed scan does not initialize or move state", async () => {
    const db = store();
    await expect(runFeedCycle({ store: db, config, fetchFeed: async () => { throw new Error("HTTP 500"); }, execute: vi.fn() })).rejects.toThrow();
    expect(db.scan([old], "baseline").initialized).toBe(true);
    expect(db.list()[0]?.status).toBe("baseline");
  });
  it.each(["throw", "malformed", "wrong-article", "partial-publish"])("blocks automatic retry after %s", async (mode) => {
    const db = store(); db.scan([], "baseline");
    const execute = vi.fn(async () => {
      if (mode === "throw") throw new Error("provider secret must not reach ledger");
      if (mode === "malformed") return "invalid";
      return successful(mode === "wrong-article" ? "other" : fresh.id);
    });
    const input = { store: db, config, fetchFeed: async () => [fresh], execute, publish: mode === "partial-publish" };
    await expect(runFeedCycle(input)).rejects.toThrow(/FEED_REVIEW_REQUIRED/);
    await expect(runFeedCycle(input)).rejects.toThrow(/FEED_REVIEW_REQUIRED_OR_RUNNING/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.list()[0]?.result_json).not.toContain("secret");
  });
  it("completes zero-action dry runs as decisions, without representing them as publications", async () => {
    const db = store(); db.scan([], "baseline");
    expect(await runFeedCycle({ store: db, config, fetchFeed: async () => [fresh], execute: async () => successful(fresh.id, []) })).toMatchObject({ status: "COMPLETED", mode: "draft", actionIds: [] });
  });
  it("retains a running claim across restart and excludes a second DB connection", () => {
    const directory = mkdtempSync(join(tmpdir(), "feed-lock-test-"));
    try {
      const path = join(directory, "state.sqlite");
      const first = store(path); first.scan([fresh], "latest");
      first.claim();
      const second = store(path);
      expect(() => second.claim()).toThrow(/RUNNING/);
      for (const db of dbs) if (db.open) db.close();
      expect(() => store(path).claim()).toThrow(/RUNNING/);
    } finally { for (const db of dbs) if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("refuses completion from a stale or wrong claim", () => {
    const db = store(); db.scan([fresh], "latest"); const claim = db.claim()!;
    expect(() => db.finish({ ...claim, claim_id: "wrong" }, "completed", {})).toThrow(/lost its claim/);
  });
  it("requires an exact failed claim for explicit recovery and refuses live running recovery", () => {
    const db = store(); db.scan([fresh], "latest"); const claim = db.claim()!;
    expect(claim.run_id).toMatch(/^specific_feed_/u);
    expect(() => db.resolve(fresh.id, claim.claim_id!, "retry", "reviewed")).toThrow(/still running/);
    db.finish(claim, "review_required", { reason: "test" });
    expect(() => db.resolve(fresh.id, "wrong", "retry", "reviewed")).toThrow(/No matching/);
    db.resolve(fresh.id, claim.claim_id!, "retry", "Verified no external write occurred");
    const retried = db.claim()!;
    expect(retried.claim_id).not.toBe(claim.claim_id);
    db.finish(retried, "review_required", {});
    db.resolve(fresh.id, retried.claim_id!, "skip", "Reconciled an existing publication");
    expect(db.list()[0]?.status).toBe("skipped");
    expect(db.claim()).toBeUndefined();
  });
});

describe("feed CLI integration", () => {
  it("passes the new URL, durable run ID and requested flags to the existing specific command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "feed-dispatch-test-"));
    vi.stubEnv("MARX_GROWTH_DB", join(directory, "state.sqlite"));
    try {
      const settings = resolveRuntimeSettings(await loadRuntimeSettings());
      const execute = vi.fn(async (args, deps) => {
        expect(args).toEqual(expect.arrayContaining(["marx-specific-cycle", "--article-url", "https://marx.finance/feed/fresh", "--real-model", "--actions=5"]));
        expect(deps.specificCycleRunId).toMatch(/^specific_feed_/u);
        expect(deps.persistence).toBeDefined();
        return successful(fresh.id);
      });
      const result = await runFeedCli({ command: "marx-feed-cycle", options: { bootstrap: "latest", actions: "5" }, positional: [] }, settings, { stdout: () => undefined, feedSource: async () => [fresh] }, execute);
      expect(JSON.parse(result)).toMatchObject({ status: "COMPLETED", decision: "DRAFTED", mode: "draft" });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects mock evaluation for a publishing cycle before checking feeds", async () => {
    const feedSource = vi.fn();
    await expect(runCli(["marx-feed-cycle", "--publish", "--real-model=false"], { stdout: () => undefined, feedSource })).rejects.toThrow(/requires real-model/);
    expect(feedSource).not.toHaveBeenCalled();
  });
  it("baselines and reports status through the actual CLI without invoking Moltbook", async () => {
    const directory = mkdtempSync(join(tmpdir(), "feed-cli-test-"));
    vi.stubEnv("MARX_GROWTH_DB", join(directory, "state.sqlite"));
    try {
      const deps = { stdout: () => undefined, feedSource: async () => [fresh] };
      expect(JSON.parse(await runCli(["marx-feed-check"], deps))).toMatchObject({ status: "CHECKED", initialized: true });
      expect(JSON.parse(await runCli(["marx-feed-cycle"], deps))).toMatchObject({ status: "NO_NEW_FEED" });
      expect(JSON.parse(await runCli(["marx-feed-status"], deps)).feeds[0]).toMatchObject({ feed_id: fresh.id, status: "baseline" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
