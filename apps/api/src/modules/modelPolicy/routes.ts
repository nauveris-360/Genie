import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModelPolicy } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { recordAudit } from '../auditEvents/write.js';

const updateSchema = z.object({ allowPaidFallback: z.boolean() });

interface Row { tenant_id: string; allow_paid_fallback: boolean; updated_at: Date; updated_by: string | null }
const toPolicy = (r: Row): ModelPolicy => ({ tenantId: r.tenant_id, allowPaidFallback: r.allow_paid_fallback, updatedAt: toIso(r.updated_at), updatedBy: r.updated_by });

export async function modelPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/model-policy', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'modelPolicy:read');
    const policy = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>('SELECT * FROM model_policies WHERE tenant_id = $1', [ctx.tenantId]);
      const row = rows[0];
      // A tenant without a row is on the default: paid fallback OFF.
      return row ? toPolicy(row) : { tenantId: ctx.tenantId, allowPaidFallback: false, updatedAt: new Date(0).toISOString(), updatedBy: null };
    });
    return { data: policy };
  });

  app.put('/tenants/:tenantId/model-policy', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'modelPolicy:write');
    const body = parseOrThrow(updateSchema, request.body);

    const policy = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `INSERT INTO model_policies (tenant_id, allow_paid_fallback, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id) DO UPDATE SET allow_paid_fallback = EXCLUDED.allow_paid_fallback, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [ctx.tenantId, body.allowPaidFallback, ctx.userId],
      );
      const row = rows[0]!;
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'model_policy.updated', targetType: 'model_policy', targetId: ctx.tenantId, metadata: { allowPaidFallback: row.allow_paid_fallback } });
      return toPolicy(row);
    });
    return { data: policy };
  });
}
