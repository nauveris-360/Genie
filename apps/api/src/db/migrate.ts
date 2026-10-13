import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Key text for the session-level advisory lock that serializes every migration run. */
export const MIGRATION_LOCK_KEY = 'genie.schema_migrations';

interface MigrationFile {
  id: string;
  upPath: string;
  downPath: string;
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const upFiles = entries.filter((f) => f.endsWith('.up.sql')).sort();
  return upFiles.map((upFile) => {
    const id = upFile.replace(/\.up\.sql$/, '');
    const downFile = `${id}.down.sql`;
    if (!entries.includes(downFile)) {
      throw new Error(`Migration ${id} has no matching down file (${downFile}); every migration must be reversible.`);
    }
    return { id, upPath: path.join(MIGRATIONS_DIR, upFile), downPath: path.join(MIGRATIONS_DIR, downFile) };
  });
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Runs fn on ONE dedicated connection while holding a session-level advisory
 * lock, so concurrent migration runs (two instances booting at once, a deploy
 * job overlapping a restart, an up racing a down) execute strictly one after
 * another. Each later run re-reads schema_migrations under the lock and finds
 * nothing left to do. The lock lives on the connection: if the process dies,
 * PostgreSQL releases it when the connection closes, so it can never be left
 * stuck. If unlocking fails, the connection is destroyed instead of being
 * returned to the pool still holding the lock.
 */
async function withMigrationLock<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_KEY]);
      } catch {
        destroy = true;
      }
    }
  } finally {
    client.release(destroy);
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function runInTransaction(client: PoolClient, label: string, fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${label} failed: ${(err as Error).message}`);
  }
}

export async function migrateUp(pool: Pool): Promise<{ applied: string[] }> {
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationsTable(client);
    const files = await loadMigrationFiles();
    const { rows } = await client.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
    const appliedById = new Map(rows.map((r) => [r.id, r.checksum]));

    const applied: string[] = [];
    for (const file of files) {
      const upSql = await readFile(file.upPath, 'utf8');
      const sum = checksum(upSql);
      const existing = appliedById.get(file.id);
      if (existing) {
        if (existing !== sum) {
          throw new Error(`Migration ${file.id} was already applied with a different checksum. Never edit an applied migration; add a new one instead.`);
        }
        continue;
      }
      await runInTransaction(client, `Migration ${file.id}`, async () => {
        await client.query(upSql);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [file.id, sum]);
      });
      applied.push(file.id);
    }
    return { applied };
  });
}

/** Rolls back the single most recently applied migration, under the same lock as migrateUp. */
export async function migrateDown(pool: Pool): Promise<{ rolledBack: string | null }> {
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1');
    const last = rows[0];
    if (!last) return { rolledBack: null };

    const file = (await loadMigrationFiles()).find((f) => f.id === last.id);
    if (!file) throw new Error(`Cannot find migration file for applied migration ${last.id}; it was likely deleted from disk.`);
    const downSql = await readFile(file.downPath, 'utf8');
    await runInTransaction(client, `Rollback of ${file.id}`, async () => {
      await client.query(downSql);
      await client.query('DELETE FROM schema_migrations WHERE id = $1', [file.id]);
    });
    return { rolledBack: file.id };
  });
}

export async function appliedMigrations(pool: Pool): Promise<string[]> {
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    return rows.map((r) => r.id);
  });
}

export interface MigrationStatus {
  pending: string[];
  /** Applied migrations whose file content changed since (never acceptable). */
  modified: string[];
  /** Applied migrations with no file in this build (database is ahead of the code). */
  unknown: string[];
}

/**
 * Read-only comparison of the database with this build's migration files. It
 * needs only SELECT on schema_migrations (never CREATE), so a least-privilege
 * runtime role can use it to refuse to start against a schema that has not
 * been migrated by the separate migration step.
 */
export async function migrationStatus(pool: Pool): Promise<MigrationStatus> {
  const files = await loadMigrationFiles();
  const exists = (await pool.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations')::text AS t`)).rows[0]?.t;
  const applied = new Map<string, string>();
  if (exists) {
    const { rows } = await pool.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
    for (const r of rows) applied.set(r.id, r.checksum);
  }
  const pending: string[] = [];
  const modified: string[] = [];
  for (const file of files) {
    const sum = applied.get(file.id);
    if (sum === undefined) pending.push(file.id);
    else if (sum !== checksum(await readFile(file.upPath, 'utf8'))) modified.push(file.id);
  }
  const known = new Set(files.map((f) => f.id));
  const unknown = [...applied.keys()].filter((id) => !known.has(id)).sort();
  return { pending, modified, unknown };
}
