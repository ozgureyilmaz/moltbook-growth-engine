import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArticleWorkflowResult } from "../article/workflow";
import { buildDryRunRecord } from "./logger";

export async function writeArticleReport(result: ArticleWorkflowResult, destination: string) {
  const base = destination.endsWith(".md") ? destination.slice(0, -3) : join(destination, result.summary.runId);
  const markdownPath = resolve(`${base}.md`);
  const jsonPath = resolve(`${base}.json`);
  const record = buildDryRunRecord(result);
  const status = result.summary.errors > 0 ? "ERROR" : result.actions.length > 0 ? "DRAFTS_READY" : "NO_ACTION";
  const lines = [
    "# Live article report", "", `Status: ${status}`, `Run: ${result.summary.runId}`,
    `Article: ${result.article.sourceUrl}`, `Evaluation: ${result.summary.evaluationMode}`,
    `Discovered: ${result.summary.discovered} | Qualified: ${result.summary.qualified} | Drafts: ${result.actions.length} | Errors: ${result.summary.errors}`,
    "Published: 0 (read-only run)", "", "## Validated drafts", "",
    ...result.actions.flatMap((action, i) => [`### ${i + 1}. ${action.target.postUrl}`, "", action.content.comment, "", `Action: ${action.actionId}`, ""]),
    ...(result.actions.length === 0 ? ["No comment passed all required gates.", ""] : []),
    "## Decisions and rejection reasons", "",
    ...result.noActions.map((entry) => `- ${entry.target?.postUrl ?? "Run"}: ${entry.reason}`),
    ...record.qaRejectionReasons.map((reason) => `- ${reason}`),
    "", "## Errors", "", ...(result.summary.errorMessages ?? []).map((message) => `- ${message}`), "",
  ];
  await mkdir(dirname(markdownPath), { recursive: true });
  // Refuse an accidental overwrite of a previous review artifact.
  await writeFile(jsonPath, JSON.stringify({ status, summary: result.summary, article: result.article, record, actions: result.actions, noActions: result.noActions, published: 0 }, null, 2), { flag: "wx" });
  await writeFile(markdownPath, lines.join("\n"), { flag: "wx" });
  return { status, markdownPath, jsonPath };
}
