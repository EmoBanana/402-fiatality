/** Schema versions: a fresh database is created at the current version; a v1 database is upgraded in place. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDb, SCHEMA_VERSION } from "./db";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "p402-db-"));
  dirs.push(dir);
  return join(dir, "p402.sqlite");
}

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);

describe("openDb", () => {
  it("creates a new database at the current schema version", () => {
    const db = openDb(":memory:");
    expect(SCHEMA_VERSION).toBe(2);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual(expect.arrayContaining(["disputes", "dispute_refunds", "invoices", "settlements", "kv"]));
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("upgrades a v1 database in place and keeps its data", () => {
    const path = tempDb();
    // A v1 database: today's schema without the v2 tables, user_version 1, some demo data.
    const v1 = openDb(path);
    v1.exec("DROP TABLE disputes; DROP TABLE dispute_refunds; DROP TABLE invoices;");
    v1.prepare("INSERT INTO companies (id, name, created_at) VALUES ('co_1', 'Northwind Research', 1)").run();
    v1.prepare("INSERT INTO kv (key, value) VALUES ('clock.offset_ms', '86400000')").run();
    v1.pragma("user_version = 1");
    v1.close();

    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(tables(db)).toEqual(expect.arrayContaining(["disputes", "dispute_refunds", "invoices"]));
    expect(db.prepare("SELECT name FROM companies").all()).toEqual([{ name: "Northwind Research" }]);
    expect(db.prepare("SELECT value FROM kv WHERE key = 'clock.offset_ms'").get()).toEqual({ value: "86400000" });
    db.prepare(
      "INSERT INTO disputes (id, status, reason, amount_cents, created_at, updated_at) VALUES ('PP-D-1', 'OPEN', 'OTHER', 100, 1, 1)",
    ).run();
    db.close();
    // Reopening is a no-op.
    const again = openDb(path);
    expect(again.prepare("SELECT id FROM disputes").all()).toEqual([{ id: "PP-D-1" }]);
    again.close();
  });

  it("refuses a database from a newer build", () => {
    const path = tempDb();
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(path)).toThrow(/newer than this build/);
  });
});
