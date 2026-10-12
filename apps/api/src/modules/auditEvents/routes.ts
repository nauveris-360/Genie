import type { FastifyInstance } from 'fastify';
import type { AuditEvent } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { toIso } from '../../lib/time.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';

interface Row { id: string; tenant_id: string; actor_user_id: string | null; action: string; target_type: string; target_id: string; metadata: Record<string, unknown>; created_at: Date }
const toEvent = (r: Row): AuditEvent => ({
  id: r.id, tenantId: r.tenant_id, actorUserId: r.actor_user_id, action: r.action, targetType: r.target_type, targetId: r.target_id,
  metadata: r.metadata, createdAt: toIso(r.created_at),
});

export async function auditEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/audit-events', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'auditEvent:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT * FROM audit_events WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toEvent);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });
}
