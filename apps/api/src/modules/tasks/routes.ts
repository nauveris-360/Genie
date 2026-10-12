import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { type TaskRow, type TaskService, toTask } from './service.js';

const TASK_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'] as const;
const createSchema = z.object({
  agentId: z.string().uuid(),
  websiteId: z.string().uuid().optional(),
  type: z.enum(['chat', 'summarize', 'embed', 'title_generate']),
  input: z.record(z.unknown()),
});

export async function taskRoutes(app: FastifyInstance, opts: { tasks: TaskService }): Promise<void> {
  app.get('/tenants/:tenantId/tasks', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'task:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const status = q.status;
    if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) throw errors.validation('status is invalid.');

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<TaskRow>(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND ($5::text IS NULL OR status = $5)
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1, status ?? null],
      );
      return rows.map(toTask);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  app.post('/tenants/:tenantId/tasks', async (request, reply) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'task:submit');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw errors.validation('Idempotency-Key header is required (1-200 chars).');
    const body = parseOrThrow(createSchema, request.body);

    const { task } = await opts.tasks.submit({ tenantId: ctx.tenantId, userId: ctx.userId, idempotencyKey: key, ...body });
    return reply.code(202).send({ data: task });
  });

  app.get('/tenants/:tenantId/tasks/:taskId', async (request) => {
    const auth = requireUser(request);
    const { tenantId, taskId } = request.params as { tenantId: string; taskId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'task:read');
    const row = await opts.tasks.get(ctx.tenantId, taskId);
    if (!row) throw errors.notFound('Task');
    return { data: toTask(row) };
  });

  app.post('/tenants/:tenantId/tasks/:taskId/cancel', async (request) => {
    const auth = requireUser(request);
    const { tenantId, taskId } = request.params as { tenantId: string; taskId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'task:cancel');
    const row = await opts.tasks.cancel(ctx.tenantId, ctx.userId, taskId);
    return { data: toTask(row) };
  });
}
