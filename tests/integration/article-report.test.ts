import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureMoltbookSource } from "../../src/discovery";
import { SolOrchestrator } from "../../src/orchestrator";
import { writeArticleReport } from "../../src/telemetry/article-report";
import { runCli } from "../../src/cli";
import * as articleModule from "../../src/article";
import type { ArticleWorkflowResult } from "../../src/article/workflow";

async function emptyResult(): Promise<ArticleWorkflowResult> {
  const result = await new SolOrchestrator(new FixtureMoltbookSource({ posts: [] })).run({ dryRun: true, evaluationMode: "deterministic_mock", enableWorkerAdvisory: false });
  return { ...result, article: {
    articleId: "report-article", sourceUrl: "https://marx.finance/feed/report-article", title: "Report test", body: "Market evidence test",
    tickers: [], topics: [], replyCount: 0, visibleReplyCount: 0, evidenceStatus: "complete", agentReplies: [], fetchedAt: new Date().toISOString(),
  }, queries: [], relatedPosts: [] };
}

afterEach(() => vi.restoreAllMocks());

describe("live article report", () => {
  it("labels zero-result reports as NO_ACTION and never implies publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marx-report-"));
    try {
      const result = await emptyResult();
      const paths = await writeArticleReport(result, directory);
      expect(paths.status).toBe("NO_ACTION");
      expect(await readFile(paths.markdownPath, "utf8")).toContain("Published: 0 (read-only run)");
      expect(JSON.parse(await readFile(paths.jsonPath, "utf8"))).toMatchObject({ status: "NO_ACTION", published: 0, actions: [] });
      await expect(writeArticleReport(result, directory)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("writes error evidence before the article CLI exits with failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marx-report-error-"));
    try {
      const result = await emptyResult();
      result.summary.errors = 1;
      result.summary.errorMessages = ["Model generation unavailable"];
      const workflow = vi.spyOn(articleModule, "runArticleWorkflow").mockResolvedValue(result);
      const output: string[] = [];
      await expect(runCli(["article-run", "--article-url", result.article.sourceUrl, "--real-model", "--dry-run", "--output", directory], {
        persistence: {}, stdout: (line) => output.push(line),
      })).rejects.toThrow();
      expect(workflow).toHaveBeenCalledWith(expect.objectContaining({ includeSourceLink: true, orchestratorOptions: expect.objectContaining({ dryRun: true, evaluationMode: "real_model", modelGenerateComments: true, modelReasoningEffort: "low", modelMaxAttempts: 1, enableWorkerAdvisory: false }) }));
      const printed = JSON.parse(output[0]!);
      expect(printed.reports.status).toBe("ERROR");
      expect(await readFile(printed.reports.markdownPath, "utf8")).toContain("Model generation unavailable");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
