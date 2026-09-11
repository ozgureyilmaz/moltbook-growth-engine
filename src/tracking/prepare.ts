import { commentHash, idempotencyKeyFor } from "../domain/identifiers";
import { runDeterministicQA } from "../evaluation/deterministic";
import type { ActionPayload, EvaluationResult, GeneratedCandidate, Opportunity, PersistenceLike, PublishableCandidatePreparer } from "../orchestrator/contracts";
import type { ExperimentRecord, ConversationContext } from "../orchestrator/contracts";
import { TrackingDistributionSchema, type TrackingDistribution, type TrackingEnvironment } from "../schemas";
import { appendTrackedMarxLink, createTrackerRef, preLinkIdentityFor, trackingLinkCount } from "./links";
import type { MarxTrackerClient } from "./client";

export type TrackedCandidatePreparerOptions = {
  client: MarxTrackerClient;
  environment: TrackingEnvironment;
  feedId: string;
  destinationUrl: string;
  persistence?: PersistenceLike;
};

export type TrackingPreparationInput = {
  runId: string;
  opportunity: Opportunity;
  context: ConversationContext;
  candidate: GeneratedCandidate;
  evaluation: EvaluationResult;
  previousComments: string[];
  createdAt: string;
};

export function createTrackedCandidatePreparer(options: TrackedCandidatePreparerOptions): PublishableCandidatePreparer {
  return async (input: TrackingPreparationInput) => {
    assertMarxDestination(options.destinationUrl, options.feedId);
    assertMoltbookSource(input.opportunity.post.url);
    const preLinkIdentity = preLinkIdentityFor({
      runId: input.runId,
      opportunityId: input.opportunity.opportunityId,
      candidateId: input.candidate.candidateId,
      sourcePostId: input.opportunity.post.postId,
      strategyFamily: input.candidate.strategyFamily,
    });
    const idempotencyKey = idempotencyKeyFor("marx-tracker-distribution", { preLinkIdentity });
    const ref = createTrackerRef();
    const created = await options.client.createDistribution({
      ref,
      preLinkIdentity,
      destinationUrl: options.destinationUrl,
      platform: "moltbook",
      contentType: "comment",
      feedId: options.feedId,
      sourcePostId: input.opportunity.post.postId,
      sourceUrl: input.opportunity.post.url,
      runId: input.runId,
      opportunityId: input.opportunity.opportunityId,
      candidateId: input.candidate.candidateId,
      idempotencyKey,
    });
    const pending: TrackingDistribution = TrackingDistributionSchema.parse({
      ref: created.ref,
      trackingUrl: created.trackingUrl,
      environment: options.environment,
      status: "PENDING",
      destinationUrl: options.destinationUrl,
      platform: "moltbook",
      contentType: "comment",
      feedId: options.feedId,
      sourcePostId: input.opportunity.post.postId,
      sourceUrl: input.opportunity.post.url,
      runId: input.runId,
      opportunityId: input.opportunity.opportunityId,
      candidateId: input.candidate.candidateId,
      preLinkIdentity,
      idempotencyKey,
      createdAt: input.createdAt,
    });
    await options.persistence?.saveTrackingDistribution?.(pending);

    const trackedCandidate = {
      ...input.candidate,
      comment: appendTrackedMarxLink(input.candidate.comment, created.trackingUrl),
    };
    if (trackingLinkCount(trackedCandidate.comment) !== 1) throw new Error("tracked candidate must contain exactly one tracking link");
    const finalQa = runDeterministicQA(trackedCandidate, input.context, input.previousComments, { trackingUrl: created.trackingUrl });
    if (!finalQa.passed) throw new Error(`tracked comment failed deterministic QA: ${finalQa.reasons.join(",")}`);

    return {
      candidate: trackedCandidate,
      tracking: { ref: created.ref, trackingUrl: created.trackingUrl, environment: options.environment },
      finalize: async (action: ActionPayload, experiment: ExperimentRecord): Promise<void> => {
        const finalHash = commentHash(action.content.comment);
        try {
          let finalized;
          try {
            finalized = await options.client.finalizeDistribution(created.ref, {
              actionId: action.actionId,
              experimentId: experiment.experimentId,
              commentHash: finalHash,
            });
          } catch (error) {
            if (!isAmbiguous(error)) throw error;
            const reconciled = await options.client.getSummary(created.ref);
            if (reconciled.status !== "active") throw error;
            finalized = {
              ref: created.ref,
              status: "active" as const,
              actionId: action.actionId,
              experimentId: experiment.experimentId,
              commentHash: finalHash,
            };
          }
          const summary = await options.client.getSummary(created.ref);
          if (summary.status !== "active") throw new Error(`tracker distribution ${created.ref} read-back is not active`);
          const active: TrackingDistribution = TrackingDistributionSchema.parse({
            ...pending,
            status: "ACTIVE",
            actionId: finalized.actionId,
            experimentId: finalized.experimentId,
            commentHash: finalHash,
            totalRedirects: summary.totalRedirects,
            clicked: summary.clicked,
            firstClickedAt: summary.firstClickedAt,
            lastClickedAt: summary.lastClickedAt,
            finalizedAt: new Date().toISOString(),
          });
          await options.persistence?.saveTrackingDistribution?.(active);
        } catch (error) {
          const failed: TrackingDistribution = TrackingDistributionSchema.parse({
            ...pending,
            status: isAmbiguous(error) ? "UNKNOWN" : "FAILED",
            actionId: action.actionId,
            experimentId: experiment.experimentId,
            commentHash: finalHash,
            errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
          await options.persistence?.saveTrackingDistribution?.(failed);
          throw error;
        }
      },
    };
  };
}

function isAmbiguous(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "ambiguous" in error && (error as { ambiguous?: unknown }).ambiguous === true);
}

function assertMarxDestination(value: string, feedId: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "marx.finance" || url.pathname !== `/feed/${encodeURIComponent(feedId)}` || url.search || url.hash) {
    throw new Error("Tracker destination must be the canonical https://marx.finance/feed/<id> URL");
  }
}

function assertMoltbookSource(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.moltbook.com" || !/^\/post\/[^/]+$/u.test(url.pathname) || url.search || url.hash) {
    throw new Error("Tracker source must be an official https://www.moltbook.com/post/<id> URL");
  }
}
