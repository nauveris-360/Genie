import type { PoolClient } from 'pg';
import { scrubObject } from '../../lib/redaction.js';

export interface AuditInput {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** Appends an audit row inside the caller's tenant-scoped transaction. Metadata is scrubbed so a secret can never be persisted. */
export async function recordAudit(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.tenantId, input.actorUserId, input.action, input.targetType, input.targetId, JSON.stringify(scrubObject(input.metadata ?? {}))],
  );
}
