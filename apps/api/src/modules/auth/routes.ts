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
import { createSession, deleteSession } from '../../auth/session.js';
import { requireUser } from '../../auth/plugin.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

async function loadMe(userId: string): Promise<AuthMe> {
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const secure = config.nodeEnv === 'production';

  app.post('/auth/login', async (request, reply: FastifyReply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const email = normalizeEmail(body.email);

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

    const created = await withClient((client) => createSession(client, user.id));
    reply.setCookie(config.sessionCookieName, created.token, cookieOptions(secure, true, created.expiresAt));
    reply.setCookie(config.csrfCookieName, created.csrfToken, cookieOptions(secure, false, created.expiresAt));

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
