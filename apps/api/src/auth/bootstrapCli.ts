/**
 * One-time private owner bootstrap.
 *
 * There is deliberately no default admin account or password anywhere in this
 * codebase. The first owner is created by an operator running this script once,
 * on the server, with the credentials supplied inline as environment variables
 * for that single invocation (not stored in .env, fixtures, or Git):
 *
 *   BOOTSTRAP_OWNER_EMAIL=owner@example.com \
 *   BOOTSTRAP_OWNER_PASSWORD='<strong passphrase>' \
 *   BOOTSTRAP_TENANT_NAME='Primary' \
 *   npm run bootstrap:owner
 *
 * The script refuses to run if any user already exists, so it cannot be
 * re-run to silently create extra owners. See docs/RUNBOOK.md.
 */
import { getPool, closePool } from '../db/index.js';
import { hashPassword } from './password.js';
import { normalizeEmail, slugify } from '../lib/strings.js';

async function main() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  const tenantName = process.env.BOOTSTRAP_TENANT_NAME?.trim() || 'Primary';

  if (!email || !email.includes('@')) {
    throw new Error('BOOTSTRAP_OWNER_EMAIL must be set to a valid email for this single invocation.');
  }
  if (!password || password.length < 12) {
    throw new Error('BOOTSTRAP_OWNER_PASSWORD must be set and at least 12 characters. It is never defaulted.');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    if (Number(existing.rows[0]?.count ?? '0') > 0) {
      throw new Error('Bootstrap refused: users already exist. This is a one-time operation; add further members through the application.');
    }

    const passwordHash = await hashPassword(password);
    const userRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, email_normalized, password_hash, display_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, normalizeEmail(email), passwordHash, email.split('@')[0] ?? 'Owner'],
    );
    const userId = userRes.rows[0]!.id;

    const tenantRes = await client.query<{ id: string }>(
      'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id',
      [tenantName, slugify(tenantName)],
    );
    const tenantId = tenantRes.rows[0]!.id;

    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [tenantId, userId],
    );
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId],
    );
    await client.query('INSERT INTO model_policies (tenant_id, allow_paid_fallback, updated_by) VALUES ($1, false, $2)', [tenantId, userId]);
    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, 'tenant.bootstrapped', 'tenant', $1, '{}'::jsonb)`,
      [tenantId, userId],
    );
    await client.query('COMMIT');

    console.log(`Bootstrapped owner ${email} for tenant "${tenantName}" (${tenantId}).`);
    console.log('Clear BOOTSTRAP_OWNER_PASSWORD from your shell environment and history now.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
