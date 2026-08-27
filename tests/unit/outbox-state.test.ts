import { describe, expect, it } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import { makeActionPayload, LocalOutbox, validateActionPayload } from "../../src/outbox";
import { fixturePost, FixtureMoltbookSource } from "../../src/discovery";
import { buildConversationContext } from "../../src/context";
import { scoreOpportunity } from "../../src/analysis";
import { generateCandidates } from "../../src/generation";
import { IndependentMockEvaluator } from "../../src/evaluation";

async function actionFixture() {
  const post = fixturePost({ postId: "outbox-state-post", submolt: "markets", content: "Agents should validate a trading signal with independent evidence." });
  const source = new FixtureMoltbookSource({ posts: [post] });
  const context = buildConversationContext(await source.fetchPostContext(post.postId));
  const opportunity = scoreOpportunity(post, context, { now: post.createdAt });
  const candidate = generateCandidates(opportunity, ["provenance"])[0]!;
  const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
  return makeActionPayload("outbox-state-run", opportunity, candidate, evaluation);
}

describe("durable outbox state", () => {
  it("deduplicates acknowledged and failed actions and makes retries explicit and bounded", async () => {
    const root = "/tmp/moltbook-growth-outbox-state-unit";
    await rm(root, { recursive: true, force: true });
    const action = await actionFixture();
    const outbox = new LocalOutbox(root, { mode: "fixture", maxAttempts: 2 });

    expect((await outbox.enqueue(action)).written).toBe(true);
    expect(await outbox.fail(action.actionId, "temporary", { code: "TEMP" })).toBe(true);
    expect((await outbox.enqueue(action)).written).toBe(false);
    expect((await outbox.listPending())).toHaveLength(0);
    expect(await outbox.retry(action.actionId)).toBe(true);
    expect((await outbox.listPending())).toHaveLength(1);
    expect(await outbox.acknowledge(action.actionId)).toBe(true);
    expect((await outbox.enqueue(action)).written).toBe(false);
    expect((await outbox.getState(action.actionId))?.status).toBe("ACKNOWLEDGED");

    const bounded = await actionFixture();
    const boundedOutbox = new LocalOutbox(`${root}-bounded`, { mode: "fixture", maxAttempts: 1 });
    await boundedOutbox.enqueue(bounded);
    await boundedOutbox.fail(bounded.actionId, "permanent");
    expect(await boundedOutbox.retry(bounded.actionId)).toBe(false);
    expect((await boundedOutbox.getState(bounded.actionId))?.attemptCount).toBe(1);
  });

  it("enforces HTTP(S) and production allow-list URL policy", async () => {
    const action = await actionFixture();
    expect(validateActionPayload({ ...action, target: { ...action.target, postUrl: "javascript:alert(1)" } }, { mode: "production", allowedDomains: ["moltbook.example"] })).toBe(false);
    expect(validateActionPayload({ ...action, target: { ...action.target, postUrl: "https://moltbook.example/post/1" } }, { mode: "production", allowedDomains: ["moltbook.example"] })).toBe(true);
    expect(validateActionPayload({ ...action, target: { ...action.target, postUrl: "https://unapproved.example/post/1" } }, { mode: "production", allowedDomains: ["moltbook.example"] })).toBe(false);
    expect(validateActionPayload({ ...action, target: { ...action.target, postUrl: "http://localhost/post/1" } }, { mode: "production", allowedDomains: ["localhost"] })).toBe(false);
  });

  it("atomically deduplicates concurrent enqueues and leaves no temporary files", async () => {
    const root = "/tmp/moltbook-growth-outbox-concurrent-unit";
    await rm(root, { recursive: true, force: true });
    const action = await actionFixture();
    const outbox = new LocalOutbox(root, { mode: "fixture" });
    const results = await Promise.all(Array.from({ length: 8 }, () => outbox.enqueue(action)));
    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect(await outbox.listPending()).toHaveLength(1);
    const pendingNames = await readdir(`${root}/pending`);
    expect(pendingNames.some((name) => name.endsWith(".tmp"))).toBe(false);
    const state = await outbox.getState(action.actionId);
    expect(state).toMatchObject({ status: "PENDING", runId: "outbox-state-run", sourcePostId: "outbox-state-post", attemptCount: 0 });
    expect(state?.idempotencyKey).toBeTruthy();
    expect(state?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    const stored = JSON.parse(await readFile(`${root}/pending/${action.actionId}.json`, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ schema_version: "1.0", action_id: action.actionId });
    expect(stored).not.toHaveProperty("schemaVersion");
  });
});
