import { createHash } from "node:crypto";

/** Canonical JSON-like serialization used for retry-safe identifiers. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot hash a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return String(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function deterministicId(prefix: string, ...parts: unknown[]): string {
  const normalizedPrefix = normalizeText(prefix).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${normalizedPrefix}_${sha256(stableStringify(parts)).slice(0, 32)}`;
}

export function idempotencyKeyFor(namespace: string, payload: unknown): string {
  return `${normalizeText(namespace)}:${sha256(stableStringify(payload))}`;
}

export function postIngestionKey(postId: string, platform = "moltbook"): string {
  return idempotencyKeyFor("post", { platform, postId: normalizeText(postId) });
}

export function contextIdFor(postId: string, contextVersion = "v1"): string {
  return deterministicId("ctx", { postId: normalizeText(postId), contextVersion });
}

export function opportunityIdFor(runId: string, postId: string): string {
  return deterministicId("opp", { runId: normalizeText(runId), postId: normalizeText(postId) });
}

export function candidateIdFor(opportunityId: string, strategyFamily: string, comment: string): string {
  return deterministicId("candidate", {
    opportunityId: normalizeText(opportunityId),
    strategyFamily: normalizeText(strategyFamily),
    commentHash: commentHash(comment),
  });
}

export function evaluationIdFor(candidateId: string, evaluatorVersion: string): string {
  return deterministicId("eval", { candidateId, evaluatorVersion });
}

export function commentHash(comment: string): string {
  return sha256(normalizeText(comment));
}

export function actionIdFor(postId: string, comment: string, strategyFamily: string): string {
  return deterministicId("act", {
    postId: normalizeText(postId),
    commentHash: commentHash(comment),
    strategyFamily: normalizeText(strategyFamily),
  });
}

export function experimentIdFor(actionId: string, runId: string): string {
  return deterministicId("exp", { actionId, runId });
}

export function noActionIdFor(runId: string, postId: string, reason: string): string {
  return deterministicId("no", { runId: normalizeText(runId), postId: normalizeText(postId), reason: normalizeText(reason) });
}

export function workerReportIdFor(runId: string, worker: string, taskId: string): string {
  return deterministicId("report", { runId, worker, taskId });
}

export function modelRunIdFor(runId: string, taskId: string, attempt: number): string {
  return deterministicId("modelrun", { runId, taskId, attempt });
}

export function actionIdempotencyKey(action: {
  action: string;
  target?: { postId?: string };
  content?: { comment?: string };
}): string {
  return idempotencyKeyFor("action", {
    action: action.action,
    postId: action.target?.postId,
    commentHash: action.content?.comment ? commentHash(action.content.comment) : undefined,
  });
}
