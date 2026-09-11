import type { SpecificMarxDraft } from "./input";

export type SpecificMarxOutputRecord = SpecificMarxDraft & {
  actionId?: string;
  experimentId?: string;
  publicationStatus: string;
  trackingUrl?: string;
  trackingEnvironment?: "development" | "production";
  trackingStatus?: string;
};

export type SpecificMarxNoActionRecord = {
  actionId: string;
  reason: string;
  targetUrl?: string;
};

export function buildSpecificMarxMarkdown(input: {
  articleUrl: string;
  runId: string;
  records: SpecificMarxOutputRecord[];
  targetCount?: number;
  noActions?: SpecificMarxNoActionRecord[];
  errorMessages?: string[];
  includeAgentQuotes?: boolean;
}): string {
  const lines = [
    "# Specific Marx Feed → Moltbook Comment Cycle",
    "",
    `Marx feed: ${input.articleUrl}`,
    "",
    `Run ID: ${input.runId}`,
    "",
    `Target summary: ${input.targetCount ?? input.records.length} requested; ${input.records.length} action(s); ${input.noActions?.length ?? 0} NO_ACTION result(s).`,
    "",
    `Comment bodies contain one tracked Marx link and ${input.includeAgentQuotes ? "the selected Marx agent reply quote" : "no agent reply quote"}. Target and comment preview links remain separate metadata.`,
    "",
  ];
  input.records.forEach((record, index) => {
    lines.push(
      `## ${index + 1}. target post`,
      "",
      `Target post: ${record.targetUrl}`,
      "",
      `Comment preview: ${record.commentPreviewUrl}`,
      "",
      ...(record.trackingUrl ? [`Tracking link: ${record.trackingUrl}`, ""] : []),
      ...(record.trackingEnvironment ? [`Tracking environment: ${record.trackingEnvironment}`, ""] : []),
      ...(record.trackingStatus ? [`Tracking status: ${record.trackingStatus}`, ""] : []),
      `Action ID: ${record.actionId ?? "not emitted"}`,
      `Experiment ID: ${record.experimentId ?? "not emitted"}`,
      `Publication status: ${record.publicationStatus}`,
      "",
      `> ${record.comment}`,
      "",
    );
  });
  if (input.noActions && input.noActions.length > 0) {
    lines.push("## No-action targets", "");
    for (const noAction of input.noActions) {
      lines.push(
        `- ${noAction.targetUrl ?? "target unavailable"} — ${noAction.reason} (${noAction.actionId})`,
      );
    }
    lines.push("");
  }
  if (input.errorMessages && input.errorMessages.length > 0) {
    lines.push("## Run errors", "");
    for (const error of input.errorMessages) lines.push(`- ${error}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
