import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/persistence/migrations";
import { jsonText, nullable, type SqliteDatabase, type SqliteStatement } from "../../src/persistence/database";

class MigrationOnlyDb implements SqliteDatabase {
  readonly executedSql: string[] = [];
  readonly versions: number[] = [];

  exec(sql: string): void {
    this.executedSql.push(sql);
  }

  prepare(sql: string): SqliteStatement {
    return {
      all: <T>() => sql.includes("schema_migrations")
        ? this.versions.map((version) => ({ version })) as T[]
        : [],
      get: () => undefined,
      run: (...parameters: unknown[]) => {
        if (sql.includes("schema_migrations")) this.versions.push(Number(parameters[0]));
        return { changes: 1 };
      },
    };
  }
}

describe("SQLite persistence foundation", () => {
  it("applies each migration version once", () => {
    const db = new MigrationOnlyDb();
    applyMigrations(db);
    applyMigrations(db);

    expect(db.versions).toEqual([1, 2, 3, 4]);
    expect(db.executedSql.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS runs"))).toHaveLength(1);
  });

  it("uses canonical JSON and represents optional SQL values as null", () => {
    expect(jsonText({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
    expect(nullable(undefined)).toBeNull();
    expect(nullable("value")).toBe("value");
  });
});
