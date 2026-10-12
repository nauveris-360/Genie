import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProviderConnection, ProviderName } from '@genie/contracts';
import { loadConfig } from '../../config.js';
import { withTenant } from '../../db/index.js';
import { parseOrThrow } from '../../lib/validate.js';
import { toIso } from '../../lib/time.js';
import { encryptSecret } from '../../crypto/secretBox.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { recordAudit } from '../auditEvents/write.js';

const saveSchema = z.object({
  provider: z.enum(['openrouter', 'gemini']),
  label: z.string().min(1).max(200),
  credential: z.string().min(1).max(4096),
});

interface Row { id: string; tenant_id: string; provider: ProviderName; label: string; created_at: Date; updated_at: Date }

/** Metadata only. The encrypted_credential column is never selected into a response path. */
const toConnection = (r: Row): ProviderConnection => ({
  id: r.id, tenantId: r.tenant_id, provider: r.provider, label: r.label, credentialStatus: 'present',
  createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
});

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  app.get('/tenants/:tenantId/providers', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'provider:read');
    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        'SELECT id, tenant_id, provider, label, created_at, updated_at FROM provider_connections WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
        [ctx.tenantId],
      );
      return rows.map(toConnection);
    });
    return { data: rows, page: { nextCursor: null } };
  });

  app.post('/tenants/:tenantId/providers', async (request, reply) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'provider:write');
    const body = parseOrThrow(saveSchema, request.body);
    const encrypted = encryptSecret(body.credential, config.credentialEncryptionKey);

    const connection = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `INSERT INTO provider_connections (tenant_id, provider, label, encrypted_credential)
         VALUES ($1, $2, $3, $4) RETURNING id, tenant_id, provider, label, created_at, updated_at`,
        [ctx.tenantId, body.provider, body.label, encrypted],
      );
      const row = rows[0]!;
      await recordAudit(client, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'provider.credential_saved', targetType: 'provider_connection', targetId: row.id,
        metadata: { provider: row.provider, label: row.label, credentialStatus: 'present' },
      });
      return toConnection(row);
    });
    return reply.code(201).send({ data: connection });
  });
}
