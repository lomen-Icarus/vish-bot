/**
 * Thin adapter over Node's built-in `node:sqlite` (no native build step, which
 * matters on hosting panels that forbid compiling addons). The surface mirrors
 * the small subset of the better-sqlite3 API the repository layer uses.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { logger } from "../logger.js";

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** node:sqlite declares overloads (named object first, or positional only); we accept both loosely. */
type LooseRun = (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
type LooseGet = (...params: unknown[]) => unknown;
type LooseAll = (...params: unknown[]) => unknown[];

export class Db {
  constructor(private readonly raw: DatabaseSync) {}

  prepare(sql: string): Statement {
    const st = this.raw.prepare(sql);
    const run = st.run.bind(st) as unknown as LooseRun;
    const get = st.get.bind(st) as unknown as LooseGet;
    const all = st.all.bind(st) as unknown as LooseAll;
    return {
      run: (...params) => {
        const r = run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get: (...params) => get(...params),
      all: (...params) => all(...params),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** `pragma("user_version", { simple: true })` -> value; `pragma("journal_mode = WAL")` -> sets. */
  pragma(text: string, opts: { simple?: boolean } = {}): unknown {
    if (text.includes("=")) {
      this.raw.exec(`PRAGMA ${text}`);
      return undefined;
    }
    const row = this.raw.prepare(`PRAGMA ${text}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return opts.simple ? Object.values(row)[0] : [row];
  }

  /** Wrap `fn` in BEGIN/COMMIT; returns a callable like better-sqlite3's `transaction()`. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.raw.exec("BEGIN");
      try {
        const result = fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Db(new DatabaseSync(file));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const version = Number(db.pragma("user_version", { simple: true }) ?? 0);
  for (let i = version; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${i + 1}`);
    })();
    logger.info({ version: i + 1 }, "database migrated");
  }
}

export const nowIso = (): string => new Date().toISOString();
