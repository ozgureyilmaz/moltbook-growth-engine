import { z } from "zod";
import { FeedStore } from "./store";
import { type FeedConfig, type FeedItem } from "./source";

const CycleResultSchema = z.object({
  runId: z.string().min(1),
  summary: z.object({ errors: z.literal(0) }),
  article: z.object({ articleId: z.string(), sourceUrl: z.string() }),
  actionIds: z.array(z.string()),
  records: z.array(z.object({ actionId: z.string(), publicationStatus: z.string() })),
  outputPath: z.string().min(1),
});

export async function runFeedCycle(input: {
  store: FeedStore;
  config: FeedConfig;
  fetchFeed: () => Promise<FeedItem[]>;
  checkOnly?: boolean;
  publish?: boolean;
  execute: (sourceUrl: string, runId: string) => Promise<string>;
}): Promise<unknown> {
  // Persist nothing from a partial/invalid listing. The next scheduled poll is the bounded retry.
  const snapshot = await input.fetchFeed();
  const scan = input.store.scan(snapshot, input.config.first_run);
  if (input.checkOnly) return { status: "CHECKED", ...scan };
  const claim = input.store.claim(undefined, input.publish);
  if (!claim) return { status: scan.initialized ? "BASELINED" : "NO_NEW_FEED", ...scan };
  try {
    const result = CycleResultSchema.parse(JSON.parse(await input.execute(claim.source_url, claim.run_id!)) as unknown);
    if (result.article.articleId !== claim.feed_id || result.article.sourceUrl !== claim.source_url) throw new Error("Feed cycle returned a different article");
    const actionIds = new Set(result.actionIds);
    if (actionIds.size !== result.actionIds.length || new Set(result.records.map((r) => r.actionId)).size !== result.records.length || result.records.length !== actionIds.size || result.records.some((r) => !actionIds.has(r.actionId))) {
      throw new Error("Feed cycle records do not match action IDs");
    }
    if (input.publish && (result.actionIds.length === 0 || result.records.length !== result.actionIds.length || result.records.some((r) => r.publicationStatus !== "PUBLISHED"))) {
      throw new Error("Feed cycle publication was not fully verified");
    }
    const evidence = { runId: result.runId, outputPath: result.outputPath, actionIds: result.actionIds, mode: input.publish ? "publish" : "draft", decision: result.actionIds.length === 0 ? "NO_ACTION" : input.publish ? "PUBLISHED" : "DRAFTED" };
    input.store.finish(claim, "completed", evidence, result.runId);
    return { status: "COMPLETED", feedId: claim.feed_id, sourceUrl: claim.source_url, ...scan, ...evidence };
  } catch (error) {
    const runId = error && typeof error === "object" && "runId" in error && typeof error.runId === "string" ? error.runId : undefined;
    // Raw child errors can contain credential/provider data; keep only controlled metadata here.
    input.store.finish(claim, "review_required", { reason: "CYCLE_FAILED_OR_UNVERIFIED", claimId: claim.claim_id }, runId);
    throw new Error(`FEED_REVIEW_REQUIRED: ${claim.feed_id}; inspect cycle logs and receipts before retrying`);
  }
}
