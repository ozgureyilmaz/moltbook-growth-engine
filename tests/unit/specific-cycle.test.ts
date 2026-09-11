import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSpecificMarxMarkdown,
  buildSpecificMarxComment,
  parseSpecificMarxDraftText,
} from "../../src/specific-cycle";
import { countMarxMentions } from "../../src/generation";
import { parseArgs, specificRealModelRuntimeOptions } from "../../src/cli";

const SAMPLE_TXT = `Target post: [https://www.moltbook.com/post/post-1](https://www.moltbook.com/post/post-1)
Comment: [https://www.moltbook.com/post/post-1#comment-comment-1](https://www.moltbook.com/post/post-1#comment-comment-1)
This is the first comment with Marx.
[https://marx.finance/feed/article-1](https://marx.finance/feed/article-1)

Target post: [https://www.moltbook.com/post/post-2](https://www.moltbook.com/post/post-2)
Comment: [https://www.moltbook.com/post/post-2#comment-comment-2](https://www.moltbook.com/post/post-2#comment-comment-2)
This is the second comment with Marx.
[https://marx.finance/feed/article-1](https://marx.finance/feed/article-1)`;

describe("specific Marx cycle", () => {
  it("parses the explicit target CLI contract without enabling publish by default", () => {
    const parsed = parseArgs([
      "marx-specific-cycle",
      "--article-url",
      "https://marx.finance/feed/article-1",
      "--post-ids",
      "post-1,post-2",
    ]);
    expect(parsed.command).toBe("marx-specific-cycle");
    expect(parsed.options).toMatchObject({
      "article-url": "https://marx.finance/feed/article-1",
      "post-ids": "post-1,post-2",
    });
    expect(parsed.options.publish).toBeUndefined();
  });

  it("uses a bounded single-worker real-model profile for specific cycles", () => {
    expect(specificRealModelRuntimeOptions()).toMatchObject({
      workerConcurrency: 1,
      modelConcurrency: 1,
      workerMaxAttempts: 1,
      modelMaxAttempts: 1,
      modelTimeoutMs: 120_000,
      modelReasoningEffort: "low",
      modelWorkingDirectory: "/tmp",
      strategyGenerationBatchSize: 1,
      strategyGenerationTaskBudget: 8,
      strategyGenerationFailureBudget: 2,
    });
  });

  it("supports discovery mode without post IDs", () => {
    const parsed = parseArgs([
      "marx-specific-cycle",
      "--article-url",
      "https://marx.finance/feed/article-1",
      "--limit",
      "5",
      "--actions",
      "5",
      "--publish",
    ]);
    expect(parsed.command).toBe("marx-specific-cycle");
    expect(parsed.options).toMatchObject({ limit: "5", actions: "5", publish: true });
    expect(parsed.options["post-ids"]).toBeUndefined();
  });

  it("parses the explicit agent-quote mode for Marx-linked comments", () => {
    const parsed = parseArgs([
      "marx-specific-cycle",
      "--article-url",
      "https://marx.finance/feed/article-1",
      "--limit",
      "5",
      "--actions",
      "5",
      "--with-agent-quotes",
      "--publish",
    ]);
    expect(parsed.options["with-agent-quotes"]).toBe(true);
    expect(parsed.options["no-agent-quotes"]).toBeUndefined();
  });

  it("parses target, preview, comment body, and Marx source from pasted TXT", () => {
    const drafts = parseSpecificMarxDraftText(SAMPLE_TXT);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual(expect.objectContaining({
      targetPostId: "post-1",
      targetUrl: "https://www.moltbook.com/post/post-1",
      commentPreviewUrl: "https://www.moltbook.com/post/post-1#comment-comment-1",
      sourceUrl: "https://marx.finance/feed/article-1",
      comment: "This is the first comment with Marx.",
    }));
  });

  it("parses the checked-in user TXT fixture as five complete blocks", () => {
    const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/specific-marx-comments-500cf34bfaa84944ab840cd32adc8849.txt"), "utf8");
    const drafts = parseSpecificMarxDraftText(fixture);
    expect(drafts).toHaveLength(5);
    expect(new Set(drafts.map((draft) => draft.targetPostId)).size).toBe(5);
    expect(new Set(drafts.map((draft) => draft.sourceUrl))).toEqual(new Set(["https://marx.finance/feed/500cf34bfaa84944ab840cd32adc8849"]));
    expect(drafts[4]?.comment).not.toContain("çıktıların burdaki");
  });

  it("rejects a pasted block without an approved Marx feed source", () => {
    expect(() => parseSpecificMarxDraftText(SAMPLE_TXT.replaceAll("https://marx.finance/feed/article-1", "https://example.com/source"))).toThrow(/Marx feed source/u);
  });

  it("adds exactly one visible Marx source link without agent quotes", () => {
    const comment = buildSpecificMarxComment("Marx is relevant to this policy repricing thread.", "https://marx.finance/feed/article-1");
    expect(comment).toContain("[source](https://marx.finance/feed/article-1)");
    expect(comment).not.toMatch(/AutoTrader|youngheron|related agent note/iu);
    expect(countMarxMentions(comment)).toBe(1);
  });

  it("renders target and comment preview links separately in Markdown output", () => {
    const output = buildSpecificMarxMarkdown({
      articleUrl: "https://marx.finance/feed/article-1",
      runId: "run-specific-1",
      targetCount: 2,
      noActions: [{ actionId: "no-1", reason: "THREAD_SATURATED", targetUrl: "https://www.moltbook.com/post/post-2" }],
      records: [{
        targetUrl: "https://www.moltbook.com/post/post-1",
        commentPreviewUrl: "https://www.moltbook.com/post/post-1#comment-comment-1",
        actionId: "act-1",
        experimentId: "exp-1",
        publicationStatus: "DRY_RUN",
        comment: "Marx is relevant. [source](https://marx.finance/feed/article-1)",
      }],
    });
    expect(output).toContain("Target post: https://www.moltbook.com/post/post-1");
    expect(output).toContain("Comment preview: https://www.moltbook.com/post/post-1#comment-comment-1");
    expect(output).toContain("Action ID: act-1");
    expect(output).toContain("Experiment ID: exp-1");
    expect(output).toContain("Publication status: DRY_RUN");
    expect(output).toContain("Target summary: 2 requested; 1 action(s); 1 NO_ACTION result(s).");
    expect(output).toContain("THREAD_SATURATED");
  });

  it("renders run errors separately from quality no-action reasons", () => {
    const output = buildSpecificMarxMarkdown({
      articleUrl: "https://marx.finance/feed/article-1",
      runId: "run-errors-1",
      targetCount: 2,
      noActions: [{ actionId: "no-1", reason: "WORKER_FAILURE", targetUrl: "https://www.moltbook.com/post/post-1" }],
      errorMessages: ["worker task task-1 timed out after 600000ms"],
      records: [],
    });

    expect(output).toContain("## Run errors");
    expect(output).toContain("worker task task-1 timed out after 600000ms");
    expect(output).toContain("WORKER_FAILURE");
  });
});
