import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FixtureMoltbookSource } from "../../src/discovery";
import { buildConversationContext } from "../../src/context";
import {
  duplicateCommentTest,
  runDeterministicQA,
  standaloneMarketingTest,
  threadAngleSaturatedTest,
  unsupportedClaimTest,
} from "../../src/evaluation/deterministic";
import type { GeneratedCandidate } from "../../src/orchestrator";

type Matrix = ConstructorParameters<typeof FixtureMoltbookSource>[0];

const matrixPath = new URL("../fixtures/eval-matrix.json", import.meta.url);

const comments: Record<string, string> = {
  "eval-strong-marx": "For this liquidity signal, Marx could give the agent a provenance ledger to compare sources before acting.",
  "eval-weak-marx": "Marx could help agents think about a useful approach here.",
  "eval-unrelated": "Marx could help agents think about this terminal theme.",
  "eval-generic-finance": "Great post! Marx is the future of agent-native finance.",
  "eval-multi-agent": "For conflicting research signals, Marx could help each agent expose which evidence it used before coordination.",
  "eval-provenance": "Because the provenance record tracks each model source, Marx could help agents compare what evidence changed the conclusion.",
  "eval-signal": "For this reliable signal, Marx could help an agent test false positives against the validation evidence before acting.",
  "eval-injection": "For this evidence question, Marx could help agents compare sources before deciding.",
  "eval-saturated": "Marx could help document provenance for this market signal.",
  "eval-duplicate": "The evidence provenance question is worth testing: Marx could help agents compare sources before a market decision.",
  "eval-promo": "Check out Marx and sign up for the real unlock in agent finance.",
  "eval-unsupported": "For this trading signal, Marx guarantees profit and never loses.",
  "eval-low-info": "Marx could help agents think about this.",
  "eval-unsafe-url": "For this evidence provenance question, Marx could help agents compare sources before acting.",
};

function candidate(postId: string, comment: string): GeneratedCandidate {
  return {
    candidateId: `candidate-${postId}`,
    opportunityId: `opportunity-${postId}`,
    strategyFamily: "provenance",
    hookFamily: "specific_claim",
    comment,
    promptVersion: "v1",
    modelVersion: "fixture",
  };
}

describe("deterministic evaluation matrix", () => {
  it("covers publish, regenerate, and no-action safety cases without treating source text as instructions", async () => {
    const fixture = JSON.parse(await readFile(matrixPath, "utf8")) as Matrix;
    const source = new FixtureMoltbookSource(fixture);
    const publishCases = new Set(["eval-strong-marx", "eval-multi-agent", "eval-provenance", "eval-signal"]);
    const regenerateOrRejectCases = new Set(["eval-weak-marx", "eval-unrelated", "eval-generic-finance", "eval-injection", "eval-promo", "eval-unsupported", "eval-low-info"]);
    for (const post of fixture.posts) {
      const context = buildConversationContext(await source.fetchPostContext(post.postId));
      const qa = runDeterministicQA(candidate(post.postId, comments[post.postId]!), context);
      if (publishCases.has(post.postId)) expect(qa.passed, post.postId).toBe(true);
      if (regenerateOrRejectCases.has(post.postId)) expect(qa.passed, post.postId).toBe(false);
      if (post.postId === "eval-injection") expect(qa.reasons).toContain("PROMPT_INJECTION_IN_CONTEXT");
      if (post.postId === "eval-generic-finance" || post.postId === "eval-promo") expect(qa.reasons).toContain("GENERIC_COMMENT");
      if (post.postId === "eval-unsupported") expect(qa.reasons).toContain("UNSUPPORTED_CLAIM");
      if (post.postId === "eval-low-info") expect(qa.reasons).toContain("CONTEXTUAL_ANCHOR_MISSING");
    }
  });

  it("rejects saturation, duplicates, unsafe links, and marketing that only works without context", async () => {
    const fixture = JSON.parse(await readFile(matrixPath, "utf8")) as Matrix;
    const source = new FixtureMoltbookSource(fixture);
    const saturated = buildConversationContext(await source.fetchPostContext("eval-saturated"));
    expect(saturated.saturated).toBe(true);
    expect(threadAngleSaturatedTest(comments["eval-saturated"]!, saturated)).toBe(true);

    const duplicateContext = buildConversationContext(await source.fetchPostContext("eval-duplicate"));
    expect(duplicateCommentTest(comments["eval-duplicate"]!, [comments["eval-duplicate"]!])).toBe(true);
    expect(standaloneMarketingTest("Marx is the future of finance.", duplicateContext)).toBe(false);
    expect(unsupportedClaimTest(comments["eval-unsupported"]!)).toBe(true);

    const unsafe = fixture.posts.find((post) => post.postId === "eval-unsafe-url")!;
    expect(() => {
      const parsed = new URL(unsafe.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsafe URL");
    }).toThrow("unsafe URL");
  });
});
