import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { freshDatabase } from './helpers.js';
import { closePool, getPool } from '../../src/db/index.js';
import { currentRole, prepareDatabase, rlsProblems, UnsafeDatabaseError, unsafeRoleReasons } from '../../src/db/safety.js';

before(async () => { await freshDatabase(); });
after(async () => { await closePool(); });

/** A real pool whose role lookup reports chosen attributes; every other query and connection is real. */
function poolReportingRole(attrs: { rolsuper: boolean; rolbypassrls: boolean }, seen: string[] = []): Pool {
  const real = getPool();
  return {
    query: (sql: string, params?: unknown[]) => {
      seen.push(sql);
      if (/FROM pg_roles WHERE rolname = current_user/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'impersonated', ...attrs }] });
      }
      return real.query(sql, params as unknown[]);
    },
    connect: () => { seen.push('<connect>'); return real.connect(); },
  } as unknown as Pool;
}
const quietWarn = () => { const w: string[] = []; return { w, warn: (m: string) => w.push(m) }; };

test('role attributes: superuser and BYPASSRLS are each unsafe; the real test role is safe', async () => {
  assert.deepEqual(unsafeRoleReasons({ name: 'x', superuser: false, bypassRls: false }), []);
  assert.equal(unsafeRoleReasons({ name: 'x', superuser: true, bypassRls: false }).length, 1);
  assert.equal(unsafeRoleReasons({ name: 'x', superuser: false, bypassRls: true }).length, 1);
  assert.equal(unsafeRoleReasons({ name: 'x', superuser: true, bypassRls: true }).length, 2);
  const role = await currentRole(getPool());
  assert.deepEqual([role.superuser, role.bypassRls], [false, false], `test role ${role.name} must be a safe role`);
});

test('production refuses an unsafe role BEFORE running any migration', async () => {
  for (const attrs of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
    const seen: string[] = [];
    await assert.rejects(
      prepareDatabase(poolReportingRole(attrs, seen), { production: true, migrateOnBoot: true, warn: () => {} }),
      (e: unknown) => e instanceof UnsafeDatabaseError && /impersonated/.test((e as Error).message) && /(superuser|BYPASSRLS)/.test((e as Error).message),
    );
    assert.equal(seen.length, 1, `only the role lookup ran, nothing else: ${seen.join(' | ')}`);
  }
});

test('non-production only warns about an unsafe role (local setups keep working)', async () => {
  const { w, warn } = quietWarn();
  const r = await prepareDatabase(poolReportingRole({ rolsuper: true, rolbypassrls: false }), { production: false, migrateOnBoot: true, warn });
  assert.deepEqual(r.applied, []);
  assert.ok(w.some((m) => /superuser/.test(m)));
});

test('a runtime role that cannot change the schema gets an actionable refusal when MIGRATE_ON_BOOT is on', async () => {
  const real = getPool();
  const denied = Object.assign(new Error('permission denied for schema public'), { code: '42501' });
  const pool = {
    query: (sql: string, params?: unknown[]) => real.query(sql, params as unknown[]),
    connect: async () => {
      const c = await real.connect();
      return { query: async (sql: string, p?: unknown[]) => { if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) throw denied; return c.query(sql, p as unknown[]); }, release: (d?: boolean) => c.release(d) };
    },
  } as unknown as Pool;
  await assert.rejects(
    prepareDatabase(pool, { production: true, migrateOnBoot: true, warn: () => {} }),
    /MIGRATE_ON_BOOT=true but role .* may not change the schema.*set MIGRATE_ON_BOOT=false/,
  );
  assert.equal((await real.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`)).rows[0].n, 0, 'lock released');
});

test('safe role + intact schema passes in production, with and without migrate-on-boot', async () => {
  for (const migrateOnBoot of [true, false]) {
    const { w, warn } = quietWarn();
    const r = await prepareDatabase(getPool(), { production: true, migrateOnBoot, warn });
    assert.deepEqual(r.applied, []);
    assert.deepEqual(w, []);
  }
  assert.deepEqual(await rlsProblems(getPool()), []);
});

test('RLS that is not enabled, not forced, or missing its policy is detected and refused in production', async () => {
  const db = getPool();
  const cases: Array<[string, string, string, RegExp]> = [
    ['websites not forced', 'ALTER TABLE websites NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE websites FORCE ROW LEVEL SECURITY', /websites: row-level security not forced/],
    ['agents disabled', 'ALTER TABLE agents DISABLE ROW LEVEL SECURITY', 'ALTER TABLE agents ENABLE ROW LEVEL SECURITY', /agents: row-level security disabled/],
    ['tasks policy missing', 'ALTER POLICY tenant_isolation ON tasks RENAME TO tenant_isolation_x', 'ALTER POLICY tenant_isolation_x ON tasks RENAME TO tenant_isolation', /tasks: tenant_isolation policy missing/],
  ];
  for (const [label, weaken, restore, expected] of cases) {
    await db.query(weaken);
    try {
      const problems = await rlsProblems(db);
      assert.ok(problems.some((p) => expected.test(p)), `${label}: ${problems.join(' | ')}`);
      await assert.rejects(prepareDatabase(db, { production: true, migrateOnBoot: false, warn: () => {} }), expected, label);
    } finally {
      await db.query(restore);
    }
  }
  assert.deepEqual(await rlsProblems(db), [], 'every weakening was restored');
});

test('without migrate-on-boot, production refuses pending, modified or unknown migrations', async () => {
  const db = getPool();
  const saved = (await db.query(`SELECT * FROM schema_migrations WHERE id = '007_invitations'`)).rows[0];
  const run = () => prepareDatabase(db, { production: true, migrateOnBoot: false, warn: () => {} });

  await db.query(`DELETE FROM schema_migrations WHERE id = '007_invitations'`);
  try { await assert.rejects(run(), /pending migrations.*007_invitations/); }
  finally { await db.query('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($1, $2, $3)', [saved.id, saved.checksum, saved.applied_at]); }

  await db.query(`UPDATE schema_migrations SET checksum = 'x' WHERE id = '007_invitations'`);
  try { await assert.rejects(run(), /modified since they ran.*007_invitations/); }
  finally { await db.query('UPDATE schema_migrations SET checksum = $2 WHERE id = $1', [saved.id, saved.checksum]); }

  await db.query(`INSERT INTO schema_migrations (id, checksum) VALUES ('999_from_the_future', 'x')`);
  try { await assert.rejects(run(), /code older than schema.*999_from_the_future/); }
  finally { await db.query(`DELETE FROM schema_migrations WHERE id = '999_from_the_future'`); }

  const { w, warn } = quietWarn();
  await db.query(`DELETE FROM schema_migrations WHERE id = '007_invitations'`);
  try {
    await prepareDatabase(db, { production: false, migrateOnBoot: false, warn });
    assert.ok(w.some((m) => /pending migrations/.test(m)), 'non-production warns');
  } finally { await db.query('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($1, $2, $3)', [saved.id, saved.checksum, saved.applied_at]); }
  await run();
});
