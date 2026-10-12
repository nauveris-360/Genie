import { randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadConfig } from '../config.js';

export interface SessionRecord {
  id: string;
  userId: string;
  csrfSecret: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

/** Creates an opaque session row. Only a hash of the bearer token is stored - a DB read alone can never be replayed as a live session. */
export async function createSession(client: PoolClient, userId: string): Promise<CreatedSession> {
  const config = loadConfig();
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60_000);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_secret, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, hashToken(token), csrfToken, expiresAt],
  );
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create session row');
  }
  return { sessionId: row.id, token, csrfToken, expiresAt };
}

export interface ResolvedSession {
  session: SessionRecord;
  user: { id: string; email: string; displayName: string };
}

/** Resolves a bearer session token to its session + user, or null if absent/expired/invalid. Never trusts a client-supplied userId or role. */
export async function resolveSession(client: PoolClient, token: string): Promise<ResolvedSession | null> {
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    csrf_secret: string;
    expires_at: Date;
    email: string;
    display_name: string;
  }>(
    `SELECT s.id, s.user_id, s.csrf_secret, s.expires_at, u.email, u.display_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;

  await client.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);

  return {
    session: { id: row.id, userId: row.user_id, csrfSecret: row.csrf_secret, expiresAt: row.expires_at },
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

export async function deleteSession(client: PoolClient, token: string): Promise<void> {
  await client.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function deleteExpiredSessions(client: PoolClient): Promise<number> {
  const result = await client.query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}
