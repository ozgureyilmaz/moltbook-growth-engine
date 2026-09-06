import { MarxOutcomeEventSchema, type MarxOutcomeEvent, type Outcome, type Publication } from "../schemas";
import type { PersistenceLike } from "../orchestrator/contracts";
import { aggregateVerifiedOutcomeEvents } from "./outcomes";

type OutcomeAttribution = {
  runId: string;
  sourcePostId: string;
  actionId?: string;
  experimentId: string;
};

export type OutcomeEvidencePersistence = PersistenceLike & {
  saveOutcomeEvent: (event: MarxOutcomeEvent) => Promise<void> | void;
  listOutcomeEvents: (experimentId: string) => Promise<MarxOutcomeEvent[]> | MarxOutcomeEvent[];
  getPublicationByActionId: (actionId: string) => Promise<Publication | undefined> | Publication | undefined;
  getExperimentAttribution: (experimentId: string) => Promise<OutcomeAttribution | undefined> | OutcomeAttribution | undefined;
  saveOutcome: (outcome: Outcome) => Promise<void> | void;
};

export type OutcomeIngestionResult = {
  importedEventIds: string[];
  outcomeIds: string[];
  experimentIds: string[];
};

/** Ingests raw evidence only through a verified publication and durable attribution join. */
export async function ingestVerifiedOutcomeEvents(
  persistence: OutcomeEvidencePersistence,
  value: unknown,
): Promise<OutcomeIngestionResult> {
  const events = parseBatch(value);
  const groups = new Map<string, MarxOutcomeEvent[]>();
  for (const event of events) {
    const key = `${event.runId}\u0000${event.experimentId}\u0000${event.actionId}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  const importedEventIds: string[] = [];
  const outcomeIds: string[] = [];
  const experimentIds: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const attribution = await persistence.getExperimentAttribution(first.experimentId);
    if (!attribution || attribution.runId !== first.runId || attribution.sourcePostId !== first.sourcePostId || attribution.actionId !== first.actionId) {
      throw new Error(`Outcome evidence does not match durable attribution for experiment ${first.experimentId}`);
    }
    const publication = await persistence.getPublicationByActionId(first.actionId);
    if (!publication) throw new Error(`Outcome evidence requires a verified publication for action ${first.actionId}`);

    // Validate the whole group before making any durable evidence write.
    aggregateVerifiedOutcomeEvents({
      actionId: first.actionId,
      experimentId: first.experimentId,
      runId: first.runId,
      sourcePostId: first.sourcePostId,
      publication,
      events: group,
    });

    for (const event of group) {
      await persistence.saveOutcomeEvent(event);
      importedEventIds.push(event.eventId);
    }
    const durableEvents = await persistence.listOutcomeEvents(first.experimentId);
    const aggregation = aggregateVerifiedOutcomeEvents({
      actionId: first.actionId,
      experimentId: first.experimentId,
      runId: first.runId,
      sourcePostId: first.sourcePostId,
      publication,
      events: durableEvents,
    });
    if (aggregation.evidenceStatus === "verified") {
      await persistence.saveOutcome(aggregation.outcome);
      outcomeIds.push(aggregation.outcome.outcomeId);
    }
    experimentIds.push(first.experimentId);
  }

  return {
    importedEventIds: [...new Set(importedEventIds)],
    outcomeIds: [...new Set(outcomeIds)],
    experimentIds: [...new Set(experimentIds)],
  };
}

function parseBatch(value: unknown): MarxOutcomeEvent[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
      ? (value as { events: unknown[] }).events
      : undefined;
  if (!candidate || candidate.length === 0) throw new Error("Outcome evidence file must contain a non-empty events array");
  return candidate.map((event) => MarxOutcomeEventSchema.parse(event));
}
