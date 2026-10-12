import type { FastifyInstance } from 'fastify';
import type { Model } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { toIso } from '../../lib/time.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { evaluateModel, listModels, loadAllowPaidFallback } from '../../policy/freeFirst.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/models', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'modelPolicy:read');

    const data = await withTenant(ctx.tenantId, async (client) => {
      const [models, allowPaid] = await Promise.all([listModels(client), loadAllowPaidFallback(client, ctx.tenantId)]);
      return models.map<Model>((m) => ({
        modelId: m.modelId,
        provider: m.provider,
        displayName: m.displayName,
        pricingStatus: m.pricingStatus,
        allowed: evaluateModel(m, allowPaid, 'chat').allowed,
        inputPricePerMillionTokensUsd: m.inputPrice,
        outputPricePerMillionTokensUsd: m.outputPrice,
        lastVerifiedAt: m.lastVerifiedAt ? toIso(m.lastVerifiedAt) : null,
        // No provider usage integration exists yet; null is honest. Never invent a remaining balance.
        usage: null,
      }));
    });
    return { data };
  });
}
