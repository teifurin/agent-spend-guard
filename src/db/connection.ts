import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Migrations run in this order, once each; the file name is the key in schema_migrations. */
const MIGRATIONS = ['001_init.sql'] as const;

/**
 * Opens (or creates) the SQLite database and brings its schema up to date.
 * Uses Node's built-in node:sqlite (Node >= 22.13), so there is no native dependency to build.
 */
export function openDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  migrate(db);
  return db;
}

/** Applies pending migrations inside transactions. Returns the names it applied (empty when up to date). */
export function migrate(db: DatabaseSync): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => String(row['name'])));
  const newlyApplied: string[] = [];
  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    newlyApplied.push(name);
  }
  return newlyApplied;
}

export type { DatabaseSync };
