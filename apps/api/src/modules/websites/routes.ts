import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Website, WebsiteStatus } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { recordAudit } from '../auditEvents/write.js';

const createSchema = z.object({ label: z.string().min(1).max(200), url: z.string().url().max(2048) });
const updateSchema = z
  .object({ label: z.string().min(1).max(200).optional(), url: z.string().url().max(2048).optional(), status: z.enum(['active', 'archived']).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

interface Row { id: string; tenant_id: string; label: string; url: string; status: WebsiteStatus; created_at: Date; updated_at: Date }
const toWebsite = (r: Row): Website => ({ id: r.id, tenantId: r.tenant_id, label: r.label, url: r.url, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) });

export async function websiteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/websites', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'website:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT * FROM websites WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toWebsite);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  app.post('/tenants/:tenantId/websites', async (request, reply) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'website:write');
    const body = parseOrThrow(createSchema, request.body);

    const website = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        'INSERT INTO websites (tenant_id, label, url) VALUES ($1, $2, $3) RETURNING *',
        [ctx.tenantId, body.label, body.url],
      );
      const row = rows[0]!;
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'website.registered', targetType: 'website', targetId: row.id, metadata: { label: row.label, url: row.url } });
      return toWebsite(row);
    });
    return reply.code(201).send({ data: website });
  });

  app.patch('/tenants/:tenantId/websites/:websiteId', async (request) => {
    const auth = requireUser(request);
    const { tenantId, websiteId } = request.params as { tenantId: string; websiteId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'website:write');
    const body = parseOrThrow(updateSchema, request.body);

    const website = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `UPDATE websites SET
           label = COALESCE($3, label), url = COALESCE($4, url), status = COALESCE($5, status), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [websiteId, ctx.tenantId, body.label ?? null, body.url ?? null, body.status ?? null],
      );
      const row = rows[0];
      if (!row) throw errors.notFound('Website');
      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'website.updated', targetType: 'website', targetId: row.id, metadata: body });
      return toWebsite(row);
    });
    return { data: website };
  });
}
