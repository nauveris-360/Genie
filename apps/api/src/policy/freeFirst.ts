import type { PoolClient } from 'pg';
import type { PricingStatus, ProviderName, VerificationSource } from '@genie/contracts';
import { loadConfig } from '../config.js';
import { errors } from '../lib/errors.js';

export interface ModelRow {
  provider: ProviderName;
  modelId: string;
  displayName: string;
  /** Stored pricing claim. Only meaningful when verificationSource is 'trusted'. */
  pricingStatus: PricingStatus;
  inputPrice: number | null;
  outputPrice: number | null;
  lastVerifiedAt: Date | null;
  verificationSource: VerificationSource;
}

/** Every kind of model call Genie can make. The policy applies identically to all of them - auxiliary calls are not exempt. */
export type CallKind = 'chat' | 'summarize' | 'embed' | 'title_generate' | 'auxiliary' | 'plugin';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface PolicyClock {
  now?: Date;
  maxAgeHours?: number;
}

/**
 * The pricing status Genie actually relies on. Fails closed:
 *  - a row not written by a trusted verification (e.g. a seeded placeholder)
 *    is 'unknown', whatever its stored pricing_status says;
 *  - a trusted row with no timestamp is 'unknown';
 *  - a trusted row older than MODEL_PRICING_MAX_AGE_HOURS is 'stale'.
 */
export function effectivePricingStatus(model: ModelRow, clock: PolicyClock = {}): PricingStatus {
  if (model.verificationSource !== 'trusted' || !model.lastVerifiedAt) return 'unknown';
  if (model.pricingStatus === 'unknown' || model.pricingStatus === 'stale') return model.pricingStatus;
  const now = clock.now ?? new Date();
  const maxAgeMs = (clock.maxAgeHours ?? loadConfig().modelPricingMaxAgeHours) * 3_600_000;
  if (now.getTime() - model.lastVerifiedAt.getTime() > maxAgeMs) return 'stale';
  return model.pricingStatus;
}

/**
 * Free-first rule, evaluated server-side on every model use:
 *  - effective verified_free with verified zero input AND output price -> allowed;
 *  - effective unknown or stale (including every unverified/seeded row) -> never
 *    allowed, not even with paid fallback, because the true cost is not known;
 *  - effective paid -> allowed only if the tenant explicitly turned on
 *    allowPaidFallback, which defaults to false and is never flipped
 *    automatically (e.g. on quota exhaustion);
 *  - the ":free" suffix in a model id carries no weight at all.
 */
export function evaluateModel(model: ModelRow | null, allowPaidFallback: boolean, kind: CallKind, clock: PolicyClock = {}): PolicyDecision {
  if (!model) return { allowed: false, reason: 'Model is not in the registry; unknown pricing is never allowed.' };
  if (model.verificationSource !== 'trusted') {
    return { allowed: false, reason: 'Model pricing has not been confirmed by a trusted verification (placeholder registry entry); it cannot be used.' };
  }
  const status = effectivePricingStatus(model, clock);
  if (status === 'unknown' || status === 'stale') {
    return { allowed: false, reason: `Model pricing is ${status}; it is not treated as free and cannot be used until re-verified.` };
  }
  if (status === 'verified_free') {
    if (model.inputPrice === 0 && model.outputPrice === 0) return { allowed: true, reason: `verified free (${kind})` };
    return { allowed: false, reason: 'Model is labelled free but its verified prices are not zero; it is not treated as free.' };
  }
  if (allowPaidFallback) return { allowed: true, reason: `paid fallback explicitly enabled by tenant (${kind})` };
  return { allowed: false, reason: 'Model is not on the verified free allowlist and paid fallback is disabled for this tenant.' };
}

interface DbModelRow {
  provider: ProviderName;
  model_id: string;
  display_name: string;
  pricing_status: PricingStatus;
  input_price_per_million_tokens_usd: string | null;
  output_price_per_million_tokens_usd: string | null;
  last_verified_at: Date | null;
  verification_source: VerificationSource;
}

function fromDb(r: DbModelRow): ModelRow {
  return {
    provider: r.provider,
    modelId: r.model_id,
    displayName: r.display_name,
    pricingStatus: r.pricing_status,
    inputPrice: r.input_price_per_million_tokens_usd === null ? null : Number(r.input_price_per_million_tokens_usd),
    outputPrice: r.output_price_per_million_tokens_usd === null ? null : Number(r.output_price_per_million_tokens_usd),
    lastVerifiedAt: r.last_verified_at,
    verificationSource: r.verification_source,
  };
}

export async function lookupModel(client: PoolClient, modelId: string): Promise<ModelRow | null> {
  const { rows } = await client.query<DbModelRow>('SELECT * FROM models WHERE model_id = $1', [modelId]);
  return rows[0] ? fromDb(rows[0]) : null;
}

export async function listModels(client: PoolClient): Promise<ModelRow[]> {
  const { rows } = await client.query<DbModelRow>('SELECT * FROM models ORDER BY provider, model_id');
  return rows.map(fromDb);
}

export interface TrustedVerification {
  provider: ProviderName;
  modelId: string;
  displayName: string;
  pricingStatus: PricingStatus;
  inputPrice: number | null;
  outputPrice: number | null;
}

/**
 * The only code path that may mark a model row as trusted. Intended for a
 * server-side pricing-verification job that reads live provider pricing; it is
 * not reachable from any HTTP endpoint. No such job exists yet, so in a real
 * deployment every model currently fails closed.
 */
export async function recordTrustedVerification(client: PoolClient, v: TrustedVerification): Promise<void> {
  await client.query(
    `INSERT INTO models (provider, model_id, display_name, pricing_status, input_price_per_million_tokens_usd,
                         output_price_per_million_tokens_usd, last_verified_at, verification_source)
     VALUES ($1, $2, $3, $4, $5, $6, now(), 'trusted')
     ON CONFLICT (provider, model_id) DO UPDATE SET
       display_name = EXCLUDED.display_name, pricing_status = EXCLUDED.pricing_status,
       input_price_per_million_tokens_usd = EXCLUDED.input_price_per_million_tokens_usd,
       output_price_per_million_tokens_usd = EXCLUDED.output_price_per_million_tokens_usd,
       last_verified_at = now(), verification_source = 'trusted', updated_at = now()`,
    [v.provider, v.modelId, v.displayName, v.pricingStatus, v.inputPrice, v.outputPrice],
  );
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
  const model = await lookupModel(client, modelId);
  const allowPaid = await loadAllowPaidFallback(client, tenantId);
  const decision = evaluateModel(model, allowPaid, kind);
  if (!decision.allowed || !model) throw errors.modelNotAllowed(decision.reason);
  return model;
}
