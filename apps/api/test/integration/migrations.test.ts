import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../../src/db/index.js';
import { appliedMigrations, migrateDown, migrateUp } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';

const ALL = ['001_core', '002_tenant_scoped', '003_seed_models', '004_rls_nullif', '005_rate_limit_and_verification'];

after(async () => { await migrateUp(getPool()); await closePool(); });

async function dropEverything() {
  if (loadConfig().nodeEnv !== 'test') throw new Error('refusing to drop a non-test schema');
  await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

test('migrations apply from an empty database, are idempotent, roll back one step, and re-apply', async () => {
  const pool = getPool();
  await dropEverything();
  assert.deepEqual(await appliedMigrations(pool), []);

  const first = await migrateUp(pool);
  assert.deepEqual(first.applied, ALL);
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  assert.deepEqual(tables, ['agents', 'approvals', 'audit_events', 'memberships', 'model_policies', 'models', 'provider_connections', 'rate_limit_buckets', 'schema_migrations', 'sessions', 'tasks', 'tenants', 'users', 'websites']);
  // 005: every seeded registry row is untrusted and carries no fake verification timestamp
  const seeded = (await pool.query(`SELECT verification_source, last_verified_at FROM models`)).rows;
  assert.ok(seeded.every((r) => r.verification_source === 'seed' && r.last_verified_at === null));
  const rls = (await pool.query(`SELECT relname FROM pg_class WHERE relrowsecurity AND relforcerowsecurity AND relkind = 'r' ORDER BY relname`)).rows.map((r) => r.relname);
  assert.deepEqual(rls, ['agents', 'approvals', 'audit_events', 'model_policies', 'provider_connections', 'tasks', 'websites']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM models')).rows[0].n, 3);
  // 004: the policy must tolerate the '' the GUC is left with after a committed SET LOCAL
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id', '00000000-0000-4000-8000-000000000000', true)"); await client.query('COMMIT');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM websites')).rows[0].n, 0);
  } finally { client.release(); }

  const second = await migrateUp(pool);
  assert.deepEqual(second.applied, [], 're-running is a no-op');

  assert.equal((await migrateDown(pool)).rolledBack, '005_rate_limit_and_verification');
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'models' AND column_name = 'verification_source'`)).rowCount;
  assert.equal(cols, 0);
  assert.equal((await migrateDown(pool)).rolledBack, '004_rls_nullif');
  assert.equal((await migrateDown(pool)).rolledBack, '003_seed_models');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM models')).rows[0].n, 0);
  assert.deepEqual(await appliedMigrations(pool), ['001_core', '002_tenant_scoped']);

  assert.equal((await migrateDown(pool)).rolledBack, '002_tenant_scoped');
  const afterDown = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  assert.deepEqual(afterDown, ['memberships', 'schema_migrations', 'sessions', 'tenants', 'users']);

  const reup = await migrateUp(pool);
  assert.deepEqual(reup.applied, ['002_tenant_scoped', '003_seed_models', '004_rls_nullif', '005_rate_limit_and_verification']);
  assert.deepEqual(await appliedMigrations(pool), ALL);
});

test('an edited, already-applied migration is detected by checksum instead of silently skipped', async () => {
  const pool = getPool();
  await migrateUp(pool);
  await pool.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '002_tenant_scoped'`);
  await assert.rejects(migrateUp(pool), /different checksum/);
  await dropEverything();
  await migrateUp(pool);
});

test('rolling back past the first migration is a clean no-op', async () => {
  const pool = getPool();
  await dropEverything();
  await migrateUp(pool);
  for (let i = 0; i < ALL.length; i++) await migrateDown(pool);
  assert.deepEqual(await appliedMigrations(pool), []);
  assert.deepEqual(await migrateDown(pool), { rolledBack: null });
  await migrateUp(pool);
});
