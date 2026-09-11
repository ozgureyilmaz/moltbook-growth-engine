import { randomBytes } from "node:crypto";
import { idempotencyKeyFor } from "../domain/identifiers";

export type PreLinkIdentityInput = {
  runId: string;
  opportunityId: string;
  candidateId: string;
  sourcePostId: string;
  strategyFamily: string;
  /** Accepted for call-site ergonomics; deliberately ignored. */
  finalComment?: string;
};

export function preLinkIdentityFor(input: PreLinkIdentityInput): string {
  return idempotencyKeyFor("marx-tracker-prelink", {
    runId: input.runId,
    opportunityId: input.opportunityId,
    candidateId: input.candidateId,
    sourcePostId: input.sourcePostId,
    strategyFamily: input.strategyFamily,
  });
}

export function createTrackerRef(): string {
  return randomBytes(16).toString("base64url");
}

export function appendTrackedMarxLink(comment: string, trackingUrl: string): string {
  const normalized = comment.trim();
  if (!normalized) throw new Error("Cannot append a tracking link to an empty comment");
  const url = new URL(trackingUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Tracker URL must use http or https");
  const label = "[Open Marx feed]";
  if (normalized.includes(label) || normalized.includes("[Open Marx feed (tracked)]")) throw new Error("Comment already contains a tracked Marx link");
  return `${normalized} ${label}(${url.toString()})`;
}

export function trackingLinkCount(comment: string): number {
  return (comment.match(/\[(?:Open Marx feed|Open Marx feed \(tracked\))\]\(https?:\/\/[^)]+\)/giu) ?? []).length;
}
