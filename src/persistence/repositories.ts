import {
  Agent,
  AgentSchema,
  Action,
  ActionSchema,
  CommentCandidate,
  CommentCandidateSchema,
  Experiment,
  ExperimentSchema,
  Evaluation,
  EvaluationSchema,
  ModelRunRecord,
  ModelRunRecordSchema,
  MoltbookPost,
  MoltbookPostSchema,
  Outcome,
  OutcomeSchema,
  Opportunity,
  OpportunitySchema,
  Publication,
  PublicationSchema,
  PostContext,
  PostContextSchema,
  Run,
  RunSchema,
  StrategyStatistics,
  StrategyStatisticsSchema,
  WorkerReport,
  WorkerReportSchema,
  validateActionSecurity,
  type ActionSecurityOptions,
} from "../schemas";
import {
  actionIdempotencyKey,
  deterministicId,
  idempotencyKeyFor,
  postIngestionKey,
} from "../domain/identifiers";
import { jsonText, nullable, parseJson, SqliteDatabase } from "./database";

type Row = Record<string, unknown>;

export class AgentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Agent): Agent {
    const agent = AgentSchema.parse(value);
    this.db.prepare(`INSERT INTO agents (agent_id, platform, name, agent_type, agent_json, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name,
      agent_type=excluded.agent_type, agent_json=excluded.agent_json, last_seen_at=excluded.last_seen_at`).run(
      agent.agentId, agent.platform, agent.name ?? null, agent.type ?? null, jsonText(agent), agent.firstSeenAt, agent.lastSeenAt,
    );
    return agent;
  }

  getById(agentId: string): Agent | undefined {
    const row = this.db.prepare("SELECT agent_json FROM agents WHERE agent_id = ?").get<Row>(agentId);
    return row ? AgentSchema.parse(parseJson(row.agent_json)) : undefined;
  }
}

export class RunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Run): Run {
    let run = RunSchema.parse(value);
    const existing = this.db.prepare("SELECT run_id, status, started_at FROM runs WHERE run_id = ?").get<{ run_id: string; status: string; started_at: string }>(run.runId);
    // A completed/failed row with the same generated id represents a distinct
    // run, not a retry of the same in-flight record. Preserve both rows.
    if (existing && (existing.started_at !== run.startedAt || (existing.status !== "RUNNING" && run.status === "RUNNING"))) {
      run = RunSchema.parse({
        ...run,
        runId: deterministicId("run", run.runId, run.startedAt, run.finishedAt ?? run.status, run.counts),
      });
    }
    this.db.prepare(`
      INSERT INTO runs
        (run_id, status, started_at, finished_at, counts_json, error_messages_json,
         estimated_resource_consumption_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        finished_at = excluded.finished_at,
        counts_json = excluded.counts_json,
        error_messages_json = excluded.error_messages_json,
        estimated_resource_consumption_json = excluded.estimated_resource_consumption_json,
        metadata_json = excluded.metadata_json
    `).run(
      run.runId,
      run.status,
      run.startedAt,
      nullable(run.finishedAt),
      jsonText(run.counts),
      jsonText(run.errorMessages),
      nullable(run.estimatedResourceConsumption && jsonText(run.estimatedResourceConsumption)),
      nullable(run.metadata && jsonText(run.metadata)),
    );
    return run;
  }

  getById(runId: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get<Row>(runId);
    return row ? RunSchema.parse(this.fromRow(row)) : undefined;
  }

  list(limit = 100): Run[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all<Row>(limit)
      .map((row) => RunSchema.parse(this.fromRow(row)));
  }

  private fromRow(row: Row): Run {
    return {
      runId: String(row.run_id),
      status: row.status as Run["status"],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? undefined : String(row.finished_at),
      counts: parseJson(row.counts_json),
      errorMessages: parseJson(row.error_messages_json),
      estimatedResourceConsumption: parseJson(row.estimated_resource_consumption_json, undefined),
      metadata: parseJson(row.metadata_json, undefined),
    };
  }
}

export class PostRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: MoltbookPost): MoltbookPost {
    const post = MoltbookPostSchema.parse(value);
    this.db.prepare(`
      INSERT INTO posts
        (post_id, ingestion_key, url, submolt, author_json, content, created_at,
         fetched_at, parent_id, engagement_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        ingestion_key = excluded.ingestion_key,
        url = excluded.url,
        submolt = excluded.submolt,
        author_json = excluded.author_json,
        content = excluded.content,
        created_at = excluded.created_at,
        fetched_at = excluded.fetched_at,
        parent_id = excluded.parent_id,
        engagement_json = excluded.engagement_json,
        metadata_json = excluded.metadata_json
    `).run(
      post.postId,
      postIngestionKey(post.postId),
      post.url,
      post.submolt,
      jsonText(post.author),
      post.content,
      post.createdAt,
      post.fetchedAt,
      nullable(post.parentId),
      nullable(post.engagement && jsonText(post.engagement)),
      nullable(post.metadata && jsonText(post.metadata)),
    );
    return post;
  }

  getById(postId: string): MoltbookPost | undefined {
    const row = this.db.prepare("SELECT * FROM posts WHERE post_id = ?").get<Row>(postId);
    return row ? MoltbookPostSchema.parse(this.fromRow(row)) : undefined;
  }

  getByIngestionKey(ingestionKey: string): MoltbookPost | undefined {
    const row = this.db.prepare("SELECT * FROM posts WHERE ingestion_key = ?").get<Row>(ingestionKey);
    return row ? MoltbookPostSchema.parse(this.fromRow(row)) : undefined;
  }

  listBySubmolt(submolt: string, limit = 100): MoltbookPost[] {
    return this.db.prepare(
      "SELECT * FROM posts WHERE submolt = ? ORDER BY created_at DESC LIMIT ?",
    ).all<Row>(submolt, limit).map((row) => MoltbookPostSchema.parse(this.fromRow(row)));
  }

  private fromRow(row: Row): MoltbookPost {
    return {
      postId: String(row.post_id),
      url: String(row.url),
      submolt: String(row.submolt),
      author: parseJson(row.author_json),
      content: String(row.content),
      createdAt: String(row.created_at),
      fetchedAt: String(row.fetched_at),
      parentId: row.parent_id === null ? undefined : String(row.parent_id),
      engagement: parseJson(row.engagement_json, undefined),
      metadata: parseJson(row.metadata_json, undefined),
    };
  }
}

export class PostContextRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: PostContext): PostContext {
    const context = PostContextSchema.parse(value);
    this.db.prepare(`
      INSERT INTO post_contexts (context_id, post_id, context_json, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        context_id = excluded.context_id,
        context_json = excluded.context_json,
        fetched_at = excluded.fetched_at
    `).run(context.contextId, context.post.postId, jsonText(context), context.fetchedAt);
    return context;
  }

  getByPostId(postId: string): PostContext | undefined {
    const row = this.db.prepare("SELECT context_json FROM post_contexts WHERE post_id = ?").get<Row>(postId);
    return row ? PostContextSchema.parse(parseJson(row.context_json)) : undefined;
  }
}

export class OpportunityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Opportunity): Opportunity {
    const opportunity = OpportunitySchema.parse(value);
    this.db.prepare(`
      INSERT INTO opportunities
        (opportunity_id, run_id, post_id, final_score, opportunity_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(opportunity_id) DO UPDATE SET
        final_score = excluded.final_score,
        opportunity_json = excluded.opportunity_json,
        created_at = excluded.created_at
    `).run(
      opportunity.opportunityId,
      opportunity.runId,
      opportunity.postId,
      opportunity.finalScore,
      jsonText(opportunity),
      opportunity.createdAt,
    );
    return opportunity;
  }

  getById(opportunityId: string): Opportunity | undefined {
    const row = this.db.prepare("SELECT opportunity_json FROM opportunities WHERE opportunity_id = ?").get<Row>(opportunityId);
    return row ? OpportunitySchema.parse(parseJson(row.opportunity_json)) : undefined;
  }

  listByRun(runId: string, limit = 100): Opportunity[] {
    return this.db.prepare(
      "SELECT opportunity_json FROM opportunities WHERE run_id = ? ORDER BY final_score DESC LIMIT ?",
    ).all<Row>(runId, limit).map((row) => OpportunitySchema.parse(parseJson(row.opportunity_json)));
  }
}

export class CommentCandidateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: CommentCandidate): CommentCandidate {
    const candidate = CommentCandidateSchema.parse(value);
    this.db.prepare(`
      INSERT INTO comment_candidates
        (candidate_id, opportunity_id, run_id, post_id, candidate_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        candidate_json = excluded.candidate_json,
        generated_at = excluded.generated_at
    `).run(
      candidate.candidateId,
      candidate.opportunityId,
      candidate.runId,
      candidate.postId,
      jsonText(candidate),
      candidate.generatedAt,
    );
    return candidate;
  }

  getById(candidateId: string): CommentCandidate | undefined {
    const row = this.db.prepare("SELECT candidate_json FROM comment_candidates WHERE candidate_id = ?").get<Row>(candidateId);
    return row ? CommentCandidateSchema.parse(parseJson(row.candidate_json)) : undefined;
  }

  listByOpportunity(opportunityId: string): CommentCandidate[] {
    return this.db.prepare(
      "SELECT candidate_json FROM comment_candidates WHERE opportunity_id = ? ORDER BY generated_at",
    ).all<Row>(opportunityId).map((row) => CommentCandidateSchema.parse(parseJson(row.candidate_json)));
  }
}

export class EvaluationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Evaluation): Evaluation {
    const evaluation = EvaluationSchema.parse(value);
    this.db.prepare(`
      INSERT INTO evaluations
        (evaluation_id, candidate_id, run_id, recommendation, evaluation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(evaluation_id) DO UPDATE SET
        recommendation = excluded.recommendation,
        evaluation_json = excluded.evaluation_json,
        created_at = excluded.created_at
    `).run(
      evaluation.evaluationId,
      evaluation.candidateId,
      evaluation.runId,
      evaluation.recommendation,
      jsonText(evaluation),
      evaluation.createdAt,
    );
    return evaluation;
  }

  getById(evaluationId: string): Evaluation | undefined {
    const row = this.db.prepare("SELECT evaluation_json FROM evaluations WHERE evaluation_id = ?").get<Row>(evaluationId);
    return row ? EvaluationSchema.parse(parseJson(row.evaluation_json)) : undefined;
  }

  listByCandidate(candidateId: string): Evaluation[] {
    return this.db.prepare(
      "SELECT evaluation_json FROM evaluations WHERE candidate_id = ? ORDER BY created_at DESC",
    ).all<Row>(candidateId).map((row) => EvaluationSchema.parse(parseJson(row.evaluation_json)));
  }
}

export class ActionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Action): Action {
    const action = ActionSchema.parse(value);
    const key = actionIdempotencyKey(action);
    const createdAt = action.metadata.createdAt;
    this.db.prepare(`
      INSERT INTO actions (action_id, action_type, idempotency_key, action_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET
        action_type = excluded.action_type,
        action_json = excluded.action_json,
        created_at = excluded.created_at
    `).run(action.actionId, action.action, key, jsonText(action), createdAt);
    return action;
  }

  saveIfAbsent(value: Action): { action: Action; inserted: boolean } {
    const action = ActionSchema.parse(value);
    const key = actionIdempotencyKey(action);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO actions (action_id, action_type, idempotency_key, action_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(action.actionId, action.action, key, jsonText(action), action.metadata.createdAt);
    const existing = this.getById(action.actionId);
    if (!existing) throw new Error(`action ${action.actionId} could not be read after insert`);
    return { action: existing, inserted: result.changes > 0 };
  }

  getById(actionId: string): Action | undefined {
    const row = this.db.prepare("SELECT action_json FROM actions WHERE action_id = ?").get<Row>(actionId);
    return row ? ActionSchema.parse(parseJson(row.action_json)) : undefined;
  }

  getByIdempotencyKey(key: string): Action | undefined {
    const row = this.db.prepare("SELECT action_json FROM actions WHERE idempotency_key = ?").get<Row>(key);
    return row ? ActionSchema.parse(parseJson(row.action_json)) : undefined;
  }
}

export type OutboxStatus = "PENDING" | "ACKNOWLEDGED" | "FAILED";

export type OutboxRecord = {
  entryId: string;
  action: Action;
  status: OutboxStatus;
  createdAt: string;
  acknowledgedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  failureDetails?: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastAttemptAt?: string;
};

export class OutboxRepository {
  constructor(private readonly db: SqliteDatabase, private readonly security: ActionSecurityOptions = { mode: "production", allowedDomains: [] }) {}

  enqueue(action: Action): { entryId: string; inserted: boolean } {
    const validated = validateActionSecurity(action, this.security);
    if (!validated.success) throw validated.error;
    const parsed = validated.data;
    const entryId = deterministicId("outbox", parsed.actionId);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (entry_id, action_id, status, payload_json, created_at)
      VALUES (?, ?, 'PENDING', ?, ?)
    `).run(entryId, parsed.actionId, jsonText(parsed), parsed.metadata.createdAt);
    return { entryId, inserted: result.changes > 0 };
  }

  pending(limit = 100): Array<{ entryId: string; action: Action; createdAt: string }> {
    return this.db.prepare(
      "SELECT entry_id, payload_json, created_at FROM outbox WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at LIMIT ?",
    ).all<Row>(new Date().toISOString(), limit).map((row) => ({
      entryId: String(row.entry_id),
      action: ActionSchema.parse(parseJson(row.payload_json)),
      createdAt: String(row.created_at),
    }));
  }

  acknowledge(entryId: string, acknowledgedAt: string): boolean {
    return this.db.prepare(
      "UPDATE outbox SET status = 'ACKNOWLEDGED', acknowledged_at = ?, error_message = NULL, next_retry_at = NULL WHERE entry_id = ? AND status = 'PENDING'",
    ).run(acknowledgedAt, entryId).changes > 0;
  }

  fail(entryId: string, errorMessage: string, details: Record<string, unknown> = {}, attemptedAt = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE outbox SET status = 'FAILED', error_message = ?, attempt_count = MIN(attempt_count + 1, max_attempts),
       last_attempt_at = ?, failed_at = ?, failure_details_json = ?, next_retry_at = NULL
       WHERE entry_id = ? AND status = 'PENDING'`,
    ).run(errorMessage, attemptedAt, attemptedAt, jsonText(details), entryId).changes > 0;
  }

  retry(entryId: string, attemptedAt = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE outbox SET status = 'PENDING', next_retry_at = NULL, last_attempt_at = ?
       WHERE entry_id = ? AND status = 'FAILED' AND attempt_count < max_attempts`,
    ).run(attemptedAt, entryId).changes > 0;
  }

  get(entryId: string): OutboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE entry_id = ?").get<Row>(entryId);
    if (!row) return undefined;
    return {
      entryId: String(row.entry_id),
      action: ActionSchema.parse(parseJson(row.payload_json)),
      status: String(row.status) as OutboxStatus,
      createdAt: String(row.created_at),
      ...(row.acknowledged_at ? { acknowledgedAt: String(row.acknowledged_at) } : {}),
      ...(row.failed_at ? { failedAt: String(row.failed_at) } : {}),
      ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
      failureDetails: parseJson(row.failure_details_json, undefined),
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      ...(row.next_retry_at ? { nextRetryAt: String(row.next_retry_at) } : {}),
      ...(row.last_attempt_at ? { lastAttemptAt: String(row.last_attempt_at) } : {}),
    };
  }
}

export class ExperimentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Experiment): Experiment {
    const experiment = ExperimentSchema.parse(value);
    this.db.prepare(`
      INSERT INTO experiments
        (experiment_id, run_id, source_post_id, comment_hash, strategy_family, experiment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET
        experiment_json = excluded.experiment_json
    `).run(
      experiment.experimentId,
      experiment.runId,
      experiment.sourcePostId,
      experiment.commentHash,
      experiment.strategyFamily,
      jsonText(experiment),
      experiment.createdAt,
    );
    return experiment;
  }

  getById(experimentId: string): Experiment | undefined {
    const row = this.db.prepare("SELECT experiment_json FROM experiments WHERE experiment_id = ?").get<Row>(experimentId);
    return row ? ExperimentSchema.parse(parseJson(row.experiment_json)) : undefined;
  }

  listByStrategy(strategyFamily: string, limit = 100): Experiment[] {
    return this.db.prepare(
      "SELECT experiment_json FROM experiments WHERE strategy_family = ? ORDER BY created_at DESC LIMIT ?",
    ).all<Row>(strategyFamily, limit).map((row) => ExperimentSchema.parse(parseJson(row.experiment_json)));
  }
}

export class PublicationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Publication): Publication {
    const publication = PublicationSchema.parse(value);
    this.db.prepare(`
      INSERT INTO publications (publication_id, action_id, experiment_id, status, publication_json, created_at, acknowledged_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id) DO UPDATE SET action_id = excluded.action_id,
        experiment_id = excluded.experiment_id, status = excluded.status,
        publication_json = excluded.publication_json, acknowledged_at = excluded.acknowledged_at,
        error_message = excluded.error_message
    `).run(
      publication.publicationId,
      publication.actionId,
      nullable(publication.experimentId),
      publication.status,
      jsonText(publication),
      publication.attemptedAt ?? new Date().toISOString(),
      nullable(publication.acknowledgedAt),
      nullable(publication.errorMessage),
    );
    return publication;
  }

  getById(publicationId: string): Publication | undefined {
    const row = this.db.prepare("SELECT publication_json FROM publications WHERE publication_id = ?").get<Row>(publicationId);
    return row ? PublicationSchema.parse(parseJson(row.publication_json)) : undefined;
  }

  getByActionId(actionId: string): Publication | undefined {
    const row = this.db.prepare("SELECT publication_json FROM publications WHERE action_id = ?").get<Row>(actionId);
    return row ? PublicationSchema.parse(parseJson(row.publication_json)) : undefined;
  }
}

export class OutcomeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: Outcome): Outcome {
    const outcome = OutcomeSchema.parse(value);
    this.db.prepare(`
      INSERT INTO outcomes (outcome_id, experiment_id, run_id, outcome_json, observed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET outcome_id = excluded.outcome_id,
        run_id = excluded.run_id, outcome_json = excluded.outcome_json, observed_at = excluded.observed_at
    `).run(outcome.outcomeId, outcome.experimentId, outcome.runId, jsonText(outcome), outcome.observedAt);
    return outcome;
  }

  getByExperimentId(experimentId: string): Outcome | undefined {
    const row = this.db.prepare("SELECT outcome_json FROM outcomes WHERE experiment_id = ?").get<Row>(experimentId);
    return row ? OutcomeSchema.parse(parseJson(row.outcome_json)) : undefined;
  }
}

export class StrategyStatisticsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: StrategyStatistics): StrategyStatistics {
    const statistics = StrategyStatisticsSchema.parse(value);
    const dimensionsKey = jsonText(statistics.dimensions ?? {});
    this.db.prepare(`
      INSERT INTO strategy_statistics (statistics_id, strategy_family, dimensions_key, statistics_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(strategy_family, dimensions_key) DO UPDATE SET statistics_id = excluded.statistics_id,
        statistics_json = excluded.statistics_json, updated_at = excluded.updated_at
    `).run(statistics.statisticsId, statistics.strategyFamily, dimensionsKey, jsonText(statistics), statistics.updatedAt);
    return statistics;
  }

  getById(statisticsId: string): StrategyStatistics | undefined {
    const row = this.db.prepare("SELECT statistics_json FROM strategy_statistics WHERE statistics_id = ?").get<Row>(statisticsId);
    return row ? StrategyStatisticsSchema.parse(parseJson(row.statistics_json)) : undefined;
  }

  listByStrategy(strategyFamily: StrategyStatistics["strategyFamily"], limit = 100): StrategyStatistics[] {
    return this.db.prepare("SELECT statistics_json FROM strategy_statistics WHERE strategy_family = ? ORDER BY updated_at DESC LIMIT ?")
      .all<Row>(strategyFamily, limit)
      .map((row) => StrategyStatisticsSchema.parse(parseJson(row.statistics_json)));
  }
}

export class WorkerReportRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: WorkerReport): WorkerReport {
    const report = WorkerReportSchema.parse(value);
    this.db.prepare(`
      INSERT INTO worker_reports
        (report_id, run_id, task_id, worker, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_id) DO UPDATE SET report_json = excluded.report_json
    `).run(report.reportId, report.runId, report.taskId, report.worker, jsonText(report), report.createdAt);
    return report;
  }

  getById(reportId: string): WorkerReport | undefined {
    const row = this.db.prepare("SELECT report_json FROM worker_reports WHERE report_id = ?").get<Row>(reportId);
    return row ? WorkerReportSchema.parse(parseJson(row.report_json)) : undefined;
  }

  listByRun(runId: string): WorkerReport[] {
    return this.db.prepare(
      "SELECT report_json FROM worker_reports WHERE run_id = ? ORDER BY created_at",
    ).all<Row>(runId).map((row) => WorkerReportSchema.parse(parseJson(row.report_json)));
  }
}

export class ModelRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(value: ModelRunRecord): ModelRunRecord {
    const modelRun = ModelRunRecordSchema.parse(value);
    this.db.prepare(`
      INSERT INTO model_runs
        (model_run_id, run_id, task_id, status, model_run_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_run_id) DO UPDATE SET
        status = excluded.status,
        model_run_json = excluded.model_run_json
    `).run(
      modelRun.modelRunId,
      modelRun.runId,
      modelRun.taskId,
      modelRun.status,
      jsonText(modelRun),
      modelRun.startedAt,
    );
    return modelRun;
  }

  listByRun(runId: string, limit = 100): ModelRunRecord[] {
    return this.db.prepare(
      "SELECT model_run_json FROM model_runs WHERE run_id = ? ORDER BY started_at LIMIT ?",
    ).all<Row>(runId, limit).map((row) => ModelRunRecordSchema.parse(parseJson(row.model_run_json)));
  }
}

export class IdempotencyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  claim(key: string, resourceType: string, resourceId: string, createdAt: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_keys
        (idempotency_key, resource_type, resource_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(key, resourceType, resourceId, createdAt);
    return result.changes > 0;
  }

  keyFor(resourceType: string, payload: unknown): string {
    return idempotencyKeyFor(resourceType, payload);
  }
}

export interface PersistenceRepositories {
  agents: AgentRepository;
  runs: RunRepository;
  posts: PostRepository;
  contexts: PostContextRepository;
  opportunities: OpportunityRepository;
  candidates: CommentCandidateRepository;
  evaluations: EvaluationRepository;
  actions: ActionRepository;
  outbox: OutboxRepository;
  experiments: ExperimentRepository;
  publications: PublicationRepository;
  outcomes: OutcomeRepository;
  strategyStatistics: StrategyStatisticsRepository;
  workerReports: WorkerReportRepository;
  modelRuns: ModelRunRepository;
  idempotency: IdempotencyRepository;
}

export function createRepositories(db: SqliteDatabase): PersistenceRepositories {
  return {
    agents: new AgentRepository(db),
    runs: new RunRepository(db),
    posts: new PostRepository(db),
    contexts: new PostContextRepository(db),
    opportunities: new OpportunityRepository(db),
    candidates: new CommentCandidateRepository(db),
    evaluations: new EvaluationRepository(db),
    actions: new ActionRepository(db),
    outbox: new OutboxRepository(db),
    experiments: new ExperimentRepository(db),
    publications: new PublicationRepository(db),
    outcomes: new OutcomeRepository(db),
    strategyStatistics: new StrategyStatisticsRepository(db),
    workerReports: new WorkerReportRepository(db),
    modelRuns: new ModelRunRepository(db),
    idempotency: new IdempotencyRepository(db),
  };
}
