import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { FeedConfigSchema, fetchMarxFeed } from "./source";
import { FeedStore } from "./store";
import { runFeedCycle } from "./cycle";
import { openRuntimePersistence } from "../persistence/runtime";
import type { SqliteDatabase } from "../persistence/database";
import type { ParsedCli, CliDependencies } from "../cli";
import type { ResolvedRuntimeSettings } from "../config";

export const FEED_HELP = `Feed commands:
  marx-feed-check [--bootstrap baseline|latest] [--feed-config <path>]
  marx-feed-cycle [--limit <n> --search-limit <n> --actions <n>] [--with-agent-quotes] [--publish]
  marx-feed-status
  marx-feed-resolve --feed-id <id> --claim-id <id> --resolution retry|skip --reason <text> --confirm-reconciled
The first check baselines existing feeds. A cycle checks, queues, then processes one pending URL.
Real-model draft mode is the default. Hermes schedules the one-shot cycle with 'every 5h'.`;

export async function runFeedCli(parsed: ParsedCli, settings: ResolvedRuntimeSettings, dependencies: CliDependencies, execute: (args: string[], deps: CliDependencies) => Promise<string>): Promise<string> {
  const resolving = parsed.command === "marx-feed-resolve";
  const allowed = new Set(resolving ? ["feed-config", "feed-id", "claim-id", "resolution", "reason", "confirm-reconciled"] : ["help", "feed-config", "bootstrap", "limit", "search-limit", "actions", "with-agent-quotes", "no-agent-quotes", "real-model", "publish", "output"]);
  for (const option of Object.keys(parsed.options)) if (!allowed.has(option)) throw new Error(`Unsupported feed option: --${option}`);
  if (parsed.positional.length) throw new Error("Feed commands do not accept positional arguments");
  for (const key of ["publish", "real-model", "with-agent-quotes", "no-agent-quotes"]) {
    const value = parsed.options[key];
    if (value !== undefined && value !== true && value !== false && value !== "true" && value !== "false") throw new Error(`Invalid boolean: --${key}`);
  }
  for (const key of ["actions", "limit", "search-limit"]) {
    const value = parsed.options[key];
    if (value !== undefined && (typeof value !== "string" || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error(`--${key} requires a positive integer`);
  }
  const configPath = parsed.options["feed-config"] ?? `${dependencies.configDirectory ?? process.env.MARX_GROWTH_CONFIG_DIR ?? "config"}/feed.yaml`;
  if (typeof configPath !== "string") throw new Error("--feed-config requires a path");
  const config = FeedConfigSchema.parse(parse(await readFile(configPath, "utf8")) as unknown);
  if (parsed.options.bootstrap !== undefined) {
    if (parsed.options.bootstrap !== "baseline" && parsed.options.bootstrap !== "latest") throw new Error("--bootstrap must be baseline or latest");
    config.first_run = parsed.options.bootstrap;
  }
  const publish = parsed.options.publish === true || parsed.options.publish === "true";
  if (publish && parsed.command !== "marx-feed-cycle") throw new Error("--publish requires marx-feed-cycle");
  if (publish && (parsed.options["real-model"] === false || parsed.options["real-model"] === "false")) throw new Error("Scheduled publication requires real-model evaluation");
  const opened = await openRuntimePersistence(process.env.MARX_GROWTH_DB ?? settings.system.storage?.database_path, {
    actionValidation: { mode: publish ? "production" : "dry-run", allowedDomains: settings.allowedDomains },
  });
  opened.db.pragma("busy_timeout = 5000");
  try {
    const store = new FeedStore(opened.db as unknown as SqliteDatabase);
    if (resolving) {
      const { "feed-id": feedId, "claim-id": claimId, resolution, reason } = parsed.options;
      if (typeof feedId !== "string" || typeof claimId !== "string" || typeof reason !== "string" || (resolution !== "retry" && resolution !== "skip") || parsed.options["confirm-reconciled"] !== true) {
        throw new Error("marx-feed-resolve requires --feed-id, --claim-id, --resolution retry|skip, --reason and --confirm-reconciled");
      }
      store.resolve(feedId, claimId, resolution, reason);
      const text = JSON.stringify({ status: "RESOLVED", feedId, resolution });
      (dependencies.stdout ?? console.log)(text);
      return text;
    }
    const result = parsed.command === "marx-feed-status" ? { feeds: store.list() } : await runFeedCycle({
      store, config, publish,
      checkOnly: parsed.command === "marx-feed-check",
      fetchFeed: dependencies.feedSource ?? (() => fetchMarxFeed(config)),
      execute: async (sourceUrl, runId) => {
        const args = ["marx-specific-cycle", "--article-url", sourceUrl, "--real-model"];
        const forwarded = ["limit", "search-limit", "actions", "with-agent-quotes", "no-agent-quotes", "real-model", "publish", "output"];
        for (const key of forwarded) {
          const value = parsed.options[key];
          if (value !== undefined) args.push(`--${key}=${value}`);
        }
        return execute(args, { ...dependencies, specificCycleRunId: runId, persistence: opened.persistence, stdout: () => undefined });
      },
    });
    const text = JSON.stringify(result, null, 2);
    (dependencies.stdout ?? console.log)(text);
    return text;
  } finally { opened.db.close(); }
}
