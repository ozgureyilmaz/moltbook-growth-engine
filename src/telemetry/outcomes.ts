import { deterministicId, stableStringify } from "../domain/identifiers";
import { MarxOutcomeEventSchema, OutcomeSchema, PublicationSchema, type MarxOutcomeEvent, type Outcome, type OutcomeEventType, type Publication } from "../schemas";

export type CreateOutcomeEventInput = Omit<MarxOutcomeEvent, "schemaVersion" | "eventId"> & { eventId?: string };

export function createMarxOutcomeEvent(input: CreateOutcomeEventInput): MarxOutcomeEvent {
  const material = { schemaVersion: "1.0" as const, ...input };
  const eventId = input.eventId ?? deterministicId("outcomeevt", {
    eventType: input.eventType,
    actionId: input.actionId,
    experimentId: input.experimentId,
    source: input.source,
    evidenceId: input.evidenceId,
    occurredAt: input.occurredAt,
    value: input.value,
  });
  return MarxOutcomeEventSchema.parse({ ...material, eventId });
}

export type OutcomeAggregation = {
  outcome: Outcome;
  includedEventIds: string[];
  excludedEventIds: string[];
  evidenceStatus: "verified" | "insufficient_verified_evidence";
};

/** Only verified evidence can set learning signals. Other evidence remains inspectable but excluded. */
export function aggregateVerifiedOutcomeEvents(input: {
  actionId: string;
  experimentId: string;
  runId: string;
  sourcePostId: string;
  targetAgentId?: string;
  publication: Publication;
  events: readonly unknown[];
  observedAt?: string;
}): OutcomeAggregation {
  const publication = PublicationSchema.parse(input.publication);
  if (publication.status !== "published" || publication.actionId !== input.actionId || publication.experimentId !== input.experimentId) {
    throw new Error("Outcome aggregation requires a matching published receipt");
  }
  if (publication.metadata?.evidenceStatus !== "verified" || publication.metadata?.targetPostId !== input.sourcePostId || !publication.acknowledgedAt) {
    throw new Error("Outcome aggregation requires verified publication evidence for the exact source post");
  }
  const parsed = input.events.map((event) => MarxOutcomeEventSchema.parse(event));
  if (parsed.length === 0) throw new Error("Outcome aggregation requires at least one evidence event");
  for (const event of parsed) {
    if (event.actionId !== input.actionId || event.experimentId !== input.experimentId || event.runId !== input.runId) throw new Error("Outcome event attribution does not match the requested action/experiment/run");
    if (event.sourcePostId !== input.sourcePostId) throw new Error("Outcome event source post does not match verified publication attribution");
    if (input.targetAgentId && event.targetAgentId !== input.targetAgentId) throw new Error("Outcome event target agent does not match verified attribution");
    if (Date.parse(event.occurredAt) < Date.parse(publication.acknowledgedAt)) throw new Error("Outcome event occurred before verified publication");
  }
  const verified = parsed.filter((event) => event.evidenceStatus === "verified");
  const values = new Map<OutcomeEventType, Array<boolean | number>>();
  for (const event of verified) values.set(event.eventType, [...(values.get(event.eventType) ?? []), event.value]);
  const observedAt = input.observedAt ?? [...parsed].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]?.observedAt ?? new Date().toISOString();
  const outcome = OutcomeSchema.parse({
    outcomeId: deterministicId("outcome", { experimentId: input.experimentId, evidence: verified.map((event) => event.eventId).sort() }),
    experimentId: input.experimentId,
    runId: input.runId,
    publisherStatus: publication.status,
    replyReceived: booleanValue(values, "reply_received"),
    replyLatencySeconds: minimumNumericValue(values, "reply_latency_seconds"),
    reactionCount: maximumIntegerValue(values, "reaction_count"),
    targetAgentEngaged: booleanValue(values, "target_agent_engaged"),
    marxMentionedByTargetAfterward: booleanValue(values, "marx_mentioned_by_target"),
    marxInvestigationSignal: booleanValue(values, "marx_investigated"),
    marxInteractionSignal: booleanValue(values, "marx_interacted"),
    marxUsageSignal: booleanValue(values, "marx_used"),
    observedAt,
    metadata: {
      actionId: input.actionId,
      sourcePostId: input.sourcePostId,
      publicationId: publication.publicationId,
      evidenceStatus: verified.length > 0 ? "verified" : "insufficient_verified_evidence",
      includedEventIds: verified.map((event) => event.eventId),
      excludedEventIds: parsed.filter((event) => event.evidenceStatus !== "verified").map((event) => event.eventId),
      evidenceDigest: stableStringify(verified.map((event) => ({ eventId: event.eventId, evidenceId: event.evidenceId })).sort((a, b) => a.eventId.localeCompare(b.eventId))),
    },
  });
  return {
    outcome,
    includedEventIds: verified.map((event) => event.eventId),
    excludedEventIds: parsed.filter((event) => event.evidenceStatus !== "verified").map((event) => event.eventId),
    evidenceStatus: verified.length > 0 ? "verified" : "insufficient_verified_evidence",
  };
}

function booleanValue(values: Map<OutcomeEventType, Array<boolean | number>>, key: OutcomeEventType): boolean | undefined {
  const entries = values.get(key);
  return entries ? entries.some(Boolean) : undefined;
}

function minimumNumericValue(values: Map<OutcomeEventType, Array<boolean | number>>, key: OutcomeEventType): number | undefined {
  const entries = values.get(key)?.filter((value): value is number => typeof value === "number");
  return entries?.length ? Math.min(...entries) : undefined;
}

function maximumIntegerValue(values: Map<OutcomeEventType, Array<boolean | number>>, key: OutcomeEventType): number | undefined {
  const value = minimumOrMaximum(values, key, Math.max);
  return value === undefined ? undefined : Math.floor(value);
}

function minimumOrMaximum(values: Map<OutcomeEventType, Array<boolean | number>>, key: OutcomeEventType, reducer: (...values: number[]) => number): number | undefined {
  const entries = values.get(key)?.filter((value): value is number => typeof value === "number");
  return entries?.length ? reducer(...entries) : undefined;
}
