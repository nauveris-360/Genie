import type { PoolClient } from 'pg';

export interface Reservation {
  key: string;
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/**
 * Atomically reserves one attempt in a fixed-window bucket and reports whether
 * it is within `limit`. Reserving before the expensive/sensitive work (argon2
 * verification) and in a single UPSERT means concurrent attempts cannot all
 * slip past a check-then-increment race: at most `limit` reservations per
 * window ever succeed. Callers release() reservations that should not count
 * (e.g. a successful login, or an attempt that was rejected anyway).
 */
export async function reserve(client: PoolClient, key: string, limit: number, windowSeconds: number): Promise<Reservation> {
  const { rows } = await client.query<{ count: number; retry_after: number }>(
    `INSERT INTO rate_limit_buckets AS b (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN b.window_start <= now() - make_interval(secs => $2) THEN now() ELSE b.window_start END,
       count        = CASE WHEN b.window_start <= now() - make_interval(secs => $2) THEN 1 ELSE b.count + 1 END
     RETURNING count,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now()))))::int AS retry_after`,
    [key, windowSeconds],
  );
  const row = rows[0]!;
  return { key, allowed: row.count <= limit, count: row.count, retryAfterSeconds: row.retry_after };
}

export async function release(client: PoolClient, key: string): Promise<void> {
  await client.query('UPDATE rate_limit_buckets SET count = GREATEST(count - 1, 0) WHERE key = $1', [key]);
}

export async function clear(client: PoolClient, key: string): Promise<void> {
  await client.query('DELETE FROM rate_limit_buckets WHERE key = $1', [key]);
}

export async function deleteExpiredBuckets(client: PoolClient, olderThanSeconds: number): Promise<number> {
  const r = await client.query('DELETE FROM rate_limit_buckets WHERE window_start <= now() - make_interval(secs => $1)', [olderThanSeconds]);
  return r.rowCount ?? 0;
}
