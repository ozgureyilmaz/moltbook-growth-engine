import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { publisherRuntime } from "../dist/operations/publisher-runtime.js";
import { EmergencyKillSwitch } from "../dist/operations/kill-switch.js";
import { LocalOutbox } from "../dist/outbox/index.js";
import { postActionIdFor, postBodyHash, experimentIdFor } from "../dist/domain/identifiers.js";
import { createTrackerRef } from "../dist/tracking/links.js";
import { MarxTrackerHttpClient } from "../dist/tracking/client.js";

const execFileAsync = promisify(execFile);
const TRACKER_ORIGIN = "https://marx-tracker.marxx.workers.dev";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) throw new Error(`unexpected argument: ${value ?? ""}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = next;
    index += 1;
  }
  if (!options.title || !options["content-file"]) throw new Error("usage: publish-post.mjs --title TITLE --content-file PATH --destination-url URL --submolt general");
  return options;
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalMarxFeed(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "marx.finance" || url.pathname.split("/").length !== 3 || url.search || url.hash) throw new Error("destination URL must be a canonical Marx feed URL");
  return { url: url.toString(), feedId: url.pathname.slice("/feed/".length) };
}

function replaceDestination(content, destinationUrl, trackingUrl) {
  const occurrences = content.split(destinationUrl).length - 1;
  if (occurrences !== 1) throw new Error(`content must contain the exact Marx URL once; found ${occurrences}`);
  return content.replace(destinationUrl, trackingUrl);
}

async function findReceipt(actionId) {
  const directory = "outbox/handoff/receipts";
  let names;
  try { names = await readdir(directory); } catch { return undefined; }
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try {
      const receipt = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
      if (receipt.actionId === actionId) return receipt;
    } catch {
      // Ignore unrelated or incomplete receipt files; the publisher owns them.
    }
  }
  return undefined;
}

async function curlFetcher(input, init = {}) {
  const url = String(input);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const args = ["--silent", "--show-error", "--max-time", "30", "--request", method];
  for (const [key, value] of headers.entries()) args.push("--header", `${key}: ${value}`);
  if (init.body !== undefined) args.push("--data-raw", String(init.body));
  args.push("--write-out", "\n%{http_code}", url);
  const result = await execFileAsync("/opt/homebrew/opt/curl/bin/curl", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const marker = result.stdout.lastIndexOf("\n");
  const status = Number(result.stdout.slice(marker + 1).trim());
  return new Response(result.stdout.slice(0, marker), { status, headers: { "content-type": "application/json" } });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { url: destinationUrl, feedId } = canonicalMarxFeed(options["destination-url"] ?? "https://marx.finance/feed/893d1114021c43c3b582575ad48d0953");
  const submolt = options.submolt ?? "general";
  if (submolt !== "general") throw new Error("this one-off publisher only permits the approved general submolt");
  const rawContent = await readFile(options["content-file"], "utf8");
  const runId = `manual-post-${sha(`${submolt}\n${options.title}\n${rawContent}`).slice(0, 24)}`;
  let trackerToken = process.env.MARX_TRACKER_API_TOKEN;
  if (!trackerToken && process.env.MARX_TRACKER_SECRETS_FILE) {
    const secrets = JSON.parse(await readFile(process.env.MARX_TRACKER_SECRETS_FILE, "utf8"));
    trackerToken = typeof secrets.MARX_TRACKER_API_TOKEN === "string" ? secrets.MARX_TRACKER_API_TOKEN : undefined;
  }
  if (!trackerToken?.trim()) throw new Error("MARX_TRACKER_API_TOKEN is required for a production tracked post");
  const tracker = new MarxTrackerHttpClient({ baseUrl: TRACKER_ORIGIN, token: trackerToken, fetcher: curlFetcher });
  const created = await tracker.createDistribution({
    ref: createTrackerRef(),
    preLinkIdentity: `manual-post:${sha(`${submolt}\n${options.title}\n${rawContent}`)}`,
    destinationUrl,
    platform: "moltbook",
    contentType: "post",
    targetSubmolt: submolt,
    feedId,
    runId,
    opportunityId: `manual-post:${runId}`,
    candidateId: `manual-post:${runId}`,
    idempotencyKey: `moltbook-post:${sha(`${submolt}\n${options.title}\n${rawContent}`)}`,
  });
  const trackedContent = replaceDestination(rawContent, destinationUrl, created.trackingUrl);
  const actionId = postActionIdFor(submolt, options.title, trackedContent);
  const experimentId = experimentIdFor(actionId, runId);
  const action = {
    schemaVersion: "1.0",
    actionId,
    action: "POST",
    platform: "moltbook",
    target: { submolt },
    content: { title: options.title, content: trackedContent, type: "text" },
    decision: { opportunityScore: 1, evaluationScore: 1, confidence: 1 },
    experiment: { experimentId, promptVersion: "manual-post/v1", modelVersion: "operator" },
    metadata: { createdAt: new Date().toISOString(), runId },
  };
  const killSwitch = new EmergencyKillSwitch();
  const outbox = new LocalOutbox("outbox", { mode: "production", allowedDomains: ["www.moltbook.com"], productionGate: () => killSwitch.assertAutonomousAllowed() });
  await outbox.enqueue(action);
  const runtime = publisherRuntime();
  const publisher = await execFileAsync(runtime.python, [runtime.script, "--config", runtime.config, "--action-id", actionId], {
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, MARX_GROWTH_NODE: process.execPath },
  });
  const receipt = await findReceipt(actionId);
  if (!receipt || receipt.status !== "PUBLISHED") {
    console.log(JSON.stringify({ status: receipt?.status ?? "RECEIPT_MISSING", actionId, ref: created.ref, trackingUrl: created.trackingUrl, publisherOutput: publisher.stdout.trim() }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!receipt.providerPostId || typeof receipt.permalink !== "string") throw new Error("PUBLISHED receipt is missing the verified post identity");
  const finalized = await tracker.finalizeDistribution(created.ref, {
    actionId,
    experimentId,
    contentHash: postBodyHash(options.title, trackedContent),
    publishedPostId: receipt.providerPostId,
    publishedPostUrl: receipt.permalink,
  });
  const summary = await tracker.getSummary(created.ref);
  if (summary.status !== "active" || finalized.status !== "active") throw new Error("tracker finalization read-back is not active");
  console.log(JSON.stringify({ status: "PUBLISHED", actionId, ref: created.ref, trackingUrl: created.trackingUrl, permalink: receipt.permalink, trackerStatus: summary.status, publisherOutput: publisher.stdout.trim() }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
