import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

interface MigrationFile {
  id: string;
  name: string;
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
    return {
      id,
      name: id,
      upPath: path.join(MIGRATIONS_DIR, upFile),
      downPath: path.join(MIGRATIONS_DIR, downFile),
    };
  });
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function migrateUp(pool: Pool): Promise<{ applied: string[] }> {
  await ensureMigrationsTable(pool);
  const files = await loadMigrationFiles();
  const { rows: appliedRows } = await pool.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  );
  const appliedById = new Map(appliedRows.map((r) => [r.id, r.checksum]));

  const applied: string[] = [];
  for (const file of files) {
    const upSql = await readFile(file.upPath, 'utf8');
    const sum = checksum(upSql);
    const existingChecksum = appliedById.get(file.id);
    if (existingChecksum) {
      if (existingChecksum !== sum) {
        throw new Error(
          `Migration ${file.id} was already applied with a different checksum. Never edit an applied migration; add a new one instead.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(upSql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [file.id, sum]);
      await client.query('COMMIT');
      applied.push(file.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file.id} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied };
}

/** Rolls back the single most recently applied migration. */
export async function migrateDown(pool: Pool): Promise<{ rolledBack: string | null }> {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1',
  );
  const last = rows[0];
  if (!last) {
    return { rolledBack: null };
  }

  const files = await loadMigrationFiles();
  const file = files.find((f) => f.id === last.id);
  if (!file) {
    throw new Error(`Cannot find migration file for applied migration ${last.id}; it was likely deleted from disk.`);
  }

  const downSql = await readFile(file.downPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(downSql);
    await client.query('DELETE FROM schema_migrations WHERE id = $1', [file.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Rollback of ${file.id} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
  return { rolledBack: file.id };
}

export async function appliedMigrations(pool: Pool): Promise<string[]> {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return rows.map((r) => r.id);
}
