import type { FastifyInstance } from 'fastify';
import type { Model } from '@genie/contracts';
import { withTenant } from '../../db/index.js';
import { toIso } from '../../lib/time.js';
import { requireUser } from '../../auth/plugin.js';
import { requireTenantPermission } from '../../auth/rbac.js';
import { effectivePricingStatus, evaluateModel, listModels, loadAllowPaidFallback } from '../../policy/freeFirst.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/models', async (request) => {
    const auth = requireUser(request);
    const { tenantId } = request.params as { tenantId: string };
    const ctx = await requireTenantPermission(auth.user.id, tenantId, 'modelPolicy:read');

    const data = await withTenant(ctx.tenantId, async (client) => {
      const models = await listModels(client);
      const allowPaid = await loadAllowPaidFallback(client, ctx.tenantId);
      const now = new Date();
      return models.map<Model>((m) => {
        const trusted = m.verificationSource === 'trusted';
        return {
          modelId: m.modelId,
          provider: m.provider,
          displayName: m.displayName,
          pricingStatus: effectivePricingStatus(m, { now }),
          verificationSource: m.verificationSource,
          allowed: evaluateModel(m, allowPaid, 'chat', { now }).allowed,
          // Unverified prices are placeholders; never present them as facts.
          inputPricePerMillionTokensUsd: trusted ? m.inputPrice : null,
          outputPricePerMillionTokensUsd: trusted ? m.outputPrice : null,
          lastVerifiedAt: trusted && m.lastVerifiedAt ? toIso(m.lastVerifiedAt) : null,
          // No provider usage integration exists yet; null is honest. Never invent a remaining balance.
          usage: null,
        };
      });
    });
    return { data };
  });
}
