import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Approval, ApprovalStatus } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { recordAudit } from '../auditEvents/write.js';
import { type AgentSnapshot, approvalDigest, type TaskRow, type TaskService } from '../tasks/service.js';

const STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
const decideSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(2000).optional() });

interface Row {
  id: string; tenant_id: string; task_id: string; action: string; payload_digest: string; digest_version: number; status: ApprovalStatus;
  decided_by: string | null; decided_at: Date | null; reason: string | null; expires_at: Date; created_at: Date;
}
const toApproval = (r: Row): Approval => ({
  id: r.id, tenantId: r.tenant_id, taskId: r.task_id, action: r.action, payloadDigest: r.payload_digest, digestVersion: r.digest_version as 1 | 2, status: r.status,
  decidedBy: r.decided_by, decidedAt: r.decided_at ? toIso(r.decided_at) : null, reason: r.reason,
  expiresAt: toIso(r.expires_at), createdAt: toIso(r.created_at),
});

export async function approvalRoutes(app: FastifyInstance, opts: { tasks: TaskService }): Promise<void> {
  app.get('/tenants/:tenantId/approvals', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'approval:read');
    const q = request.query as Record<string, string | undefined>;
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const status = q.status;
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw errors.validation('status is invalid.');

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT * FROM approvals WHERE tenant_id = $1 AND ($5::text IS NULL OR status = $5)
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [ctx.tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1, status ?? null],
      );
      return rows.map(toApproval);
    });
    const page = pageOf(rows, limit);
    return { data: page.data, page: { nextCursor: page.nextCursor } };
  });

  /**
   * Decisions are immutable and bound: the approval row is locked, must still
   * be pending, must not have expired, and the task's current bound payload
   * must still hash to the digest captured at creation. Any failure records
   * nothing except (for expiry) marking the row expired, so a stale approval
   * can never be replayed into executing a changed action.
   */
  app.post('/tenants/:tenantId/approvals/:approvalId/decision', async (request) => {
    const auth = requireUser(request);
    const { tenantId, approvalId } = request.params as { tenantId: string; approvalId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'approval:decide');
    const body = parseOrThrow(decideSchema, request.body);

    const outcome = await withTenant(ctx.tenantId, async (client) => {
      const cur = await client.query<Row>('SELECT * FROM approvals WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [approvalId, ctx.tenantId]);
      const approval = cur.rows[0];
      if (!approval) throw errors.notFound('Approval');
      if (approval.status !== 'pending') {
        throw approval.status === 'expired' ? errors.approvalExpired() : errors.approvalAlreadyDecided();
      }
      if (approval.expires_at.getTime() <= Date.now()) {
        // Mark + audit, then let the transaction COMMIT before the 409 is raised
        // (throwing here would roll the expiry marking back).
        await client.query(`UPDATE approvals SET status = 'expired' WHERE id = $1`, [approval.id]);
        await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'approval.expired', targetType: 'approval', targetId: approval.id });
        return { expired: true as const };
      }
      const taskRes = await client.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [approval.task_id, ctx.tenantId]);
      const task = taskRes.rows[0];
      if (!task) throw errors.notFound('Task');
      const agentRes = await client.query<AgentSnapshot>(
        'SELECT model_id, provider_connection_id, config FROM agents WHERE id = $1 AND tenant_id = $2',
        [task.agent_id, ctx.tenantId],
      );
      if (approvalDigest(approval.digest_version, task, agentRes.rows[0] ?? null) !== approval.payload_digest || task.status !== 'awaiting_approval') {
        throw errors.approvalPayloadMismatch();
      }

      const decided: ApprovalStatus = body.decision === 'approve' ? 'approved' : 'rejected';
      const upd = await client.query<Row>(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), reason = $4 WHERE id = $1 AND status = 'pending' RETURNING *`,
        [approval.id, decided, ctx.userId, body.reason ?? null],
      );
      const row = upd.rows[0];
      if (!row) throw errors.approvalAlreadyDecided();

      if (decided === 'approved') await opts.tasks.releaseApproved(client, ctx.tenantId, task.id);
      else await opts.tasks.markRejected(client, ctx.tenantId, task.id, body.reason ?? null);

      await recordAudit(client, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'approval.decided', targetType: 'approval', targetId: row.id, metadata: { decision: body.decision, taskId: task.id } });
      return { approval: toApproval(row), taskId: task.id, approved: decided === 'approved' };
    });

    if ('expired' in outcome) throw errors.approvalExpired();
    if (outcome.approved) await opts.tasks.run(ctx.tenantId, outcome.taskId);
    return { data: outcome.approval };
  });
}
