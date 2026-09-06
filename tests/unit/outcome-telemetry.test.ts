import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntimePersistence } from "../../src/persistence";
import { aggregateVerifiedOutcomeEvents, createMarxOutcomeEvent, ingestVerifiedOutcomeEvents } from "../../src/telemetry";
import type { Outcome, Publication } from "../../src/schemas";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function event(eventType: "reply_received" | "reaction_count" | "marx_used", value: boolean | number, evidenceStatus: "verified" | "inferred" = "verified") {
  return createMarxOutcomeEvent({
    eventType,
    actionId: "action-1",
    experimentId: "experiment-1",
    runId: "run-1",
    sourcePostId: "post-1",
    targetAgentId: "agent-1",
    value,
    source: eventType === "marx_used" ? "marx_product" : "moltbook_api",
    evidenceStatus,
    ...(evidenceStatus === "verified" ? { evidenceId: `evidence-${eventType}` } : {}),
    occurredAt: "2026-08-27T12:00:00.000Z",
    observedAt: "2026-08-27T12:05:00.000Z",
    consentState: eventType === "marx_used" ? "granted" : "not_required",
  });
}

function publication(actionId = "action-1"): Publication {
  return {
    publicationId: `receipt-${actionId}`,
    actionId,
    experimentId: "experiment-1",
    status: "published",
    attemptedAt: "2026-08-27T11:58:00.000Z",
    acknowledgedAt: "2026-08-27T11:59:00.000Z",
    metadata: { evidenceStatus: "verified", targetPostId: "post-1" },
  };
}

describe("Marx outcome telemetry", () => {
  it("uses only verified evidence for the learning outcome", () => {
    const verifiedReply = event("reply_received", true);
    const verifiedReaction = event("reaction_count", 3);
    const inferredUsage = event("marx_used", true, "inferred");
    const result = aggregateVerifiedOutcomeEvents({
      actionId: "action-1",
      experimentId: "experiment-1",
      runId: "run-1",
      sourcePostId: "post-1",
      publication: publication(),
      events: [verifiedReply, verifiedReaction, inferredUsage],
    });
    expect(result.outcome).toMatchObject({ replyReceived: true, reactionCount: 3, publisherStatus: "published" });
    expect(result.outcome.marxUsageSignal).toBeUndefined();
    expect(result.includedEventIds).toEqual([verifiedReply.eventId, verifiedReaction.eventId]);
    expect(result.excludedEventIds).toEqual([inferredUsage.eventId]);
  });

  it("rejects cross-action attribution", () => {
    expect(() => aggregateVerifiedOutcomeEvents({
      actionId: "other-action",
      experimentId: "experiment-1",
      runId: "run-1",
      sourcePostId: "post-1",
      publication: publication("other-action"),
      events: [event("reply_received", true)],
    })).toThrow(/attribution/u);
  });

  it("persists raw evidence idempotently in SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-outcome-"));
    temporaryPaths.push(root);
    const { persistence, db } = await openRuntimePersistence(join(root, "runtime.sqlite"));
    const value = event("marx_used", true);
    persistence.saveOutcomeEvent(value);
    persistence.saveOutcomeEvent(value);
    expect(persistence.listOutcomeEvents("experiment-1")).toEqual([value]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outcome_events").get() as { count: number }).toEqual({ count: 1 });
    expect(() => persistence.saveOutcomeEvent({ ...value, eventId: "different-event-id" })).toThrow(/already attributed/u);
    db.close();
  });

  it("ingests and aggregates only through durable publication attribution", async () => {
    const savedEvents: ReturnType<typeof event>[] = [];
    const savedOutcomes: Outcome[] = [];
    const value = event("marx_used", true);
    const persistence = {
      getExperimentAttribution: () => ({ runId: "run-1", sourcePostId: "post-1", actionId: "action-1", experimentId: "experiment-1" }),
      getPublicationByActionId: () => publication(),
      saveOutcomeEvent: (input: ReturnType<typeof event>) => { savedEvents.push(input); },
      listOutcomeEvents: () => savedEvents,
      saveOutcome: (input: Outcome) => { savedOutcomes.push(input); },
    };
    const result = await ingestVerifiedOutcomeEvents(persistence, { events: [value] });
    expect(result).toMatchObject({ importedEventIds: [value.eventId], experimentIds: ["experiment-1"] });
    expect(savedOutcomes[0]).toMatchObject({ marxUsageSignal: true, metadata: { evidenceStatus: "verified", sourcePostId: "post-1" } });

    await expect(ingestVerifiedOutcomeEvents({ ...persistence, getPublicationByActionId: () => undefined }, [value])).rejects.toThrow(/requires a verified publication/u);
  });

  it("keeps inferred evidence inspectable without creating a learning outcome", async () => {
    const savedEvents: ReturnType<typeof event>[] = [];
    const savedOutcomes: Outcome[] = [];
    const inferred = event("marx_used", true, "inferred");
    const result = await ingestVerifiedOutcomeEvents({
      getExperimentAttribution: () => ({ runId: "run-1", sourcePostId: "post-1", actionId: "action-1", experimentId: "experiment-1" }),
      getPublicationByActionId: () => publication(),
      saveOutcomeEvent: (input: ReturnType<typeof event>) => { savedEvents.push(input); },
      listOutcomeEvents: () => savedEvents,
      saveOutcome: (input: Outcome) => { savedOutcomes.push(input); },
    }, [inferred]);
    expect(result.outcomeIds).toEqual([]);
    expect(savedEvents).toEqual([inferred]);
    expect(savedOutcomes).toEqual([]);
  });
});
