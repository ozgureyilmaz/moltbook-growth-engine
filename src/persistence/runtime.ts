import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { applyMigrations } from "./migrations";
import { jsonText, type SqliteDatabase, withTransaction } from "./database";
import { deterministicId, normalizeText, sha256, stableStringify } from "../domain/identifiers";
import {
  adaptAction,
  adaptCandidate,
  adaptContext,
  adaptEvaluation,
  adaptExperiment,
  adaptOutcomeEvent,
  adaptOpportunity,
  adaptPost,
  adaptRun,
} from "./adapters";
import { ActionSchema, AgentSchema, ExperimentSchema, MarxOutcomeEventSchema, ModelRunRecordSchema, MoltbookPostSchema, OutcomeSchema, PublicationSchema, RunSummarySchema, StrategyStatisticsSchema, TrackingDistributionSchema, WorkerReportSchema, validateActionSecurity, type Action, type MarxOutcomeEvent, type ModelRunRecord, type Outcome, type PostContext, type Publication, type StrategyStatistics, type TrackingDistribution } from "../schemas";
import type { ActionSecurityOptions } from "../schemas";
import type {
  ActionPayload,
  ConversationContext,
  EvaluationResult,
  ExperimentRecord,
  GeneratedCandidate,
  MoltbookPost,
  NoActionDecision,
  Opportunity,
  PersistenceLike,
  RunSummary,
  WorkerReport,
} from "../orchestrator/contracts";

export type RuntimeSaveMetadata = { runId?: string };

type JsonRow = {
  action_json?: string;
  experiment_json?: string;
  metadata_json?: string;
};

type AttributionEntity = "opportunity" | "candidate" | "experiment" | "action";

type AttributionLink = {
  runId: string;
  sourcePostId: string;
  opportunityId?: string;
  candidateId?: string;
  actionId?: string;
  experimentId?: string;
};

type OpportunityLink = AttributionLink & { opportunityId: string };
type CandidateLink = AttributionLink & {
  opportunityId: string;
  candidateId: string;
  strategyFamily: string;
  comment: string;
};

type AttributionRow = {
  attribution_key: string;
  entity_type: AttributionEntity;
  entity_id: string;
  run_id: string;
  source_post_id: string;
  opportunity_id: string | null;
  candidate_id: string | null;
  action_id: string | null;
  experiment_id: string | null;
};

export type ExperimentAttribution = {
  runId: string;
  sourcePostId: string;
  opportunityId?: string;
  candidateId?: string;
  actionId?: string;
  experimentId: string;
};

export type RuntimePersistenceOptions = { runId?: string; actionValidation?: ActionSecurityOptions };

/** Runtime bridge for the orchestrator's public contracts to the local SQLite store. */
export class SqliteRuntimePersistence implements PersistenceLike {
  private readonly pendingOpportunities = new Map<string, Opportunity>();
  private readonly pendingCandidates = new Map<string, GeneratedCandidate>();
  private readonly pendingEvaluations = new Map<string, EvaluationResult>();
  private readonly opportunityLinks = new Map<string, OpportunityLink>();
  private readonly candidateLinks = new Map<string, CandidateLink>();
  private currentRunId?: string;
  private readonly actionValidation: ActionSecurityOptions;

  public constructor(private readonly db: SqliteDatabase, options: RuntimePersistenceOptions = {}) {
    this.currentRunId = options.runId ? this.validateRunId(options.runId) : undefined;
    this.actionValidation = { mode: "dry-run", ...options.actionValidation };
    this.ensureAttributionTable();
  }

  /** Set an explicit run context for callers that persist records before an action or run summary exists. */
  public setRunContext(runId: string): void {
    this.currentRunId = this.validateRunId(runId);
    this.flushPending(this.currentRunId);
  }

  public savePost(post: MoltbookPost): void {
    const parsed = adaptPost(post);
    if (parsed.author.id) {
      const agent = AgentSchema.parse({
        agentId: parsed.author.id,
        platform: "moltbook",
        name: parsed.author.name,
        type: parsed.author.type,
        firstSeenAt: parsed.createdAt,
        lastSeenAt: parsed.fetchedAt,
        metadata: { sourcePostId: parsed.postId },
      });
      this.db.prepare(`INSERT INTO agents (agent_id, platform, name, agent_type, agent_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name,
        agent_type=excluded.agent_type, agent_json=excluded.agent_json, last_seen_at=excluded.last_seen_at`).run(
        agent.agentId, agent.platform, agent.name ?? null, agent.type ?? null, jsonText(agent), agent.firstSeenAt, agent.lastSeenAt,
      );
    }
    this.db.prepare(`INSERT INTO posts (post_id, ingestion_key, url, submolt, author_json, content, created_at, fetched_at, parent_id, engagement_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET
        url=excluded.url, submolt=excluded.submolt, author_json=excluded.author_json,
        content=excluded.content, created_at=excluded.created_at, fetched_at=excluded.fetched_at,
        parent_id=excluded.parent_id, engagement_json=excluded.engagement_json, metadata_json=excluded.metadata_json`).run(
      parsed.postId, deterministicId("ingest", parsed.postId), parsed.url, parsed.submolt, jsonText(parsed.author), parsed.content, parsed.createdAt, parsed.fetchedAt,
      parsed.parentId ?? null, parsed.engagement ? jsonText(parsed.engagement) : null, parsed.metadata ? jsonText(parsed.metadata) : null,
    );
  }

  public saveContext(context: ConversationContext): void {
    const parsed = adaptContext(context);
    this.db.prepare(`INSERT INTO post_contexts (context_id, post_id, context_json, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET context_id=excluded.context_id, context_json=excluded.context_json, fetched_at=excluded.fetched_at`).run(
      parsed.contextId, parsed.post.postId, jsonText(parsed), parsed.fetchedAt,
    );
  }

  public saveOpportunity(opportunity: Opportunity, metadata?: RuntimeSaveMetadata): void {
    const runId = this.useRunContext(metadata?.runId);
    if (!runId) {
      this.pendingOpportunities.set(opportunity.opportunityId, opportunity);
      return;
    }
    this.persistOpportunity(opportunity, runId);
  }

  public saveCandidate(candidate: GeneratedCandidate, metadata?: RuntimeSaveMetadata): void {
    const runId = this.useRunContext(metadata?.runId);
    this.pendingCandidates.set(candidate.candidateId, candidate);
    if (runId) this.flushPending(runId);
  }

  public saveEvaluation(evaluation: EvaluationResult, metadata?: RuntimeSaveMetadata): void {
    const runId = this.useRunContext(metadata?.runId);
    this.pendingEvaluations.set(evaluation.candidateId, evaluation);
    if (runId) this.flushPending(runId);
  }

  public saveAction(action: ActionPayload | NoActionDecision): void {
    const runId = this.requireRunContext(action.metadata.runId);
    this.flushPending(runId);
    const persistedAction = adaptAction(action, this.actionValidation);
    const security = validateActionSecurity(persistedAction, this.actionValidation);
    if (!security.success) throw security.error;
    const postId = action.target?.postId;
    const experimentId = action.action === "COMMENT" ? action.experiment.experimentId : undefined;
    let relation: AttributionLink | undefined;
    if (postId) {
      const opportunityId = this.findOpportunityId(runId, postId);
      relation = {
        runId,
        sourcePostId: postId,
        ...(opportunityId ? { opportunityId } : {}),
        ...(experimentId ? { experimentId } : {}),
        actionId: action.actionId,
      };
      if (experimentId) {
        const experiment = this.getAttributionRow("experiment", experimentId, runId);
        if (experiment && experiment.source_post_id !== postId) {
          throw new Error(`action ${action.actionId} and experiment ${experimentId} reference different source posts`);
        }
        const candidate = this.findCandidateForAction(action, runId, postId);
        if (candidate) {
          relation = { ...relation, opportunityId: candidate.opportunityId, candidateId: candidate.candidateId };
        } else if (experiment) {
          relation = {
            ...relation,
            ...(experiment.opportunity_id ? { opportunityId: experiment.opportunity_id } : {}),
            ...(experiment.candidate_id ? { candidateId: experiment.candidate_id } : {}),
          };
        }
      }
    }

    this.persistAction(persistedAction);
    if (relation) {
      this.recordAttribution("action", action.actionId, relation);
      if (experimentId) {
        this.linkExperimentAndAction(experimentId, action.actionId, runId, postId!);
      }
    }
  }

  public saveExperiment(experiment: ExperimentRecord): void {
    const runId = this.requireRunContext(experiment.runId);
    this.flushPending(runId);
    const candidate = this.findCandidateForExperiment(experiment);
    if (candidate && candidate.sourcePostId !== experiment.sourcePostId) {
      throw new Error(`experiment ${experiment.experimentId} and candidate ${candidate.candidateId} reference different source posts`);
    }
    const opportunityId = candidate?.opportunityId ?? this.findOpportunityId(runId, experiment.sourcePostId);
    const relation: AttributionLink = {
      runId,
      sourcePostId: experiment.sourcePostId,
      experimentId: experiment.experimentId,
      ...(opportunityId ? { opportunityId } : {}),
      ...(candidate ? { candidateId: candidate.candidateId } : {}),
    };

    const persistedExperiment = adaptExperiment(experiment, candidate, new Date().toISOString());
    const existing = this.db.prepare("SELECT run_id, source_post_id FROM experiments WHERE experiment_id = ?").get<{ run_id: string; source_post_id: string }>(experiment.experimentId);
    if (existing && (existing.run_id !== runId || existing.source_post_id !== experiment.sourcePostId)) {
      throw new Error(`experiment ${experiment.experimentId} is already attributed to another run or source post`);
    }
    this.db.prepare(`INSERT INTO experiments (experiment_id, run_id, source_post_id, comment_hash, strategy_family, experiment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET run_id=excluded.run_id, source_post_id=excluded.source_post_id,
        comment_hash=excluded.comment_hash, strategy_family=excluded.strategy_family, experiment_json=excluded.experiment_json`).run(
      persistedExperiment.experimentId, runId, persistedExperiment.sourcePostId, persistedExperiment.commentHash, persistedExperiment.strategyFamily, jsonText(persistedExperiment), persistedExperiment.createdAt,
    );
    this.recordAttribution("experiment", experiment.experimentId, relation);
    if (candidate) {
      this.recordAttribution("candidate", candidate.candidateId, relation);
    }
    const action = this.findActionForExperiment(runId, experiment.experimentId);
    if (action) {
      this.recordAttribution("experiment", experiment.experimentId, { ...relation, actionId: action.action_id });
      this.recordAttribution("action", action.action_id, { ...relation, actionId: action.action_id });
    }
  }

  public getRecentComments(limit = 200): string[] {
    return this.db.prepare("SELECT action_json FROM actions WHERE action_type = 'COMMENT' ORDER BY created_at DESC LIMIT ?").all<JsonRow>(limit)
      .map((row) => { try { return JSON.parse(row.action_json ?? "{}").content?.comment as string; } catch { return ""; } }).filter(Boolean);
  }

  public getAction(actionId: string): ActionPayload | NoActionDecision | undefined {
    const row = this.db.prepare("SELECT action_json FROM actions WHERE action_id = ?").get<{ action_json?: string }>(actionId);
    if (!row?.action_json) return undefined;
    return ActionSchema.parse(JSON.parse(row.action_json)) as ActionPayload | NoActionDecision;
  }

  public getExperiments(): ExperimentRecord[] {
    const durableOutcomes = new Map(
      this.db.prepare("SELECT experiment_id, outcome_json FROM outcomes").all<{ experiment_id: string; outcome_json: string }>()
        .flatMap((row) => {
          try { return [[row.experiment_id, OutcomeSchema.parse(JSON.parse(row.outcome_json))] as const]; } catch { return []; }
        }),
    );
    return this.db.prepare("SELECT experiment_json FROM experiments ORDER BY created_at DESC").all<JsonRow>()
      .flatMap((row) => {
        try {
          const persisted = ExperimentSchema.parse(JSON.parse(row.experiment_json ?? "{}"));
          const durable = durableOutcomes.get(persisted.experimentId);
          const observed = durable ?? persisted.outcome;
          return [{
            ...persisted,
            outcome: observed ? {
              replyReceived: observed.replyReceived,
              replyLatencyMs: observed.replyLatencySeconds === undefined ? undefined : observed.replyLatencySeconds * 1000,
              reactionCount: observed.reactionCount,
              targetAgentEngaged: observed.targetAgentEngaged,
              marxMentionedByTargetAfterward: observed.marxMentionedByTargetAfterward,
              marxInvestigationSignal: observed.marxInvestigationSignal ?? observed.marxDiscussionVisitSignal,
              marxInteractionSignal: observed.marxInteractionSignal,
              marxUsageSignal: observed.marxUsageSignal,
            } : undefined,
          } as ExperimentRecord];
        } catch { return []; }
      });
  }

  /** Return the durable run/source/entity chain for one experiment. */
  public getExperimentAttribution(experimentId: string): ExperimentAttribution | undefined {
    const experimentRow = this.getAttributionRow("experiment", experimentId);
    const experiment = experimentRow ?? this.db.prepare("SELECT run_id, source_post_id FROM experiments WHERE experiment_id = ?").get<{ run_id: string; source_post_id: string }>(experimentId);
    if (!experiment) return undefined;

    const runId = experiment.run_id;
    const sourcePostId = experiment.source_post_id;
    const actionId = experimentRow?.action_id ?? this.findActionForExperiment(runId, experimentId)?.action_id;
    const action = actionId ? this.getAttributionRow("action", actionId, runId) : undefined;
    const candidateId = experimentRow?.candidate_id ?? action?.candidate_id ?? this.findCandidateForExperimentRow(runId, sourcePostId, experimentId)?.candidateId;
    const candidate = candidateId ? this.getAttributionRow("candidate", candidateId, runId) : undefined;
    const opportunityId = experimentRow?.opportunity_id ?? candidate?.opportunity_id ?? action?.opportunity_id ?? this.findOpportunityId(runId, sourcePostId);
    return {
      runId,
      sourcePostId,
      experimentId,
      ...(opportunityId ? { opportunityId } : {}),
      ...(candidateId ? { candidateId } : {}),
      ...(actionId ? { actionId } : {}),
    };
  }

  public saveRun(summary: RunSummary): void {
    const runId = this.requireRunContext(summary.runId);
    this.flushPending(runId);
    const parsedSummary = RunSummarySchema.parse(summary);
    const existing = this.db.prepare("SELECT started_at FROM runs WHERE run_id = ?").get<{ started_at: string }>(runId);
    if (existing && existing.started_at !== parsedSummary.startTime) throw new Error(`duplicate run ID ${runId} belongs to a different run`);
    const persistedRun = adaptRun(parsedSummary);
    const counts = {
      postsDiscovered: summary.discovered, postsDeduplicated: summary.deduplicated, postsAnalyzed: summary.analyzed,
      opportunitiesQualified: summary.qualified, commentsGenerated: summary.generated, commentsRejected: summary.rejected,
      actionsEmitted: summary.actionsEmitted, errors: summary.errors, modelCalls: summary.modelCalls, retries: 0,
    };
    this.db.prepare(`INSERT INTO runs (run_id, status, started_at, finished_at, counts_json, error_messages_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, finished_at=excluded.finished_at,
        counts_json=excluded.counts_json, error_messages_json=excluded.error_messages_json, metadata_json=excluded.metadata_json`).run(
      runId, persistedRun.status, persistedRun.startedAt, persistedRun.finishedAt ?? null, jsonText(persistedRun.counts), jsonText(persistedRun.errorMessages), jsonText(parsedSummary),
    );
    this.currentRunId = undefined;
  }

  public saveWorkerReport(report: WorkerReport): void {
    const parsed = WorkerReportSchema.parse(report);
    this.db.prepare(`INSERT INTO worker_reports (report_id, run_id, task_id, worker, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET report_json=excluded.report_json`).run(
      parsed.reportId, parsed.runId, parsed.taskId, parsed.worker, jsonText(parsed), parsed.createdAt,
    );
  }

  public savePublication(publication: Publication): void {
    const parsed = PublicationSchema.parse(publication);
    const existing = this.db.prepare("SELECT publication_json FROM publications WHERE action_id = ?").get<{ publication_json: string }>(parsed.actionId);
    if (existing) {
      const prior = PublicationSchema.parse(JSON.parse(existing.publication_json) as unknown);
      if (prior.status === "published" && parsed.status !== "published") throw new Error(`publication ${parsed.actionId} cannot regress from published`);
      if (prior.status === "published" && prior.publicationId !== parsed.publicationId) throw new Error(`publication ${parsed.actionId} already has a different receipt`);
      if (prior.publicationId !== parsed.publicationId && parsed.status !== "published") throw new Error(`publication ${parsed.actionId} already has a different terminal receipt`);
      if (prior.publicationId !== parsed.publicationId && prior.status !== "published" && parsed.status === "published") {
        this.db.prepare(`UPDATE publications SET publication_id = ?, experiment_id = ?, status = ?, publication_json = ?, acknowledged_at = ?, error_message = ? WHERE action_id = ?`).run(
          parsed.publicationId, parsed.experimentId ?? null, parsed.status, jsonText(parsed), parsed.acknowledgedAt ?? null, parsed.errorMessage ?? null, parsed.actionId,
        );
        return;
      }
    }
    this.db.prepare(`INSERT INTO publications (publication_id, action_id, experiment_id, status, publication_json, created_at, acknowledged_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(publication_id) DO UPDATE SET status=excluded.status,
      publication_json=excluded.publication_json, acknowledged_at=excluded.acknowledged_at, error_message=excluded.error_message`).run(
      parsed.publicationId, parsed.actionId, parsed.experimentId ?? null, parsed.status, jsonText(parsed), parsed.attemptedAt ?? new Date().toISOString(), parsed.acknowledgedAt ?? null, parsed.errorMessage ?? null,
    );
  }

  public saveTrackingDistribution(distribution: TrackingDistribution): void {
    const parsed = TrackingDistributionSchema.parse(distribution);
    this.db.prepare(`INSERT INTO tracking_distributions
      (ref, tracking_url, environment, status, destination_url, platform, content_type, feed_id,
       source_post_id, source_url, run_id, opportunity_id, candidate_id, pre_link_identity,
       idempotency_key, action_id, experiment_id, comment_hash, total_redirects, clicked,
       first_clicked_at, last_clicked_at, created_at, finalized_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET tracking_url=excluded.tracking_url, environment=excluded.environment,
        status=excluded.status, destination_url=excluded.destination_url, platform=excluded.platform,
        content_type=excluded.content_type, feed_id=excluded.feed_id, source_post_id=excluded.source_post_id,
        source_url=excluded.source_url, run_id=excluded.run_id, opportunity_id=excluded.opportunity_id,
        candidate_id=excluded.candidate_id, pre_link_identity=excluded.pre_link_identity,
        idempotency_key=excluded.idempotency_key, action_id=excluded.action_id,
        experiment_id=excluded.experiment_id, comment_hash=excluded.comment_hash,
        total_redirects=excluded.total_redirects, clicked=excluded.clicked,
        first_clicked_at=excluded.first_clicked_at, last_clicked_at=excluded.last_clicked_at,
        created_at=excluded.created_at, finalized_at=excluded.finalized_at,
        error_message=excluded.error_message`).run(
      parsed.ref,
      parsed.trackingUrl,
      parsed.environment,
      parsed.status,
      parsed.destinationUrl,
      parsed.platform,
      parsed.contentType,
      parsed.feedId,
      parsed.sourcePostId,
      parsed.sourceUrl,
      parsed.runId,
      parsed.opportunityId,
      parsed.candidateId,
      parsed.preLinkIdentity,
      parsed.idempotencyKey,
      parsed.actionId ?? null,
      parsed.experimentId ?? null,
      parsed.commentHash ?? null,
      parsed.totalRedirects ?? null,
      parsed.clicked === undefined ? null : parsed.clicked ? 1 : 0,
      parsed.firstClickedAt ?? null,
      parsed.lastClickedAt ?? null,
      parsed.createdAt,
      parsed.finalizedAt ?? null,
      parsed.errorMessage ?? null,
    );
  }

  public getTrackingDistributionByActionId(actionId: string): TrackingDistribution | undefined {
    const row = this.db.prepare("SELECT * FROM tracking_distributions WHERE action_id = ?").get<Record<string, unknown>>(actionId);
    if (!row) return undefined;
    return TrackingDistributionSchema.parse({
      ref: row.ref,
      trackingUrl: row.tracking_url,
      environment: row.environment,
      status: row.status,
      destinationUrl: row.destination_url,
      platform: row.platform,
      contentType: row.content_type,
      feedId: row.feed_id,
      sourcePostId: row.source_post_id,
      sourceUrl: row.source_url,
      runId: row.run_id,
      opportunityId: row.opportunity_id,
      candidateId: row.candidate_id,
      preLinkIdentity: row.pre_link_identity,
      idempotencyKey: row.idempotency_key,
      ...(typeof row.action_id === "string" ? { actionId: row.action_id } : {}),
      ...(typeof row.experiment_id === "string" ? { experimentId: row.experiment_id } : {}),
      ...(typeof row.comment_hash === "string" ? { commentHash: row.comment_hash } : {}),
      ...(typeof row.total_redirects === "number" ? { totalRedirects: row.total_redirects } : {}),
      ...(typeof row.clicked === "number" ? { clicked: row.clicked === 1 } : {}),
      ...(typeof row.first_clicked_at === "string" ? { firstClickedAt: row.first_clicked_at } : row.first_clicked_at === null ? { firstClickedAt: null } : {}),
      ...(typeof row.last_clicked_at === "string" ? { lastClickedAt: row.last_clicked_at } : row.last_clicked_at === null ? { lastClickedAt: null } : {}),
      createdAt: row.created_at,
      ...(typeof row.finalized_at === "string" ? { finalizedAt: row.finalized_at } : {}),
      ...(typeof row.error_message === "string" ? { errorMessage: row.error_message } : {}),
    });
  }

  public saveOutcome(outcome: Outcome): void {
    const parsed = OutcomeSchema.parse(outcome);
    const actionId = typeof parsed.metadata?.actionId === "string" ? parsed.metadata.actionId : undefined;
    const sourcePostId = typeof parsed.metadata?.sourcePostId === "string" ? parsed.metadata.sourcePostId : undefined;
    if (!actionId || !sourcePostId || parsed.metadata?.evidenceStatus !== "verified") {
      throw new Error("durable outcomes require verified publication-bound attribution metadata");
    }
    const publication = this.getPublicationByActionId(actionId);
    if (!publication || publication.status !== "published" || publication.experimentId !== parsed.experimentId) {
      throw new Error(`outcome ${parsed.outcomeId} requires a matching published receipt`);
    }
    if (publication.metadata?.evidenceStatus !== "verified" || publication.metadata?.targetPostId !== sourcePostId) {
      throw new Error(`outcome ${parsed.outcomeId} publication evidence does not match its source post`);
    }
    if (!publication.acknowledgedAt || Date.parse(parsed.observedAt) < Date.parse(publication.acknowledgedAt)) {
      throw new Error(`outcome ${parsed.outcomeId} must be observed after verified publication`);
    }
    this.db.prepare(`INSERT INTO outcomes (outcome_id, experiment_id, run_id, outcome_json, observed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(experiment_id) DO UPDATE SET outcome_id=excluded.outcome_id,
      run_id=excluded.run_id, outcome_json=excluded.outcome_json, observed_at=excluded.observed_at`).run(
      parsed.outcomeId, parsed.experimentId, parsed.runId, jsonText(parsed), parsed.observedAt,
    );
  }

  public saveOutcomeEvent(event: MarxOutcomeEvent): void {
    const parsed = adaptOutcomeEvent(event);
    const existing = this.db.prepare("SELECT event_json FROM outcome_events WHERE event_id = ?").get<{ event_json: string }>(parsed.eventId);
    if (existing && stableStringify(JSON.parse(existing.event_json)) !== stableStringify(parsed)) throw new Error(`outcome event ${parsed.eventId} is immutable`);
    if (existing) return;
    const evidenceKey = parsed.evidenceStatus === "verified"
      ? sha256(stableStringify({ source: parsed.source, eventType: parsed.eventType, evidenceId: parsed.evidenceId }))
      : null;
    if (evidenceKey) {
      const priorEvidence = this.db.prepare("SELECT event_id FROM outcome_events WHERE evidence_key = ?").get<{ event_id: string }>(evidenceKey);
      if (priorEvidence) throw new Error(`verified outcome evidence is already attributed to event ${priorEvidence.event_id}`);
    }
    this.db.prepare(`INSERT INTO outcome_events
      (event_id, action_id, experiment_id, run_id, event_type, evidence_status, event_json, occurred_at, observed_at, evidence_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.eventId, parsed.actionId, parsed.experimentId, parsed.runId, parsed.eventType, parsed.evidenceStatus,
      jsonText(parsed), parsed.occurredAt, parsed.observedAt, evidenceKey,
    );
  }

  public listOutcomeEvents(experimentId: string): MarxOutcomeEvent[] {
    return this.db.prepare("SELECT event_json FROM outcome_events WHERE experiment_id = ? ORDER BY observed_at, event_id")
      .all<{ event_json: string }>(experimentId)
      .map((row) => MarxOutcomeEventSchema.parse(JSON.parse(row.event_json) as unknown));
  }

  public getPublicationByActionId(actionId: string): Publication | undefined {
    const row = this.db.prepare("SELECT publication_json FROM publications WHERE action_id = ?").get<{ publication_json: string }>(actionId);
    return row ? PublicationSchema.parse(JSON.parse(row.publication_json) as unknown) : undefined;
  }

  public saveStrategyStatistics(statistics: StrategyStatistics): void {
    const parsed = StrategyStatisticsSchema.parse(statistics);
    const dimensionsKey = jsonText(parsed.dimensions ?? {});
    this.db.prepare(`INSERT INTO strategy_statistics (statistics_id, strategy_family, dimensions_key, statistics_json, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(strategy_family, dimensions_key) DO UPDATE SET statistics_id=excluded.statistics_id,
      statistics_json=excluded.statistics_json, updated_at=excluded.updated_at`).run(
      parsed.statisticsId, parsed.strategyFamily, dimensionsKey, jsonText(parsed), parsed.updatedAt,
    );
  }

  public saveModelRun(modelRun: ModelRunRecord): void {
    const parsed = ModelRunRecordSchema.parse(modelRun);
    this.db.prepare(`INSERT INTO model_runs (model_run_id, run_id, task_id, status, model_run_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(model_run_id) DO UPDATE SET status=excluded.status,
      model_run_json=excluded.model_run_json`).run(
      parsed.modelRunId, parsed.runId, parsed.taskId, parsed.status, jsonText(parsed), parsed.startedAt,
    );
  }

  public getRun(runId: string): RunSummary | undefined {
    const row = this.db.prepare("SELECT metadata_json FROM runs WHERE run_id = ?").get<JsonRow>(runId);
    if (!row?.metadata_json) return undefined;
    try { return RunSummarySchema.parse(JSON.parse(row.metadata_json)) as RunSummary; } catch { return undefined; }
  }

  public listRuns(limit = 100): RunSummary[] {
    return this.db.prepare("SELECT metadata_json FROM runs ORDER BY started_at DESC LIMIT ?").all<{ metadata_json?: string }>(limit)
      .flatMap((row) => {
        try { return row.metadata_json ? [RunSummarySchema.parse(JSON.parse(row.metadata_json)) as RunSummary] : []; } catch { return []; }
      });
  }

  private ensureAttributionTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_attribution (
        attribution_key TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        opportunity_id TEXT,
        candidate_id TEXT,
        action_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_attribution_experiment
        ON runtime_attribution(run_id, experiment_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_attribution_source
        ON runtime_attribution(run_id, source_post_id);
    `);
  }

  private validateRunId(runId: string): string {
    const normalized = normalizeText(runId);
    if (!normalized || normalized === "runtime") throw new Error("persistence requires the actual run id; the literal runtime id is not permitted");
    return normalized;
  }

  private useRunContext(runId?: string): string | undefined {
    if (runId) {
      const validated = this.validateRunId(runId);
      if (this.currentRunId && this.currentRunId !== validated) {
        throw new Error(`persistence run context changed from ${this.currentRunId} to ${validated}`);
      }
      this.currentRunId = validated;
    }
    return this.currentRunId;
  }

  private requireRunContext(runId?: string): string {
    const resolved = this.useRunContext(runId);
    if (!resolved) throw new Error("persistence requires a real run id before saving this record");
    return resolved;
  }

  private flushPending(runId: string): void {
    const pendingOpportunities = [...this.pendingOpportunities.values()];
    const pendingCandidates = [...this.pendingCandidates.values()];
    const pendingEvaluations = [...this.pendingEvaluations.values()];
    const candidateRelations = pendingCandidates.map((candidate) => ({ candidate, link: this.resolveCandidateLink(candidate, runId, pendingOpportunities) }));
    const evaluationRelations = pendingEvaluations.map((evaluation) => ({ evaluation, link: this.resolveEvaluationLink(evaluation, runId, pendingCandidates, candidateRelations) }));

    withTransaction(this.db, () => {
      for (const opportunity of pendingOpportunities) this.persistOpportunityRow(opportunity, runId);
      for (const { candidate, link } of candidateRelations) this.persistCandidateRow(candidate, link);
      for (const { evaluation, link } of evaluationRelations) this.persistEvaluationRow(evaluation, link.runId);
    });

    for (const opportunity of pendingOpportunities) {
      this.rememberOpportunityLink({ runId, sourcePostId: opportunity.post.postId, opportunityId: opportunity.opportunityId });
      this.pendingOpportunities.delete(opportunity.opportunityId);
      this.recordAttribution("opportunity", opportunity.opportunityId, { runId, sourcePostId: opportunity.post.postId, opportunityId: opportunity.opportunityId });
    }
    for (const { candidate, link } of candidateRelations) {
      const candidateLink: CandidateLink = { ...link, candidateId: candidate.candidateId, strategyFamily: candidate.strategyFamily, comment: candidate.comment };
      this.rememberCandidateLink(candidateLink);
      this.pendingCandidates.delete(candidate.candidateId);
      this.recordAttribution("candidate", candidate.candidateId, candidateLink);
    }
    for (const { evaluation } of evaluationRelations) this.pendingEvaluations.delete(evaluation.candidateId);
  }

  private resolveCandidateLink(candidate: GeneratedCandidate, runId: string, pendingOpportunities: Opportunity[]): OpportunityLink {
    const pending = pendingOpportunities.find((opportunity) => opportunity.opportunityId === candidate.opportunityId);
    const link = pending
      ? { runId, sourcePostId: pending.post.postId, opportunityId: pending.opportunityId }
      : this.findOpportunityLink(runId, candidate.opportunityId);
    if (!link) throw new Error(`candidate ${candidate.candidateId} cannot be attributed without opportunity ${candidate.opportunityId}`);
    return link;
  }

  private resolveEvaluationLink(
    evaluation: EvaluationResult,
    runId: string,
    pendingCandidates: GeneratedCandidate[],
    candidateRelations: Array<{ candidate: GeneratedCandidate; link: OpportunityLink }>,
  ): CandidateLink {
    const pending = pendingCandidates.find((candidate) => candidate.candidateId === evaluation.candidateId);
    const link = pending
      ? candidateRelations.find((candidate) => candidate.candidate.candidateId === pending.candidateId)?.link
      : this.findCandidateLink(runId, evaluation.candidateId);
    if (!link) throw new Error(`evaluation for candidate ${evaluation.candidateId} cannot be attributed without that candidate`);
    return {
      ...link,
      candidateId: evaluation.candidateId,
      strategyFamily: pending?.strategyFamily ?? this.findCandidateLink(runId, evaluation.candidateId)?.strategyFamily ?? "unknown",
      comment: pending?.comment ?? this.findCandidateLink(runId, evaluation.candidateId)?.comment ?? "",
    };
  }

  private persistOpportunity(opportunity: Opportunity, runId: string): void {
    this.persistOpportunityRow(opportunity, runId);
    this.rememberOpportunityLink({ runId, sourcePostId: opportunity.post.postId, opportunityId: opportunity.opportunityId });
    this.recordAttribution("opportunity", opportunity.opportunityId, { runId, sourcePostId: opportunity.post.postId, opportunityId: opportunity.opportunityId });
  }

  private persistOpportunityRow(opportunity: Opportunity, runId: string): void {
    const persisted = adaptOpportunity(opportunity, runId, opportunity.post.fetchedAt);
    this.db.prepare(`INSERT INTO opportunities (opportunity_id, run_id, post_id, final_score, opportunity_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(opportunity_id) DO UPDATE SET run_id=excluded.run_id, post_id=excluded.post_id,
        final_score=excluded.final_score, opportunity_json=excluded.opportunity_json`).run(
      persisted.opportunityId, persisted.runId, persisted.postId, persisted.finalScore, jsonText(persisted), persisted.createdAt,
    );
  }

  private persistCandidateRow(candidate: GeneratedCandidate, link: OpportunityLink): void {
    const persisted = adaptCandidate(candidate, { runId: link.runId, sourcePostId: link.sourcePostId }, new Date().toISOString());
    this.db.prepare(`INSERT INTO comment_candidates (candidate_id, opportunity_id, run_id, post_id, candidate_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET opportunity_id=excluded.opportunity_id, run_id=excluded.run_id,
        post_id=excluded.post_id, candidate_json=excluded.candidate_json, generated_at=excluded.generated_at`).run(
      persisted.candidateId, persisted.opportunityId, persisted.runId, persisted.postId, jsonText(persisted), persisted.generatedAt,
    );
  }

  private persistEvaluationRow(evaluation: EvaluationResult, runId: string): void {
    const persisted = adaptEvaluation(evaluation, runId, new Date().toISOString());
    this.db.prepare(`INSERT INTO evaluations (evaluation_id, candidate_id, run_id, recommendation, evaluation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(evaluation_id) DO UPDATE SET candidate_id=excluded.candidate_id, run_id=excluded.run_id,
        recommendation=excluded.recommendation, evaluation_json=excluded.evaluation_json, created_at=excluded.created_at`).run(
      persisted.evaluationId, persisted.candidateId, persisted.runId, persisted.recommendation, jsonText(persisted), persisted.createdAt,
    );
  }

  private persistAction(action: Action): void {
    this.db.prepare(`INSERT INTO actions (action_id, action_type, idempotency_key, action_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET action_type=excluded.action_type, action_json=excluded.action_json,
        created_at=excluded.created_at`).run(
      action.actionId, action.action, deterministicId("action", action.actionId), jsonText(ActionSchema.parse(action)), action.metadata.createdAt,
    );
  }

  private rememberOpportunityLink(link: OpportunityLink): void {
    this.opportunityLinks.set(this.linkKey(link.runId, link.opportunityId), link);
  }

  private rememberCandidateLink(link: CandidateLink): void {
    this.candidateLinks.set(this.linkKey(link.runId, link.candidateId), link);
  }

  private findOpportunityLink(runId: string, opportunityId: string): OpportunityLink | undefined {
    const remembered = this.opportunityLinks.get(this.linkKey(runId, opportunityId));
    if (remembered) return remembered;
    const row = this.db.prepare("SELECT run_id, post_id, opportunity_id FROM opportunities WHERE run_id = ? AND opportunity_id = ?").get<{ run_id: string; post_id: string; opportunity_id: string }>(runId, opportunityId);
    if (!row) return undefined;
    const link = { runId: row.run_id, sourcePostId: row.post_id, opportunityId: row.opportunity_id };
    this.rememberOpportunityLink(link);
    return link;
  }

  private findCandidateLink(runId: string, candidateId: string): CandidateLink | undefined {
    const remembered = this.candidateLinks.get(this.linkKey(runId, candidateId));
    if (remembered) return remembered;
    const row = this.db.prepare("SELECT run_id, post_id, opportunity_id, candidate_id, candidate_json FROM comment_candidates WHERE run_id = ? AND candidate_id = ?").get<{ run_id: string; post_id: string; opportunity_id: string; candidate_id: string; candidate_json: string }>(runId, candidateId);
    if (!row) return undefined;
    const candidate = this.parseCandidate(row.candidate_json);
    const link: CandidateLink = {
      runId: row.run_id,
      sourcePostId: row.post_id,
      opportunityId: row.opportunity_id,
      candidateId: row.candidate_id,
      strategyFamily: candidate.strategyFamily,
      comment: candidate.comment,
    };
    this.rememberCandidateLink(link);
    return link;
  }

  private findCandidateForExperiment(experiment: ExperimentRecord): CandidateLink | undefined {
    const candidates = this.listCandidateLinks(experiment.runId, experiment.sourcePostId)
      .filter((candidate) => candidate.strategyFamily === experiment.strategyFamily);
    const hashMatches = candidates.filter((candidate) => this.commentMatchesHash(candidate.comment, experiment.commentHash));
    if (hashMatches.length > 1) throw new Error(`experiment ${experiment.experimentId} matches multiple candidates`);
    return hashMatches[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  private findCandidateForExperimentRow(runId: string, sourcePostId: string, experimentId: string): CandidateLink | undefined {
    const row = this.db.prepare("SELECT strategy_family, comment_hash FROM experiments WHERE experiment_id = ?").get<{ strategy_family: string; comment_hash: string }>(experimentId);
    if (!row) return undefined;
    const candidates = this.listCandidateLinks(runId, sourcePostId).filter((candidate) => candidate.strategyFamily === row.strategy_family);
    return candidates.find((candidate) => this.commentMatchesHash(candidate.comment, row.comment_hash)) ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  private listCandidateLinks(runId: string, sourcePostId: string): CandidateLink[] {
    const remembered = [...this.candidateLinks.values()].filter((candidate) => candidate.runId === runId && candidate.sourcePostId === sourcePostId);
    const rows = this.db.prepare("SELECT run_id, post_id, opportunity_id, candidate_id, candidate_json FROM comment_candidates WHERE run_id = ? AND post_id = ?").all<{ run_id: string; post_id: string; opportunity_id: string; candidate_id: string; candidate_json: string }>(runId, sourcePostId);
    const links = [...remembered];
    for (const row of rows) {
      if (links.some((link) => link.candidateId === row.candidate_id)) continue;
      const candidate = this.parseCandidate(row.candidate_json);
      links.push({ runId: row.run_id, sourcePostId: row.post_id, opportunityId: row.opportunity_id, candidateId: row.candidate_id, strategyFamily: candidate.strategyFamily, comment: candidate.comment });
    }
    return links;
  }

  private findOpportunityId(runId: string, sourcePostId: string): string | undefined {
    const remembered = [...this.opportunityLinks.values()].find((link) => link.runId === runId && link.sourcePostId === sourcePostId);
    if (remembered) return remembered.opportunityId;
    const row = this.db.prepare("SELECT opportunity_id FROM opportunities WHERE run_id = ? AND post_id = ? ORDER BY created_at DESC LIMIT 1").get<{ opportunity_id: string }>(runId, sourcePostId);
    return row?.opportunity_id;
  }

  private findCandidateForAction(action: ActionPayload | NoActionDecision, runId: string, sourcePostId: string): CandidateLink | undefined {
    if (action.action !== "COMMENT") return undefined;
    const exact = this.listCandidateLinks(runId, sourcePostId).filter((candidate) => normalizeText(candidate.comment) === normalizeText(action.content.comment));
    if (exact.length > 1) throw new Error(`action ${action.actionId} matches multiple candidates`);
    return exact[0];
  }

  private findActionForExperiment(runId: string, experimentId: string): { action_id: string } | undefined {
    const rows = this.db.prepare("SELECT action_id, action_json FROM actions WHERE action_type = 'COMMENT'").all<{ action_id: string; action_json: string }>();
    for (const row of rows) {
      try {
        const action = JSON.parse(row.action_json) as ActionPayload;
        if (action.metadata.runId === runId && action.action === "COMMENT" && action.experiment.experimentId === experimentId) return { action_id: row.action_id };
      } catch {
        // Ignore malformed historical rows; they are not safe attribution inputs.
      }
    }
    return undefined;
  }

  private linkExperimentAndAction(experimentId: string, actionId: string, runId: string, sourcePostId: string): void {
    const experiment = this.getAttributionRow("experiment", experimentId, runId);
    if (!experiment) return;
    const action = this.getAttributionRow("action", actionId, runId);
    const opportunityId = experiment.opportunity_id ?? action?.opportunity_id ?? undefined;
    const candidateId = experiment.candidate_id ?? action?.candidate_id ?? undefined;
    const relation: AttributionLink = {
      runId,
      sourcePostId,
      experimentId,
      actionId,
      ...(opportunityId ? { opportunityId } : {}),
      ...(candidateId ? { candidateId } : {}),
    };
    this.recordAttribution("experiment", experimentId, relation);
    this.recordAttribution("action", actionId, relation);
  }

  private getAttributionRow(entityType: AttributionEntity, entityId: string, runId?: string): AttributionRow | undefined {
    const whereRun = runId ? " AND run_id = ?" : "";
    return this.db.prepare(`SELECT attribution_key, entity_type, entity_id, run_id, source_post_id, opportunity_id, candidate_id, action_id, experiment_id
      FROM runtime_attribution WHERE entity_type = ? AND entity_id = ?${whereRun} ORDER BY created_at DESC LIMIT 1`).get<AttributionRow>(...(runId ? [entityType, entityId, runId] : [entityType, entityId]));
  }

  private recordAttribution(entityType: AttributionEntity, entityId: string, link: AttributionLink): void {
    const key = deterministicId("runtime-attribution", link.runId, entityType, entityId);
    const existing = this.db.prepare("SELECT * FROM runtime_attribution WHERE attribution_key = ?").get<AttributionRow>(key);
    const merged = {
      runId: link.runId,
      sourcePostId: link.sourcePostId,
      opportunityId: link.opportunityId ?? existing?.opportunity_id ?? null,
      candidateId: link.candidateId ?? existing?.candidate_id ?? null,
      actionId: link.actionId ?? existing?.action_id ?? null,
      experimentId: link.experimentId ?? existing?.experiment_id ?? null,
    };
    if (existing) {
      if (existing.run_id !== merged.runId || existing.source_post_id !== merged.sourcePostId) throw new Error(`${entityType} ${entityId} changed run or source post`);
      for (const [field, value] of [["opportunity_id", merged.opportunityId], ["candidate_id", merged.candidateId], ["action_id", merged.actionId], ["experiment_id", merged.experimentId]] as const) {
        if (existing[field] && value && existing[field] !== value) throw new Error(`${entityType} ${entityId} changed ${field}`);
      }
    }
    this.db.prepare(`INSERT INTO runtime_attribution
      (attribution_key, entity_type, entity_id, run_id, source_post_id, opportunity_id, candidate_id, action_id, experiment_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attribution_key) DO UPDATE SET source_post_id=excluded.source_post_id,
        opportunity_id=excluded.opportunity_id, candidate_id=excluded.candidate_id,
        action_id=excluded.action_id, experiment_id=excluded.experiment_id`).run(
      key, entityType, entityId, merged.runId, merged.sourcePostId, merged.opportunityId, merged.candidateId, merged.actionId, merged.experimentId, new Date().toISOString(),
    );
  }

  private parseCandidate(value: string): Pick<GeneratedCandidate, "strategyFamily" | "comment"> {
    const candidate = JSON.parse(value) as Partial<GeneratedCandidate>;
    if (typeof candidate.strategyFamily !== "string" || typeof candidate.comment !== "string") throw new Error("candidate row has invalid attribution data");
    return { strategyFamily: candidate.strategyFamily, comment: candidate.comment };
  }

  private commentMatchesHash(comment: string, expected: string): boolean {
    return expected === sha256(normalizeText(comment));
  }

  private linkKey(runId: string, entityId: string): string {
    return `${runId}\u0000${entityId}`;
  }
}

export async function openRuntimePersistence(
  path = process.env.MARX_GROWTH_DB ?? "data/marx_growth.sqlite",
  options: RuntimePersistenceOptions = {},
): Promise<{ persistence: SqliteRuntimePersistence; db: Database.Database }> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  applyMigrations(db as unknown as SqliteDatabase);
  return { persistence: new SqliteRuntimePersistence(db as unknown as SqliteDatabase, options), db };
}
