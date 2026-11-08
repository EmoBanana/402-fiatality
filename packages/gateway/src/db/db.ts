/**
 * SQLite access (better-sqlite3, synchronous). One connection per process, WAL mode, foreign keys on.
 * Use `tx()` for every multi-row write; SQL is always parameterized.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** Bump whenever schema.sql changes. Older demo databases must be deleted (data/ only holds demo data). */
export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Open (or create) the database and apply the schema. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const version = db.pragma("user_version", { simple: true }) as number;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${path} uses schema v${version} but this build needs v${SCHEMA_VERSION}. ` +
        `It only holds demo data: delete ${path}* and restart.`,
    );
  }
  db.exec(SCHEMA_SQL);
  if (version === 0) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Run `fn` in a transaction (nested calls become savepoints). `fn` must be synchronous. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

/** Prepared statement for `source`, compiled once per connection. Use for anything on a hot path. */
export function stmt(db: Db, source: string): Database.Statement {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let statement = cache.get(source);
  if (!statement) cache.set(source, (statement = db.prepare(source)));
  return statement;
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function kvDelete(db: Db, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

/** Parse a JSON column, falling back when it is NULL or corrupt. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
