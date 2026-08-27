import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { LocalOutbox, makeActionPayload } from "../../src/outbox";
import { fixturePost, FixtureMoltbookSource } from "../../src/discovery";
import { buildConversationContext } from "../../src/context";
import { scoreOpportunity } from "../../src/analysis";
import { generateCandidates } from "../../src/generation";
import { IndependentMockEvaluator } from "../../src/evaluation";

describe("validated local outbox", () => {
  it("is idempotent for the same action id", async () => {
    const root = "/tmp/moltbook-growth-outbox-unit";
    await rm(root, { recursive: true, force: true });
    const post = fixturePost({ postId: "outbox-post", submolt: "markets", content: "Agents should validate a trading signal with independent evidence." });
    const source = new FixtureMoltbookSource({ posts: [post] });
    const context = buildConversationContext(await source.fetchPostContext(post.postId));
    const opportunity = scoreOpportunity(post, context, { now: post.createdAt });
    const candidate = generateCandidates(opportunity, ["provenance"])[0]!;
    const evaluation = await new IndependentMockEvaluator().evaluate(candidate, context);
    const action = makeActionPayload("run_outbox", opportunity, candidate, evaluation);
    const outbox = new LocalOutbox(root);
    expect((await outbox.enqueue(action)).written).toBe(true);
    expect((await outbox.enqueue(action)).written).toBe(false);
    expect((await outbox.listPending()).map((entry) => entry.payload.actionId)).toEqual([action.actionId]);
  });
});
