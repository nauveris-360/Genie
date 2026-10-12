import type { PoolClient } from 'pg';
import type { ProviderName, Task, TaskStatus, TaskType } from '@genie/contracts';
import { loadConfig } from '../../config.js';
import { withTenant } from '../../db/index.js';
import { AppError, errors } from '../../lib/errors.js';
import { payloadDigest } from '../../lib/digest.js';
import { scrubObject } from '../../lib/redaction.js';
import { toIso } from '../../lib/time.js';
import { decryptSecret } from '../../crypto/secretBox.js';
import { AdapterUnavailableError, type AgentAdapter } from '../../adapters/AgentAdapter.js';
import { assertModelAllowed } from '../../policy/freeFirst.js';
import { recordAudit } from '../auditEvents/write.js';
import type { AgentRow } from '../agents/routes.js';

export const APPROVAL_TTL_MINUTES = 60;
export const APPROVAL_ACTION = 'task.execute';

export interface TaskRow {
  id: string; tenant_id: string; website_id: string | null; agent_id: string; type: TaskType; status: TaskStatus;
  input: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; idempotency_key: string;
  request_payload_digest: string; approval_id: string | null; external_ref: string | null; created_by: string;
  created_at: Date; updated_at: Date;
}

export const toTask = (r: TaskRow): Task => ({
  id: r.id, tenantId: r.tenant_id, websiteId: r.website_id, agentId: r.agent_id, type: r.type, status: r.status,
  input: r.input, result: r.result ? scrubObject(r.result) : null, error: r.error, idempotencyKey: r.idempotency_key,
  approvalId: r.approval_id, createdBy: r.created_by, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
});

export interface SubmitInput {
  tenantId: string; userId: string; idempotencyKey: string;
  agentId: string; websiteId?: string; type: TaskType; input: Record<string, unknown>;
}

/** The exact bytes an approval is bound to: changing any of these invalidates a pending approval. */
export function boundPayload(task: Pick<TaskRow, 'tenant_id' | 'agent_id' | 'type' | 'input' | 'website_id'>) {
  return { tenantId: task.tenant_id, agentId: task.agent_id, type: task.type, input: task.input, websiteId: task.website_id };
}

export class TaskService {
  constructor(private readonly adapter: AgentAdapter) {}

  /**
   * Submit: idempotent per (tenant, key); same key + same payload returns the
   * original row, same key + different payload is a 409. Model policy is
   * enforced here regardless of what the agent was created with. Agents that
   * require approval park the task in awaiting_approval with a bound approval
   * row; otherwise the task is run immediately through the adapter.
   */
  async submit(input: SubmitInput): Promise<{ task: Task; created: boolean }> {
    const requestDigest = payloadDigest({ agentId: input.agentId, websiteId: input.websiteId ?? null, type: input.type, input: input.input });

    const outcome = await withTenant(input.tenantId, async (client) => {
      const existing = await client.query<TaskRow>('SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2', [input.tenantId, input.idempotencyKey]);
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_payload_digest !== requestDigest) throw errors.idempotencyConflict();
        return { row: prior, created: false, agent: null as AgentRow | null };
      }

      const agentRes = await client.query<AgentRow>('SELECT * FROM agents WHERE id = $1 AND tenant_id = $2', [input.agentId, input.tenantId]);
      const agent = agentRes.rows[0];
      if (!agent) throw errors.notFound('Agent');
      if (agent.status !== 'active') throw errors.validation('agent is disabled.');
      if (input.websiteId) {
        const site = await client.query('SELECT 1 FROM websites WHERE id = $1 AND tenant_id = $2', [input.websiteId, input.tenantId]);
        if (!site.rowCount) throw errors.notFound('Website');
      }
      await assertModelAllowed(client, input.tenantId, agent.model_id, input.type);

      const status: TaskStatus = agent.requires_approval ? 'awaiting_approval' : 'queued';
      const inserted = await client.query<TaskRow>(
        `INSERT INTO tasks (tenant_id, website_id, agent_id, type, status, input, idempotency_key, request_payload_digest, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
        [input.tenantId, input.websiteId ?? null, input.agentId, input.type, status, JSON.stringify(input.input), input.idempotencyKey, requestDigest, input.userId],
      );
      let row = inserted.rows[0]!;
      await recordAudit(client, { tenantId: input.tenantId, actorUserId: input.userId, action: 'task.submitted', targetType: 'task', targetId: row.id, metadata: { agentId: row.agent_id, type: row.type, status } });

      if (agent.requires_approval) {
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000);
        const approval = await client.query<{ id: string }>(
          `INSERT INTO approvals (tenant_id, task_id, action, payload_digest, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.tenantId, row.id, APPROVAL_ACTION, payloadDigest(boundPayload(row)), expiresAt],
        );
        const upd = await client.query<TaskRow>('UPDATE tasks SET approval_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, approval.rows[0]!.id]);
        row = upd.rows[0]!;
        await recordAudit(client, { tenantId: input.tenantId, actorUserId: input.userId, action: 'approval.requested', targetType: 'approval', targetId: row.approval_id!, metadata: { taskId: row.id, expiresAt: expiresAt.toISOString() } });
      }
      return { row, created: true, agent };
    });

    if (outcome.created && outcome.row.status === 'queued') {
      const row = await this.run(outcome.row.tenant_id, outcome.row.id);
      return { task: toTask(row), created: true };
    }
    return { task: toTask(outcome.row), created: outcome.created };
  }

  /**
   * Execute a queued task through the adapter. This is the only adapter
   * dispatch site, and it re-authorizes everything immediately before calling
   * out, because a task can sit in awaiting_approval for up to an hour while
   * the agent, its provider connection, the tenant policy or the model's
   * verified pricing change. In one transaction it:
   *  - claims queued -> running with a conditional UPDATE (two workers racing on
   *    the same task cannot both execute it);
   *  - reloads the CURRENT agent and provider connection, both scoped to the
   *    task's tenant (explicit predicates plus RLS);
   *  - refuses a disabled agent;
   *  - re-runs the free-first policy for the agent's current model and this
   *    task's call kind, against the tenant's current policy and the model's
   *    current verified pricing;
   *  - requires the model's registered provider to match the connection that
   *    will be used.
   * Any failure marks the task failed with a visible error and audit event, and
   * the adapter is never called. The values dispatched are exactly the ones
   * that were checked.
   */
  async run(tenantId: string, taskId: string): Promise<TaskRow> {
    const gate = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query<TaskRow>(
        `UPDATE tasks SET status = 'running', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'queued' RETURNING *`,
        [taskId, tenantId],
      );
      const row = rows[0];
      if (!row) return { kind: 'not_claimed' as const };

      const block = async (reason: string, metadata: Record<string, unknown>) => {
        const upd = await client.query<TaskRow>(
          `UPDATE tasks SET status = 'failed', error = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [row.id, tenantId, `Blocked before dispatch: ${reason}`],
        );
        await recordAudit(client, { tenantId, actorUserId: null, action: 'task.dispatch_blocked', targetType: 'task', targetId: row.id, metadata: { reason, type: row.type, ...metadata } });
        return { kind: 'blocked' as const, row: upd.rows[0]! };
      };

      const agentRes = await client.query<AgentRow & { provider: ProviderName | null; encrypted_credential: Buffer | null }>(
        `SELECT a.*, p.provider, p.encrypted_credential
         FROM agents a LEFT JOIN provider_connections p ON p.id = a.provider_connection_id AND p.tenant_id = $2
         WHERE a.id = $1 AND a.tenant_id = $2`,
        [row.agent_id, tenantId],
      );
      const agent = agentRes.rows[0];
      if (!agent) return block('agent not found in this tenant', { agentId: row.agent_id });
      if (!agent.provider || !agent.encrypted_credential) {
        return block('provider connection not found in this tenant', { agentId: agent.id, providerConnectionId: agent.provider_connection_id });
      }
      if (agent.status !== 'active') return block('agent is disabled', { agentId: agent.id });

      let model;
      try {
        model = await assertModelAllowed(client, tenantId, agent.model_id, row.type);
      } catch (err) {
        if (err instanceof AppError && err.code === 'model_not_allowed') {
          return block(`model_not_allowed: ${err.message}`, { agentId: agent.id, modelId: agent.model_id, provider: agent.provider });
        }
        throw err;
      }
      if (model.provider !== agent.provider) {
        return block(`model ${model.modelId} is registered for ${model.provider} but the agent's connection is ${agent.provider}`, {
          agentId: agent.id, modelId: model.modelId, modelProvider: model.provider, connectionProvider: agent.provider,
        });
      }
      return {
        kind: 'dispatch' as const,
        row,
        dispatch: { agentId: agent.id, modelId: model.modelId, provider: agent.provider, encryptedCredential: agent.encrypted_credential },
      };
    });

    if (gate.kind === 'not_claimed') {
      return (await this.get(tenantId, taskId)) ?? Promise.reject(errors.notFound('Task'));
    }
    if (gate.kind === 'blocked') return gate.row;

    const { row, dispatch } = gate;
    let finalStatus: TaskStatus; let result: Record<string, unknown> | null = null; let error: string | null = null; let externalRef: string | null = null;
    try {
      const credential = decryptSecret(dispatch.encryptedCredential, loadConfig().credentialEncryptionKey);
      const submitted = await this.adapter.submit({ taskId: row.id, tenantId, agentId: dispatch.agentId, type: row.type, modelId: dispatch.modelId, provider: dispatch.provider, credential, input: row.input });
      externalRef = submitted.externalRef;
      const status = await this.adapter.status(externalRef);
      if (status.state === 'succeeded') { finalStatus = 'succeeded'; result = scrubObject(status.result); }
      else if (status.state === 'failed') { finalStatus = 'failed'; error = status.error; }
      else if (status.state === 'cancelled') { finalStatus = 'cancelled'; }
      else { finalStatus = 'running'; }
    } catch (err) {
      finalStatus = 'failed';
      error = err instanceof AdapterUnavailableError ? err.message : 'adapter execution failed';
    }

    return withTenant(tenantId, async (client) => {
      // A cancellation recorded while the adapter was working wins over the adapter's outcome.
      const { rows } = await client.query<TaskRow>(
        `UPDATE tasks SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE $3 END,
           result = $4::jsonb, error = $5, external_ref = $6, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [taskId, tenantId, finalStatus, result ? JSON.stringify(result) : null, error, externalRef],
      );
      const updated = rows[0]!;
      await recordAudit(client, { tenantId, actorUserId: null, action: `task.${updated.status}`, targetType: 'task', targetId: updated.id, metadata: { adapter: this.adapter.name, error } });
      return updated;
    });
  }

  async get(tenantId: string, taskId: string): Promise<TaskRow | null> {
    return withTenant(tenantId, async (client) => {
      const { rows } = await client.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2', [taskId, tenantId]);
      return rows[0] ?? null;
    });
  }

  async cancel(tenantId: string, userId: string, taskId: string): Promise<TaskRow> {
    const result = await withTenant(tenantId, async (client) => {
      const current = await client.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [taskId, tenantId]);
      const row = current.rows[0];
      if (!row) throw errors.notFound('Task');
      if (row.status === 'cancelled') return { row, externalRef: null as string | null };
      if (row.status === 'succeeded' || row.status === 'failed') throw errors.taskNotCancellable(row.status);

      const { rows } = await client.query<TaskRow>(`UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [taskId]);
      if (row.approval_id) {
        await client.query(`UPDATE approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [row.approval_id]);
      }
      await recordAudit(client, { tenantId, actorUserId: userId, action: 'task.cancelled', targetType: 'task', targetId: taskId, metadata: { previousStatus: row.status } });
      return { row: rows[0]!, externalRef: row.external_ref };
    });
    if (result.externalRef) {
      await this.adapter.cancel(result.externalRef).catch(() => undefined);
    }
    return result.row;
  }

  /** Called by the approvals module after an approve decision has been recorded in the same transaction. */
  async releaseApproved(client: PoolClient, tenantId: string, taskId: string): Promise<void> {
    await client.query(`UPDATE tasks SET status = 'queued', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'awaiting_approval'`, [taskId, tenantId]);
  }

  async markRejected(client: PoolClient, tenantId: string, taskId: string, reason: string | null): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = 'cancelled', error = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'awaiting_approval'`,
      [taskId, tenantId, reason ? `rejected: ${reason}` : 'rejected'],
    );
  }
}
