import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Agent, AgentStatus } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { assertModelAllowed } from '../../policy/freeFirst.js';
import { recordAudit } from '../auditEvents/write.js';

const config = z.record(z.unknown());
const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  providerConnectionId: z.string().uuid(),
  modelId: z.string().min(1).max(200),
  requiresApproval: z.boolean().optional(),
  config: config.optional(),
});
const updateSchema = createSchema.partial().extend({ status: z.enum(['active', 'disabled']).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

export interface AgentRow {
  id: string; tenant_id: string; name: string; description: string | null; status: AgentStatus;
  provider_connection_id: string; model_id: string; requires_approval: boolean; config: Record<string, unknown>;
  created_at: Date; updated_at: Date;
}
export const toAgent = (r: AgentRow): Agent => ({
  id: r.id, tenantId: r.tenant_id, name: r.name, description: r.description, status: r.status,
  providerConnectionId: r.provider_connection_id, modelId: r.model_id, requiresApproval: r.requires_approval,
  config: r.config, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/agents', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'agent:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<AgentRow>(
        `SELECT * FROM agents WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toAgent);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  app.post('/tenants/:tenantId/agents', async (request, reply) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'agent:write');
    const body = parseOrThrow(createSchema, request.body);

    const agent = await withTenant(ctx.tenantId, async (client) => {
      // The connection must be visible inside this tenant's RLS scope; a foreign id simply does not exist here.
      const conn = await client.query('SELECT 1 FROM provider_connections WHERE id = $1 AND tenant_id = $2', [body.providerConnectionId, ctx.tenantId]);
      if (!conn.rowCount) throw errors.notFound('Provider connection');
      await assertModelAllowed(client, ctx.tenantId, body.modelId, 'chat');

      const { rows } = await client.query<AgentRow>(
        `INSERT INTO agents (tenant_id, name, description, provider_connection_id, model_id, requires_approval, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
        [ctx.tenantId, body.name, body.description ?? null, body.providerConnectionId, body.modelId, body.requiresApproval ?? true, JSON.stringify(body.config ?? {})],
      );
      const row = rows[0]!;
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'agent.created', targetType: 'agent', targetId: row.id, metadata: { name: row.name, modelId: row.model_id } });
      return toAgent(row);
    });
    return reply.code(201).send({ data: agent });
  });

  app.patch('/tenants/:tenantId/agents/:agentId', async (request) => {
    const auth = requireUser(request);
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'agent:write');
    const body = parseOrThrow(updateSchema, request.body);

    const agent = await withTenant(ctx.tenantId, async (client) => {
      if (body.providerConnectionId) {
        const conn = await client.query('SELECT 1 FROM provider_connections WHERE id = $1 AND tenant_id = $2', [body.providerConnectionId, ctx.tenantId]);
        if (!conn.rowCount) throw errors.notFound('Provider connection');
      }
      if (body.modelId) await assertModelAllowed(client, ctx.tenantId, body.modelId, 'chat');

      const { rows } = await client.query<AgentRow>(
        `UPDATE agents SET
           name = COALESCE($3, name), description = COALESCE($4, description), status = COALESCE($5, status),
           provider_connection_id = COALESCE($6, provider_connection_id), model_id = COALESCE($7, model_id),
           requires_approval = COALESCE($8, requires_approval), config = COALESCE($9::jsonb, config), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [agentId, ctx.tenantId, body.name ?? null, body.description ?? null, body.status ?? null, body.providerConnectionId ?? null,
          body.modelId ?? null, body.requiresApproval ?? null, body.config ? JSON.stringify(body.config) : null],
      );
      const row = rows[0];
      if (!row) throw errors.notFound('Agent');
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'agent.updated', targetType: 'agent', targetId: row.id, metadata: body });
      return toAgent(row);
    });
    return { data: agent };
  });
}
