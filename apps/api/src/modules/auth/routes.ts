import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthMe, Membership, Role } from '@genie/contracts';
import { loadConfig } from '../../config.js';
import { withClient } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { normalizeEmail } from '../../lib/strings.js';
import { verifyPassword } from '../../auth/password.js';
import { type CreatedSession, createSession, deleteSession } from '../../auth/session.js';
import { requireUser } from '../../auth/plugin.js';
import { clear, release, reserve } from '../../auth/rateLimit.js';
import { clientKey } from '../../lib/clientKey.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

export async function loadMe(userId: string): Promise<AuthMe> {
  return withClient(async (client) => {
    const userRes = await client.query<{ id: string; email: string; display_name: string; created_at: Date }>(
      'SELECT id, email, display_name, created_at FROM users WHERE id = $1',
      [userId],
    );
    const u = userRes.rows[0];
    if (!u) throw errors.unauthorized();
    const memRes = await client.query<{ id: string; tenant_id: string; name: string; role: Role; created_at: Date }>(
      `SELECT m.id, m.tenant_id, t.name, m.role, m.created_at
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    );
    const memberships: Membership[] = memRes.rows.map((m) => ({
      id: m.id,
      tenantId: m.tenant_id,
      tenantName: m.name,
      role: m.role,
      createdAt: toIso(m.created_at),
    }));
    return {
      user: { id: u.id, email: u.email, displayName: u.display_name, createdAt: toIso(u.created_at) },
      memberships,
    };
  });
}

function cookieOptions(secure: boolean, httpOnly: boolean, expires: Date) {
  return { path: '/', httpOnly, secure, sameSite: 'lax' as const, expires };
}

/** Sets the HttpOnly session cookie and the readable CSRF cookie for a newly created session. */
export function setSessionCookies(reply: FastifyReply, created: CreatedSession): void {
  const config = loadConfig();
  const secure = config.nodeEnv === 'production';
  reply.setCookie(config.sessionCookieName, created.token, cookieOptions(secure, true, created.expiresAt));
  reply.setCookie(config.csrfCookieName, created.csrfToken, cookieOptions(secure, false, created.expiresAt));
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  /**
   * Login throttling uses two buckets, both keyed on the client IP (request.ip,
   * which only honours X-Forwarded-For from TRUSTED_PROXIES):
   *   - per IP: bounds guessing/stuffing across many accounts from one source;
   *   - per (IP, account): bounds guessing against one account from one source.
   * There is intentionally no account-wide lockout: an attacker anywhere could
   * otherwise lock a victim out of their own account. A victim signing in from
   * their own address always has an unspent budget. Only failures count: a
   * successful login refunds its IP reservation and clears its pair bucket.
   * Limited requests are rejected before any password verification, with one
   * generic message for every case, so a 429 is neither a password oracle nor
   * an account-existence oracle.
   */
  app.post('/auth/login', async (request, reply: FastifyReply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const email = normalizeEmail(body.email);
    const source = clientKey(request.ip);
    const ipKey = `login:ip:${source}`;
    const pairKey = `login:pair:${source}:${createHash('sha256').update(email).digest('hex')}`;
    const windowSeconds = config.loginRateLimitWindowSeconds;

    const blocked = await withClient(async (client) => {
      const ip = await reserve(client, ipKey, config.loginMaxFailuresPerIp, windowSeconds);
      const pair = await reserve(client, pairKey, config.loginMaxFailuresPerIpAccount, windowSeconds);
      if (ip.allowed && pair.allowed) return null;
      // A rejected attempt is not evaluated, so it must not consume budget either.
      await release(client, ipKey);
      await release(client, pairKey);
      return Math.max(ip.allowed ? 0 : ip.retryAfterSeconds, pair.allowed ? 0 : pair.retryAfterSeconds);
    });
    if (blocked !== null) throw errors.loginRateLimited(blocked);

    const user = await withClient(async (client) => {
      const { rows } = await client.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email_normalized = $1',
        [email],
      );
      return rows[0] ?? null;
    });

    // Verify against a fixed dummy hash when the user is unknown so timing does not reveal account existence.
    const DUMMY = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(user?.password_hash ?? DUMMY, body.password);
    if (!user || !ok) throw errors.invalidCredentials();

    await withClient(async (client) => {
      await release(client, ipKey);
      await clear(client, pairKey);
    });
    const created = await withClient((client) => createSession(client, user.id));
    setSessionCookies(reply, created);

    const me = await loadMe(user.id);
    return reply.code(200).send({ data: me });
  });

  app.post('/auth/logout', async (request, reply) => {
    requireUser(request);
    if (request.sessionToken) {
      await withClient((client) => deleteSession(client, request.sessionToken!));
    }
    reply.clearCookie(config.sessionCookieName, { path: '/' });
    reply.clearCookie(config.csrfCookieName, { path: '/' });
    return { data: { success: true } };
  });

  app.get('/auth/me', async (request) => {
    const auth = requireUser(request);
    return { data: await loadMe(auth.user.id) };
  });
}
