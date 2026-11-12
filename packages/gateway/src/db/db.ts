/**
 * SQLite access (better-sqlite3, synchronous). One connection per process, WAL mode, foreign keys on.
 * Use `tx()` for every multi-row write; SQL is always parameterized.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** Bump whenever schema.sql changes, and add the step that upgrades older databases to MIGRATIONS. */
export const SCHEMA_VERSION = 3;

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export interface Migration {
  /** The version this step upgrades to. */
  version: number;
  description: string;
  /**
   * Changes to existing tables (ALTER TABLE ...). New tables and indexes need no step code: schema.sql is
   * idempotent and is applied right after the steps, in the same transaction.
   */
  up?: (db: Db) => void;
}

/** In-place, additive upgrades, oldest first. A database at version n runs every step above n. */
export const MIGRATIONS: Migration[] = [
  { version: 2, description: "PayPal disputes, dispute refunds and invoices (new tables only)" },
  { version: 3, description: "Purchase refunds (new table only)" },
];

/** Open (or create) the database and apply the schema, upgrading an older one in place. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${path} uses schema v${version}, which is newer than this build (v${SCHEMA_VERSION}). ` +
        `Update 402 Fiatality, or delete ${path}* (it only holds demo data) and restart.`,
    );
  }
  db.transaction(() => {
    if (version !== 0) for (const step of MIGRATIONS) if (step.version > version) step.up?.(db);
    db.exec(SCHEMA_SQL);
    if (version !== SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
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
