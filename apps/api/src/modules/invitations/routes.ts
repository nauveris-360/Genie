import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canManageRole, type Invitation, type Role } from '@genie/contracts';
import { loadConfig } from '../../config.js';
import { getPool, withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { normalizeEmail } from '../../lib/strings.js';
import { clientKey } from '../../lib/clientKey.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { hashPassword } from '../../auth/password.js';
import { createSession } from '../../auth/session.js';
import { CSRF_HEADER, csrfHeaderMatchesSession } from '../../auth/csrf.js';
import { release, reserve } from '../../auth/rateLimit.js';
import { recordAudit } from '../auditEvents/write.js';
import { loadMe, setSessionCookies } from '../auth/routes.js';

export const INVITATION_TTL_DAYS = 7;
const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;

const createSchema = z.object({ email: z.string().email().max(320), role: z.enum(ROLES) });
const acceptSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  password: z.string().min(12).max(512).optional(),
  displayName: z.string().min(1).max(200).optional(),
});

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface Row {
  id: string; tenant_id: string; email: string; role: Role; status: 'pending' | 'accepted' | 'revoked';
  invited_by: string; expires_at: Date; accepted_at: Date | null; created_at: Date;
}
const toInvitation = (r: Row): Invitation => ({
  id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role,
  status: r.status === 'pending' && r.expires_at.getTime() <= Date.now() ? 'expired' : r.status,
  invitedBy: r.invited_by, expiresAt: toIso(r.expires_at), acceptedAt: r.accepted_at ? toIso(r.accepted_at) : null, createdAt: toIso(r.created_at),
});
const COLUMNS = 'id, tenant_id, email, role, status, invited_by, expires_at, accepted_at, created_at';

export async function invitationRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  app.get('/tenants/:tenantId/invitations', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:manage');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM invitations WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toInvitation);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  /**
   * Creates a one-time invitation and returns its token exactly once. Only a
   * SHA-256 of the token is stored. Any earlier pending invitation for the same
   * email in this tenant is revoked, so at most one link is live. No email is
   * sent: the inviter delivers the link out-of-band.
   */
  app.post('/tenants/:tenantId/invitations', async (request, reply) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:manage');
    const body = parseOrThrow(createSchema, request.body);
    if (!canManageRole(ctx.role, body.role)) throw errors.forbidden();
    const email = body.email.trim();
    const emailNormalized = normalizeEmail(email);
    const token = randomBytes(32).toString('base64url');

    const invitation = await withTenant(ctx.tenantId, async (client) => {
      const member = await client.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email_normalized = $2`,
        [ctx.tenantId, emailNormalized],
      );
      if (member.rowCount) throw errors.alreadyMember();
      await client.query(
        `UPDATE invitations SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND email_normalized = $2 AND status = 'pending'`,
        [ctx.tenantId, emailNormalized],
      );
      const { rows } = await client.query<Row>(
        `INSERT INTO invitations (tenant_id, email, email_normalized, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING ${COLUMNS}`,
        [ctx.tenantId, email, emailNormalized, body.role, hashToken(token), ctx.userId, INVITATION_TTL_DAYS],
      );
      const row = rows[0]!;
      await recordAudit(client, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'invitation.created', targetType: 'invitation', targetId: row.id,
        metadata: { email, role: body.role },
      });
      return toInvitation(row);
    });
    return reply.code(201).send({ data: { invitation, inviteToken: token } });
  });

  app.post('/tenants/:tenantId/invitations/:invitationId/revoke', async (request) => {
    const auth = requireUser(request);
    const { tenantId, invitationId } = request.params as { tenantId: string; invitationId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:manage');
    const invitation = await withTenant(ctx.tenantId, async (client) => {
      const cur = await client.query<Row>(`SELECT ${COLUMNS} FROM invitations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [invitationId, ctx.tenantId]);
      const row = cur.rows[0];
      if (!row) throw errors.notFound('Invitation');
      if (!canManageRole(ctx.role, row.role)) throw errors.forbidden();
      if (row.status !== 'pending') return toInvitation(row);
      const { rows } = await client.query<Row>(
        `UPDATE invitations SET status = 'revoked', revoked_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [row.id],
      );
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'invitation.revoked', targetType: 'invitation', targetId: row.id, metadata: { email: row.email, role: row.role } });
      return toInvitation(rows[0]!);
    });
    return { data: invitation };
  });

  /**
   * Public (no session needed) but Origin-checked and rate limited per client
   * address. A token that is unknown, used, revoked or expired gets one
   * generic error. If the invited email already has an account, the caller
   * must be signed in as exactly that user (with a valid CSRF header): there is
   * no second password-checking path here. Otherwise a new account is created
   * with the supplied password and signed in. Acceptance is a conditional
   * UPDATE, so a token can be used at most once even under concurrency.
   */
  app.post('/invitations/accept', async (request, reply) => {
    const body = parseOrThrow(acceptSchema, request.body);
    const bucket = `invite:ip:${clientKey(request.ip)}`;
    const limited = await getPool().connect().then(async (c) => {
      try {
        const r = await reserve(c, bucket, config.loginMaxFailuresPerIp, config.loginRateLimitWindowSeconds);
        if (r.allowed) return null;
        await release(c, bucket);
        return r.retryAfterSeconds;
      } finally { c.release(); }
    });
    if (limited !== null) throw errors.loginRateLimited(limited);

    const pool = getPool();
    const found = await pool.query<Row & { email_normalized: string }>(
      `SELECT ${COLUMNS}, email_normalized FROM invitations WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()`,
      [hashToken(body.token)],
    );
    const invitation = found.rows[0];
    if (!invitation) throw errors.invitationInvalid();
    // A valid token is not a guessing failure; refund the reservation.
    await pool.query('UPDATE rate_limit_buckets SET count = GREATEST(count - 1, 0) WHERE key = $1', [bucket]);

    const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [invitation.email_normalized]);
    const existingUserId = existing.rows[0]?.id ?? null;
    let newPasswordHash: string | null = null;
    if (existingUserId) {
      if (!request.auth) throw errors.unauthorized();
      if (request.auth.user.id !== existingUserId) throw errors.forbidden();
      if (!csrfHeaderMatchesSession(request.headers[CSRF_HEADER], request.auth.session.csrfSecret)) throw errors.csrf();
    } else {
      if (request.auth) throw errors.forbidden();
      if (!body.password) throw errors.validation('password: required to create the invited account (at least 12 characters).');
      newPasswordHash = await hashPassword(body.password);
    }

    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', invitation.tenant_id]);
      if (existingUserId) {
        userId = existingUserId;
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email_normalized) DO NOTHING RETURNING id`,
          [invitation.email, invitation.email_normalized, newPasswordHash, body.displayName ?? invitation.email.split('@')[0] ?? 'Member'],
        );
        if (!created.rows[0]) throw errors.unauthorized(); // account appeared concurrently: sign in, then accept
        userId = created.rows[0].id;
      }
      const claimed = await client.query(
        `UPDATE invitations SET status = 'accepted', accepted_by = $2, accepted_at = now()
         WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
        [invitation.id, userId],
      );
      if (!claimed.rowCount) throw errors.invitationInvalid();
      const joined = await client.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING id`,
        [invitation.tenant_id, userId, invitation.role],
      );
      if (!joined.rows[0]) throw errors.alreadyMember();
      await recordAudit(client, {
        tenantId: invitation.tenant_id, actorUserId: userId, action: 'invitation.accepted', targetType: 'invitation', targetId: invitation.id,
        metadata: { role: invitation.role, newAccount: !existingUserId },
      });
      await recordAudit(client, { tenantId: invitation.tenant_id, actorUserId: userId, action: 'member.joined', targetType: 'membership', targetId: joined.rows[0].id, metadata: { role: invitation.role } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (!existingUserId) {
      const session = await pool.connect().then(async (c) => { try { return await createSession(c, userId); } finally { c.release(); } });
      setSessionCookies(reply, session);
    }
    return reply.code(200).send({ data: await loadMe(userId) });
  });
}
