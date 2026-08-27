import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FixtureMoltbookSource } from "../../src/discovery";
import { SolOrchestrator } from "../../src/orchestrator";
import { createRepositories } from "../../src/persistence/repositories";
import { applyMigrations } from "../../src/persistence/migrations";
import { type SqliteDatabase } from "../../src/persistence/database";
import { SqliteRuntimePersistence } from "../../src/persistence/runtime";
import { ActionSchema, ExperimentSchema, RunSchema } from "../../src/schemas";

describe("persistence round trip", () => {
  it("persists the fixture pipeline and reloads schema-valid records", async () => {
    const fixture = {
      posts: [
        {
          postId: "roundtrip-post",
          url: "https://moltbook.local/post/roundtrip-post",
          submolt: "research",
          author: { id: "agent-roundtrip", name: "agent-roundtrip", type: "agent" },
          content: "How can agents validate a signal with independent evidence?",
          createdAt: "2026-08-24T00:00:00.000Z",
          fetchedAt: "2026-08-24T00:01:00.000Z",
        },
      ],
    };
    const db = new Database(":memory:");
    applyMigrations(db as unknown as SqliteDatabase);
    const persistence = new SqliteRuntimePersistence(db as unknown as SqliteDatabase);
    const result = await new SolOrchestrator(new FixtureMoltbookSource(fixture), persistence).run({
      runId: "roundtrip-run",
      dryRun: true,
      targetActions: 1,
      now: "2026-08-24T00:02:00.000Z",
    });
    const repositories = createRepositories(db as unknown as SqliteDatabase);

    expect(repositories.agents.getById("agent-roundtrip")).toMatchObject({ agentId: "agent-roundtrip", platform: "moltbook" });
    expect(repositories.posts.getById("roundtrip-post")?.postId).toBe("roundtrip-post");
    expect(repositories.contexts.getByPostId("roundtrip-post")?.post.postId).toBe("roundtrip-post");
    expect(repositories.opportunities.listByRun(result.summary.runId)).not.toHaveLength(0);
    const candidate = db.prepare("SELECT candidate_id FROM comment_candidates LIMIT 1").get<{ candidate_id: string }>();
    const evaluation = db.prepare("SELECT evaluation_id FROM evaluations LIMIT 1").get<{ evaluation_id: string }>();
    expect(candidate).toBeDefined();
    expect(evaluation).toBeDefined();
    expect(repositories.candidates.getById(candidate!.candidate_id)?.candidateId).toBe(candidate!.candidate_id);
    expect(repositories.evaluations.getById(evaluation!.evaluation_id)?.evaluationId).toBe(evaluation!.evaluation_id);
    expect(repositories.runs.getById(result.summary.runId)?.runId).toBe(result.summary.runId);
    for (const row of db.prepare("SELECT action_json FROM actions").all<{ action_json: string }>()) ActionSchema.parse(JSON.parse(row.action_json));
    for (const row of db.prepare("SELECT experiment_json FROM experiments").all<{ experiment_json: string }>()) {
      const experiment = ExperimentSchema.parse(JSON.parse(row.experiment_json));
      expect(experiment.commentHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(experiment.createdAt).toBeTruthy();
    }
    RunSchema.parse(JSON.parse(db.prepare("SELECT json_object('runId', run_id, 'status', status, 'startedAt', started_at, 'finishedAt', finished_at, 'counts', json(counts_json), 'errorMessages', json(error_messages_json), 'metadata', json(metadata_json)) AS value FROM runs WHERE run_id = ?").get<{ value: string }>(result.summary.runId)!.value));
    db.close();
  });
});
