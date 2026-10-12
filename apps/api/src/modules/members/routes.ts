import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canManageRole, type Member, type Role, roleHasPermission } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission, type TenantContext } from '../../auth/rbac.js';
import { recordAudit } from '../auditEvents/write.js';

const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
const updateSchema = z.object({ role: z.enum(ROLES) });

interface Row { id: string; tenant_id: string; user_id: string; email: string; display_name: string; role: Role; created_at: Date }
const toMember = (r: Row): Member => ({
  id: r.id, tenantId: r.tenant_id, userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, createdAt: toIso(r.created_at),
});

/**
 * Locks every owner row of the tenant before anything else. Every member
 * change takes this lock first, so concurrent changes (e.g. two owners
 * demoting each other) serialize, and the actor's role is re-read under the
 * lock: a role changed a moment ago by someone else is what gets authorized,
 * not the role seen by the earlier permission check.
 */
async function lockForChange(client: PoolClient, ctx: TenantContext, membershipId: string): Promise<{ target: Row; ownerCount: number; actorRole: Role }> {
  const owners = await client.query('SELECT id FROM memberships WHERE tenant_id = $1 AND role = $2 ORDER BY id FOR UPDATE', [ctx.tenantId, 'owner']);
  const actor = await client.query<{ role: Role }>('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [ctx.tenantId, ctx.userId]);
  const actorRole = actor.rows[0]?.role;
  if (!actorRole || !roleHasPermission(actorRole, 'member:manage')) throw errors.forbidden();
  const res = await client.query<Row>(
    `SELECT m.id, m.tenant_id, m.user_id, u.email, u.display_name, m.role, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.id = $1 AND m.tenant_id = $2 FOR UPDATE OF m`,
    [membershipId, ctx.tenantId],
  );
  const target = res.rows[0];
  if (!target) throw errors.notFound('Member');
  return { target, ownerCount: owners.rowCount ?? 0, actorRole };
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/members', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT m.id, m.tenant_id, m.user_id, u.email, u.display_name, m.role, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
         ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toMember);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  app.patch('/tenants/:tenantId/members/:membershipId', async (request) => {
    const auth = requireUser(request);
    const { tenantId, membershipId } = request.params as { tenantId: string; membershipId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:manage');
    const body = parseOrThrow(updateSchema, request.body);

    const member = await withTenant(ctx.tenantId, async (client) => {
      const { target, ownerCount, actorRole } = await lockForChange(client, ctx, membershipId);
      if (!canManageRole(actorRole, target.role) || !canManageRole(actorRole, body.role)) throw errors.forbidden();
      if (target.role === body.role) return toMember(target);
      if (target.role === 'owner' && ownerCount <= 1) throw errors.lastOwner();
      await client.query('UPDATE memberships SET role = $2, updated_at = now() WHERE id = $1', [target.id, body.role]);
      await recordAudit(client, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'member.role_changed', targetType: 'membership', targetId: target.id,
        metadata: { userId: target.user_id, from: target.role, to: body.role },
      });
      return toMember({ ...target, role: body.role });
    });
    return { data: member };
  });

  app.delete('/tenants/:tenantId/members/:membershipId', async (request) => {
    const auth = requireUser(request);
    const { tenantId, membershipId } = request.params as { tenantId: string; membershipId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'member:manage');

    await withTenant(ctx.tenantId, async (client) => {
      const { target, ownerCount, actorRole } = await lockForChange(client, ctx, membershipId);
      if (!canManageRole(actorRole, target.role)) throw errors.forbidden();
      if (target.role === 'owner' && ownerCount <= 1) throw errors.lastOwner();
      await client.query('DELETE FROM memberships WHERE id = $1', [target.id]);
      await recordAudit(client, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'member.removed', targetType: 'membership', targetId: target.id,
        metadata: { userId: target.user_id, role: target.role },
      });
    });
    // Access ends on the removed user's very next request: membership is re-checked every time.
    return { data: { success: true } };
  });
}
