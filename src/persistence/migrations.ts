import { SqliteDatabase, withTransaction } from "./database";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_domain_store",
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        counts_json TEXT NOT NULL,
        error_messages_json TEXT NOT NULL,
        estimated_resource_consumption_json TEXT,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS posts (
        post_id TEXT PRIMARY KEY,
        ingestion_key TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        submolt TEXT NOT NULL,
        author_json TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        parent_id TEXT,
        engagement_json TEXT,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        name TEXT,
        agent_type TEXT,
        agent_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS post_contexts (
        context_id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL UNIQUE,
        context_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opportunities (
        opportunity_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        final_score REAL NOT NULL,
        opportunity_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS comment_candidates (
        candidate_id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        evaluation_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        action_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        entry_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_retry_at TEXT,
        last_attempt_at TEXT,
        failed_at TEXT,
        failure_details_json TEXT
      );
      CREATE TABLE IF NOT EXISTS experiments (
        experiment_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        comment_hash TEXT NOT NULL,
        strategy_family TEXT NOT NULL,
        experiment_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_reports (
        report_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_runs (
        model_run_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        model_run_json TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS publications (
        publication_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL UNIQUE,
        experiment_id TEXT,
        status TEXT NOT NULL,
        publication_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        outcome_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_statistics (
        statistics_id TEXT PRIMARY KEY,
        strategy_family TEXT NOT NULL,
        dimensions_key TEXT NOT NULL,
        statistics_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(strategy_family, dimensions_key)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunities_run_score ON opportunities(run_id, final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_candidates_opportunity ON comment_candidates(opportunity_id);
      CREATE INDEX IF NOT EXISTS idx_evaluations_candidate ON evaluations(candidate_id);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_experiments_strategy ON experiments(strategy_family);
      CREATE INDEX IF NOT EXISTS idx_publications_status ON publications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_outcomes_experiment ON outcomes(experiment_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_strategy_statistics_family ON strategy_statistics(strategy_family, updated_at);
      CREATE VIEW IF NOT EXISTS strategy_stats AS SELECT * FROM strategy_statistics;
      CREATE INDEX IF NOT EXISTS idx_runtime_attribution_experiment ON runtime_attribution(run_id, experiment_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_attribution_source ON runtime_attribution(run_id, source_post_id);
    `,
  },
  {
    version: 2,
    name: "verified_outcome_event_evidence",
    sql: `
      CREATE TABLE IF NOT EXISTS outcome_events (
        event_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        experiment_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outcome_events_experiment ON outcome_events(experiment_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_outcome_events_action ON outcome_events(action_id, observed_at);
    `,
  },
  {
    version: 3,
    name: "outcome_evidence_identity",
    sql: `
      ALTER TABLE outcome_events ADD COLUMN evidence_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_events_evidence_key
      ON outcome_events(evidence_key) WHERE evidence_key IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: "tracker_distribution_attribution",
    sql: `
      CREATE TABLE IF NOT EXISTS tracking_distributions (
        ref TEXT PRIMARY KEY,
        tracking_url TEXT NOT NULL,
        environment TEXT NOT NULL,
        status TEXT NOT NULL,
        destination_url TEXT NOT NULL,
        platform TEXT NOT NULL,
        content_type TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        run_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        pre_link_identity TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        action_id TEXT,
        experiment_id TEXT,
        comment_hash TEXT,
        total_redirects INTEGER,
        clicked INTEGER,
        first_clicked_at TEXT,
        last_clicked_at TEXT,
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        error_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_distributions_action
        ON tracking_distributions(action_id) WHERE action_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracking_distributions_run_source
        ON tracking_distributions(run_id, source_post_id);
    `,
  },
  {
    version: 5,
    name: "marx_feed_poll_queue",
    sql: `
      CREATE TABLE marx_feed_stream (
        stream_id TEXT PRIMARY KEY,
        initialized_at TEXT NOT NULL,
        last_checked_at TEXT NOT NULL
      );
      CREATE TABLE marx_feed_queue (
        feed_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        published_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('baseline','pending','running','completed','review_required','skipped')),
        claim_id TEXT,
        run_id TEXT,
        runner_pid INTEGER,
        runner_host TEXT,
        result_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_marx_feed_queue_status ON marx_feed_queue(status, published_at);
      CREATE TABLE marx_feed_resolutions (
        resolution_id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        resolution TEXT NOT NULL,
        reason TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );
    `,
  },
];

export function applyMigrations(db: SqliteDatabase, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT,
      agent_type TEXT,
      agent_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all<{ version: number }>().map((row) => row.version),
  );
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    });
  }
  // Bootstrap databases created by the first implementation may already be
  // marked at version 1. Keep this repair idempotent so they gain the durable
  // outbox and learning tables without requiring a destructive reset.
  ensureCurrentSchema(db);
}

function ensureCurrentSchema(db: SqliteDatabase): void {
  const columns = new Set(
    db.prepare("PRAGMA table_info(outbox)").all<{ name: string }>().map((row) => row.name),
  );
  const additions: Array<[string, string]> = [
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
    ["next_retry_at", "TEXT"],
    ["last_attempt_at", "TEXT"],
    ["failed_at", "TEXT"],
    ["failure_details_json", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      publication_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL UNIQUE,
      experiment_id TEXT,
      status TEXT NOT NULL,
      publication_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      outcome_id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcome_events (
      event_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      evidence_status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_key TEXT
    );
    CREATE TABLE IF NOT EXISTS strategy_statistics (
      statistics_id TEXT PRIMARY KEY,
      strategy_family TEXT NOT NULL,
      dimensions_key TEXT NOT NULL,
      statistics_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(strategy_family, dimensions_key)
    );
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
    CREATE INDEX IF NOT EXISTS idx_publications_status ON publications(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outcomes_experiment ON outcomes(experiment_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_outcome_events_experiment ON outcome_events(experiment_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_outcome_events_action ON outcome_events(action_id, observed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_events_evidence_key ON outcome_events(evidence_key) WHERE evidence_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS tracking_distributions (
      ref TEXT PRIMARY KEY,
      tracking_url TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      content_type TEXT NOT NULL,
      feed_id TEXT NOT NULL,
      source_post_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      run_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      pre_link_identity TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      action_id TEXT,
      experiment_id TEXT,
      comment_hash TEXT,
      total_redirects INTEGER,
      clicked INTEGER,
      first_clicked_at TEXT,
      last_clicked_at TEXT,
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      error_message TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_distributions_action
      ON tracking_distributions(action_id) WHERE action_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tracking_distributions_run_source
      ON tracking_distributions(run_id, source_post_id);
    CREATE INDEX IF NOT EXISTS idx_strategy_statistics_family ON strategy_statistics(strategy_family, updated_at);
    CREATE VIEW IF NOT EXISTS strategy_stats AS SELECT * FROM strategy_statistics;
    CREATE INDEX IF NOT EXISTS idx_runtime_attribution_experiment ON runtime_attribution(run_id, experiment_id);
    CREATE INDEX IF NOT EXISTS idx_runtime_attribution_source ON runtime_attribution(run_id, source_post_id);
  `);
}
