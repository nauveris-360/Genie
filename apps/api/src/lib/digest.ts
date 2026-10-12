import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively so semantically-equal payloads hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of the canonical JSON form. Used to bind approvals and idempotency keys to an exact payload. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
