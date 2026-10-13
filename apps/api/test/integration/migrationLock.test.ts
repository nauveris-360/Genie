import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadConfig } from '../../src/config.js';
import { appliedMigrations, migrateDown, migrateUp, MIGRATION_LOCK_KEY } from '../../src/db/migrate.js';

const ALL = ['001_core', '002_tenant_scoped', '003_seed_models', '004_rls_nullif', '005_rate_limit_and_verification', '006_approval_digest_v2', '007_invitations'];
const pools: pg.Pool[] = [];
function newPool(): pg.Pool {
  const p = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 2 });
  pools.push(p);
  return p;
}
const admin = newPool();

after(async () => {
  await migrateUp(admin);
  await Promise.all(pools.map((p) => p.end()));
});

async function dropSchema() {
  if (loadConfig().nodeEnv !== 'test') throw new Error('refusing to drop a non-test schema');
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
async function advisoryLocksHeld(): Promise<number> {
  const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`);
  return rows[0].n;
}
const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

test('concurrent migrateUp runs from separate instances apply every migration exactly once', async () => {
  await dropSchema();
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => migrateUp(newPool())));
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 0, rejected.map((r) => String((r as PromiseRejectedResult).reason)).join('\n'));
  const appliedLists = results.map((r) => (r as PromiseFulfilledResult<{ applied: string[] }>).value.applied);
  assert.deepEqual(appliedLists.flat().sort(), ALL, 'each migration applied by exactly one runner');
  assert.equal(appliedLists.filter((l) => l.length > 0).length, 1, 'one runner did all the work; the others found nothing pending');
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(rows[0].n, ALL.length);
  assert.equal(await advisoryLocksHeld(), 0, 'lock released after success');
});

test('a run waits while another connection holds the migration lock (up and down)', async () => {
  const holder = await admin.connect();
  try {
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_KEY]);
    const up = migrateUp(newPool());
    const down = migrateDown(newPool());
    assert.equal(await settledWithin(up, 400), false, 'migrateUp must block while the lock is held');
    assert.equal(await settledWithin(down, 50), false, 'migrateDown must block while the lock is held');
    await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_KEY]);
    const [u, d] = await Promise.all([up, down]);
    // Whichever ran first, the database ends consistent with schema_migrations.
    const applied = await appliedMigrations(admin);
    assert.ok(u.applied.length === 0 || u.applied.length === 1);
    assert.equal(d.rolledBack, '007_invitations');
    const invitationsExists = (await admin.query(`SELECT to_regclass('public.invitations') IS NOT NULL AS e`)).rows[0].e;
    assert.equal(invitationsExists, applied.includes('007_invitations'));
  } finally {
    holder.release();
  }
  await migrateUp(admin);
  assert.equal(await advisoryLocksHeld(), 0);
});

test('a failing run releases the lock so the next run is not blocked', async () => {
  await migrateUp(admin);
  await admin.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '003_seed_models'`);
  await assert.rejects(migrateUp(newPool()), /different checksum/);
  assert.equal(await advisoryLocksHeld(), 0, 'lock released after failure');
  const real = (await import('node:crypto')).createHash('sha256')
    .update(await (await import('node:fs/promises')).readFile(new URL('../../src/migrations/003_seed_models.up.sql', import.meta.url), 'utf8'))
    .digest('hex');
  await admin.query(`UPDATE schema_migrations SET checksum = $1 WHERE id = '003_seed_models'`, [real]);
  const next = migrateUp(newPool());
  assert.equal(await settledWithin(next, 5000), true, 'next run acquires the lock');
  assert.deepEqual((await next).applied, []);
});
