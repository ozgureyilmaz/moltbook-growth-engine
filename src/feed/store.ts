import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type SqliteDatabase } from "../persistence/database";
import { FeedItemSchema, type FeedItem } from "./source";

export type FeedRecord = {
  feed_id: string; source_url: string; published_at: string; status: string;
  claim_id: string | null; run_id: string | null; result_json: string | null;
  updated_at: string;
  runner_pid: number | null; runner_host: string | null;
};

export class FeedStore {
  constructor(private readonly db: SqliteDatabase) {}

  private transaction<T>(work: () => T): T {
    // Acquire the writer lock before reading claim state across independent processes.
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  scan(input: FeedItem[], firstRun: "baseline" | "latest", now = new Date().toISOString()): { initialized: boolean; discovered: number } {
    const items = input.map((item) => FeedItemSchema.parse(item));
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Duplicate feed IDs in snapshot");
    return this.transaction(() => {
      const initialized = !this.db.prepare("SELECT stream_id FROM marx_feed_stream WHERE stream_id = 'marx'").get();
      const latest = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))[0]?.id;
      let discovered = 0;
      for (const item of items) {
        const status = initialized && !(firstRun === "latest" && item.id === latest) ? "baseline" : "pending";
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO marx_feed_queue
          (feed_id, source_url, published_at, status, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
          item.id, `https://marx.finance/feed/${item.id}`, item.createdAt, status, now,
        );
        if (status === "pending") discovered += inserted.changes;
      }
      this.db.prepare(`INSERT INTO marx_feed_stream (stream_id, initialized_at, last_checked_at)
        VALUES ('marx', ?, ?) ON CONFLICT(stream_id) DO UPDATE SET last_checked_at=excluded.last_checked_at`).run(now, now);
      return { initialized, discovered };
    });
  }

  list(): FeedRecord[] {
    return this.db.prepare("SELECT * FROM marx_feed_queue ORDER BY published_at DESC, feed_id").all<FeedRecord>();
  }

  claim(now = new Date().toISOString(), publish = false): FeedRecord | undefined {
    return this.transaction(() => {
      const blocker = this.db.prepare("SELECT feed_id, status FROM marx_feed_queue WHERE status IN ('running', 'review_required') LIMIT 1").get<FeedRecord>();
      if (blocker) throw new Error(`FEED_REVIEW_REQUIRED_OR_RUNNING: ${blocker.feed_id}; inspect marx-feed-status before resolving`);
      const row = this.db.prepare("SELECT * FROM marx_feed_queue WHERE status = 'pending' ORDER BY published_at ASC, feed_id LIMIT 1").get<FeedRecord>();
      if (!row) return undefined;
      const claimId = randomUUID();
      const runId = `specific_feed_${claimId.replaceAll("-", "")}`;
      const change = this.db.prepare("UPDATE marx_feed_queue SET status='running', claim_id=?, run_id=?, runner_pid=?, runner_host=?, result_json=?, updated_at=? WHERE feed_id=? AND status='pending'")
        .run(claimId, runId, process.pid, hostname(), JSON.stringify({ mode: publish ? "publish" : "draft" }), now, row.feed_id);
      if (change.changes !== 1) throw new Error("Feed claim lost to another worker");
      return { ...row, status: "running", claim_id: claimId, run_id: runId, runner_pid: process.pid, runner_host: hostname(), updated_at: now };
    });
  }

  finish(claim: FeedRecord, status: "completed" | "review_required", result: unknown, runId?: string): void {
    const changes = this.db.prepare(`UPDATE marx_feed_queue SET status=?, result_json=?, run_id=?, updated_at=?
      WHERE feed_id=? AND claim_id=? AND status='running'`).run(status, JSON.stringify(result), runId ?? claim.run_id, new Date().toISOString(), claim.feed_id, claim.claim_id);
    if (changes.changes !== 1) throw new Error("Feed completion lost its claim");
  }

  resolve(feedId: string, claimId: string, resolution: "retry" | "skip", reason: string): void {
    if (!reason.trim() || reason.length > 2000) throw new Error("Resolution requires a reason of 1-2000 characters");
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM marx_feed_queue WHERE feed_id=? AND claim_id=?").get<FeedRecord>(feedId, claimId);
      if (!row || !["running", "review_required"].includes(row.status)) throw new Error("No matching unresolved feed claim");
      if (row.status === "running") {
        if (row.runner_host !== hostname() || !row.runner_pid) throw new Error("Cannot verify that the original feed worker has stopped");
        let alive = true;
        try { process.kill(row.runner_pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw new Error("Original feed worker is still running; stop and reconcile it first");
      }
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO marx_feed_resolutions (resolution_id,feed_id,claim_id,resolution,reason,resolved_at) VALUES (?,?,?,?,?,?)")
        .run(randomUUID(), feedId, claimId, resolution, reason.trim(), now);
      this.db.prepare("UPDATE marx_feed_queue SET status=?, updated_at=? WHERE feed_id=? AND claim_id=?")
        .run(resolution === "retry" ? "pending" : "skipped", now, feedId, claimId);
    });
  }
}
