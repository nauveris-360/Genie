import type { PoolClient } from 'pg';
import type { PricingStatus, ProviderName } from '@genie/contracts';
import { errors } from '../lib/errors.js';

export interface ModelRow {
  provider: ProviderName;
  modelId: string;
  displayName: string;
  pricingStatus: PricingStatus;
  inputPrice: number | null;
  outputPrice: number | null;
  lastVerifiedAt: Date | null;
}

/** Every kind of model call Genie can make. The policy applies identically to all of them - auxiliary calls are not exempt. */
export type CallKind = 'chat' | 'summarize' | 'embed' | 'title_generate' | 'auxiliary' | 'plugin';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Free-first rule, evaluated server-side on every model use:
 *  - verified_free with zero verified input AND output price -> allowed.
 *  - anything else (paid, unknown, stale, or ":free" in the name without a
 *    verified zero price) -> allowed only if the tenant explicitly turned on
 *    allowPaidFallback, which defaults to false and is never flipped
 *    automatically (e.g. on quota exhaustion).
 *  - plugin calls are paid auxiliary calls by definition and follow the same rule.
 */
export function evaluateModel(model: ModelRow | null, allowPaidFallback: boolean, kind: CallKind): PolicyDecision {
  if (!model) {
    return allowPaidFallback
      ? { allowed: false, reason: 'Model is not in the registry; unknown pricing is never allowed, even with paid fallback.' }
      : { allowed: false, reason: 'Model is not in the registry and paid fallback is disabled for this tenant.' };
  }
  const isVerifiedFree = model.pricingStatus === 'verified_free' && model.inputPrice === 0 && model.outputPrice === 0;
  if (isVerifiedFree) return { allowed: true, reason: `verified free (${kind})` };

  if (model.pricingStatus === 'unknown' || model.pricingStatus === 'stale') {
    return { allowed: false, reason: `Model pricing is ${model.pricingStatus}; it is not treated as free and cannot be used until re-verified.` };
  }
  if (allowPaidFallback) return { allowed: true, reason: `paid fallback explicitly enabled by tenant (${kind})` };
  return { allowed: false, reason: 'Model is not on the verified free allowlist and paid fallback is disabled for this tenant.' };
}

export async function lookupModel(client: PoolClient, modelId: string): Promise<ModelRow | null> {
  const { rows } = await client.query<{
    provider: ProviderName;
    model_id: string;
    display_name: string;
    pricing_status: PricingStatus;
    input_price_per_million_tokens_usd: string | null;
    output_price_per_million_tokens_usd: string | null;
    last_verified_at: Date | null;
  }>('SELECT * FROM models WHERE model_id = $1', [modelId]);
  const r = rows[0];
  if (!r) return null;
  return {
    provider: r.provider,
    modelId: r.model_id,
    displayName: r.display_name,
    pricingStatus: r.pricing_status,
    inputPrice: r.input_price_per_million_tokens_usd === null ? null : Number(r.input_price_per_million_tokens_usd),
    outputPrice: r.output_price_per_million_tokens_usd === null ? null : Number(r.output_price_per_million_tokens_usd),
    lastVerifiedAt: r.last_verified_at,
  };
}

export async function listModels(client: PoolClient): Promise<ModelRow[]> {
  const { rows } = await client.query<{ model_id: string }>('SELECT model_id FROM models ORDER BY provider, model_id');
  const out: ModelRow[] = [];
  for (const row of rows) {
    const m = await lookupModel(client, row.model_id);
    if (m) out.push(m);
  }
  return out;
}

/** Reads the tenant policy inside a tenant-scoped transaction; absent row means the default (paid fallback OFF). */
export async function loadAllowPaidFallback(client: PoolClient, tenantId: string): Promise<boolean> {
  const { rows } = await client.query<{ allow_paid_fallback: boolean }>(
    'SELECT allow_paid_fallback FROM model_policies WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0]?.allow_paid_fallback ?? false;
}

/** Throws model_not_allowed unless the free-first rule permits this exact model for this tenant and call kind. */
export async function assertModelAllowed(client: PoolClient, tenantId: string, modelId: string, kind: CallKind): Promise<ModelRow> {
  const [model, allowPaid] = await Promise.all([lookupModel(client, modelId), loadAllowPaidFallback(client, tenantId)]);
  const decision = evaluateModel(model, allowPaid, kind);
  if (!decision.allowed || !model) throw errors.modelNotAllowed(decision.reason);
  return model;
}
