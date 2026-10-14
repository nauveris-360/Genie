/**
 * Migration CLI. Needs only a database URL, not the application's secrets, so
 * a separate migration job can run with the migration (schema-owner) role:
 *
 *   MIGRATION_DATABASE_URL=postgres://genie_owner:...@host/genie node apps/api/dist/db/cli.js up
 *   ... cli.js down     # rolls back exactly one migration
 *   ... cli.js status   # read-only: pending / modified / unknown
 *
 * Falls back to DATABASE_URL when MIGRATION_DATABASE_URL is unset (local dev).
 * Every run holds the migration advisory lock (see migrate.ts).
 */
import pg from 'pg';
import { migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { currentRole, unsafeRoleReasons } from './safety.js';
import { withoutMaskedValues } from '../config.js';

async function main() {
  const command = process.argv[2];
  // A masked value (__GENIE_NOT_AVAILABLE__) counts as unset.
  const env = withoutMaskedValues(process.env);
  const url = env.MIGRATION_DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) to the migration role connection string.');
  if (!['up', 'down', 'status'].includes(command ?? '')) {
    console.error('Usage: cli.js <up|down|status>');
    process.exitCode = 1;
    return;
  }
  const ssl = env.DATABASE_SSL === 'true' || env.DATABASE_SSL === '1';
  const pool = new pg.Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: true } : undefined, max: 2 });
  try {
    const role = await currentRole(pool);
    const reasons = unsafeRoleReasons(role);
    if (reasons.length && command !== 'status') {
      const msg = `Migration role "${role.name}" is unsafe: ${reasons.join('; ')}. Tables must be owned by a non-superuser, non-BYPASSRLS migration role (see docs/DEPLOYMENT.md).`;
      if (env.NODE_ENV === 'production') throw new Error(`Refusing to migrate. ${msg}`);
      console.warn(`WARNING: ${msg}`);
    }
    if (command === 'up') {
      const { applied } = await migrateUp(pool);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
    } else if (command === 'down') {
      const { rolledBack } = await migrateDown(pool);
      console.log(rolledBack ? `Rolled back: ${rolledBack}` : 'No migrations to roll back.');
    } else {
      const s = await migrationStatus(pool);
      console.log(JSON.stringify({ role: role.name, ...s }));
      if (s.pending.length || s.modified.length || s.unknown.length) process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
