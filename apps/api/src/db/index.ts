import pg from 'pg';
import type { Pool as PoolType, PoolClient } from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;

let pool: PoolType | undefined;

export function getPool(): PoolType {
  if (!pool) {
    const config = loadConfig();
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
      max: config.databasePoolMax,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Runs `fn` inside a transaction with the Postgres session variable
 * app.current_tenant_id set to tenantId via set_config(..., true) (the
 * "true" is is_local, i.e. scoped to this transaction only - equivalent to
 * SET LOCAL but parameterizable). Every tenant-scoped table's row-level
 * security policy reads this setting, so queries issued through `client`
 * inside `fn` can only ever see rows for tenantId, even if a query has a
 * bug that forgets a WHERE tenant_id = ... clause.
 */
export async function withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** For queries that are intentionally not tenant-scoped (users, tenants, memberships, sessions, model registry). */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
