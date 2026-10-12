import type { PoolClient } from 'pg';
import type { PricingStatus } from '@genie/contracts';
import { recordTrustedVerification } from './freeFirst.js';

/**
 * Pricing verification for OpenRouter models, from OpenRouter's free, public,
 * unauthenticated model list (GET /api/v1/models). No API key is ever sent and
 * no model is ever invoked, so the sync itself costs nothing.
 *
 * Only models on the reviewed allowlist (config/approved-models.json) are
 * verified: being zero-priced is necessary but not sufficient, a model must
 * also have been explicitly approved. Classification fails closed: anything
 * missing, malformed, negative (OpenRouter uses -1 for variable pricing) or
 * unrecognised is 'unknown', and any non-zero cost dimension of any kind
 * (prompt, completion, per-request, image, web search, reasoning, cache, ...)
 * makes the model 'paid'.
 */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const REGISTRY_PREFIX = 'openrouter/';
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface ApprovedModel {
  /** OpenRouter's own model id, e.g. "vendor/model:free". Stored in the registry as "openrouter/<id>". */
  openRouterId: string;
  displayName?: string;
}

export interface Classification {
  pricingStatus: Extract<PricingStatus, 'verified_free' | 'paid' | 'unknown'>;
  inputPrice: number | null;
  outputPrice: number | null;
  reason: string;
}

function parseCost(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** USD per token -> USD per million tokens, without float noise like 2.9999999999999996. */
function perMillion(perToken: number): number {
  return Math.round(perToken * 1e6 * 1e9) / 1e9;
}

export function classifyPricing(pricing: unknown): Classification {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    return { pricingStatus: 'unknown', inputPrice: null, outputPrice: null, reason: 'pricing object missing' };
  }
  const entries = Object.entries(pricing as Record<string, unknown>);
  const costs = new Map<string, number>();
  for (const [dimension, raw] of entries) {
    const cost = parseCost(raw);
    if (cost === null) {
      return { pricingStatus: 'unknown', inputPrice: null, outputPrice: null, reason: `pricing.${dimension} is not a non-negative number (${JSON.stringify(raw)})` };
    }
    costs.set(dimension, cost);
  }
  const prompt = costs.get('prompt');
  const completion = costs.get('completion');
  if (prompt === undefined || completion === undefined) {
    return { pricingStatus: 'unknown', inputPrice: null, outputPrice: null, reason: 'pricing.prompt or pricing.completion missing' };
  }
  const inputPrice = perMillion(prompt);
  const outputPrice = perMillion(completion);
  const charged = [...costs].filter(([, c]) => c > 0).map(([d]) => d);
  if (charged.length) return { pricingStatus: 'paid', inputPrice, outputPrice, reason: `charges for: ${charged.join(', ')}` };
  return { pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0, reason: `all ${costs.size} pricing dimensions are zero` };
}

interface FeedModel { id: string; name?: string; pricing?: unknown }

/** Fetches and shape-checks the public feed. Throws (writing nothing) on any transport or shape problem. */
export async function fetchOpenRouterModels(fetchImpl: typeof fetch = fetch, url = OPENROUTER_MODELS_URL): Promise<Map<string, FeedModel>> {
  const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!res.ok) throw new Error(`OpenRouter model list returned HTTP ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('OpenRouter model list exceeds the size limit');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error('OpenRouter model list is not valid JSON'); }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('OpenRouter model list has no data array');
  const out = new Map<string, FeedModel>();
  for (const item of data) {
    if (item && typeof item === 'object' && typeof (item as FeedModel).id === 'string') out.set((item as FeedModel).id, item as FeedModel);
  }
  if (out.size === 0) throw new Error('OpenRouter model list contained no models');
  return out;
}

export interface SyncResult {
  modelId: string;
  pricingStatus: Classification['pricingStatus'];
  inputPrice: number | null;
  outputPrice: number | null;
  reason: string;
  action: 'verified' | 'not_in_feed' | 'no_longer_approved';
}

/**
 * Computes the verification outcome for every approved model, plus every
 * previously trusted OpenRouter row that is no longer approved (demoted to
 * 'unknown' so it fails closed immediately). With dryRun it writes nothing.
 * Writes happen in one transaction: all or nothing.
 */
export async function syncOpenRouterPricing(
  client: PoolClient,
  approved: ApprovedModel[],
  feed: Map<string, FeedModel>,
  { dryRun }: { dryRun: boolean },
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const approvedIds = new Set<string>();
  for (const a of approved) {
    const modelId = `${REGISTRY_PREFIX}${a.openRouterId}`;
    approvedIds.add(modelId);
    const entry = feed.get(a.openRouterId);
    if (!entry) {
      results.push({ modelId, pricingStatus: 'unknown', inputPrice: null, outputPrice: null, reason: 'not present in the provider feed', action: 'not_in_feed' });
      continue;
    }
    const c = classifyPricing(entry.pricing);
    results.push({ modelId, ...c, action: 'verified' });
  }

  const { rows } = await client.query<{ model_id: string }>(
    `SELECT model_id FROM models WHERE provider = 'openrouter' AND verification_source = 'trusted'`,
  );
  for (const r of rows) {
    if (!approvedIds.has(r.model_id)) {
      results.push({ modelId: r.model_id, pricingStatus: 'unknown', inputPrice: null, outputPrice: null, reason: 'no longer on the approved list', action: 'no_longer_approved' });
    }
  }

  if (dryRun) return results;
  const names = new Map(approved.map((a) => [`${REGISTRY_PREFIX}${a.openRouterId}`, a.displayName]));
  await client.query('BEGIN');
  try {
    for (const r of results) {
      const feedName = feed.get(r.modelId.slice(REGISTRY_PREFIX.length))?.name;
      await recordTrustedVerification(client, {
        provider: 'openrouter',
        modelId: r.modelId,
        displayName: names.get(r.modelId) ?? (typeof feedName === 'string' ? feedName : r.modelId),
        pricingStatus: r.pricingStatus,
        inputPrice: r.inputPrice,
        outputPrice: r.outputPrice,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return results;
}

export function parseApprovedModels(json: unknown): ApprovedModel[] {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { openrouter?: unknown }).openrouter)) {
    throw new Error('approved-models.json must be an object with an "openrouter" array');
  }
  const out: ApprovedModel[] = [];
  const seen = new Set<string>();
  for (const item of (json as { openrouter: unknown[] }).openrouter) {
    const id = (item as ApprovedModel)?.openRouterId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._~:/-]{1,200}$/.test(id) || id.startsWith(REGISTRY_PREFIX)) {
      throw new Error(`approved-models.json: invalid openRouterId ${JSON.stringify(id)} (use OpenRouter's id, without the "openrouter/" prefix)`);
    }
    if (seen.has(id)) throw new Error(`approved-models.json: duplicate openRouterId ${id}`);
    seen.add(id);
    const displayName = (item as ApprovedModel).displayName;
    out.push(typeof displayName === 'string' ? { openRouterId: id, displayName } : { openRouterId: id });
  }
  return out;
}
