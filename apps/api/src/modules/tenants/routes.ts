import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role, Tenant } from '@genie/contracts';
import { withClient } from '../../db/index.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { slugify } from '../../lib/strings.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { recordAudit } from '../auditEvents/write.js';

const createSchema = z.object({ name: z.string().min(1).max(200) });

interface TenantRow { id: string; name: string; slug: string; role: Role; created_at: Date; updated_at: Date }

function toTenant(r: TenantRow): Tenant {
  return { id: r.id, name: r.name, slug: r.slug, role: r.role, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
}

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants', async (request) => {
    const auth = requireUser(request);
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);

    const rows = await withClient(async (client) => {
      const { rows } = await client.query<TenantRow>(
        `SELECT t.id, t.name, t.slug, m.role, t.created_at, t.updated_at
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
         ORDER BY t.created_at DESC, t.id DESC LIMIT $4`,
        [auth.user.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return rows.map(toTenant);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  app.post('/tenants', async (request, reply) => {
    const auth = requireUser(request);
    const body = parseOrThrow(createSchema, request.body);

    const tenant = await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        let slug = slugify(body.name);
        const clash = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
        if (clash.rowCount) slug = `${slug}-${Date.now().toString(36)}`;

        const t = await client.query<{ id: string; name: string; slug: string; created_at: Date; updated_at: Date }>(
          'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING *',
          [body.name, slug],
        );
        const row = t.rows[0]!;
        await client.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [row.id, auth.user.id]);
        await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', row.id]);
        await client.query('INSERT INTO model_policies (tenant_id, allow_paid_fallback, updated_by) VALUES ($1, false, $2)', [row.id, auth.user.id]);
        await recordAudit(client, { tenantId: row.id, actorUserId: auth.user.id, action: 'tenant.created', targetType: 'tenant', targetId: row.id, metadata: { name: row.name } });
        await client.query('COMMIT');
        return toTenant({ ...row, role: 'owner' });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    return reply.code(201).send({ data: tenant });
  });
}
