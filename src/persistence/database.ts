import { stableStringify } from "../domain/identifiers";

/** Minimal better-sqlite3-compatible surface; keeps SQLite optional at compile time. */
export interface SqliteStatement {
  run(...parameters: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...parameters: unknown[]): T[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction?<T>(fn: () => T): () => T;
}

export function jsonText(value: unknown): string {
  return stableStringify(value);
}

export function parseJson<T>(value: unknown, fallback?: T): T {
  if (value === null || value === undefined) {
    if (arguments.length >= 2) return fallback as T;
    throw new Error("expected JSON text");
  }
  if (typeof value !== "string") return value as T;
  return JSON.parse(value) as T;
}

export function nullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function withTransaction<T>(db: SqliteDatabase, work: () => T): T {
  if (db.transaction) return db.transaction(work)();
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
