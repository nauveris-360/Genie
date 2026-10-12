import { createHash } from 'node:crypto';

/**
 * Canonical JSON (digest format v1, unchanged since the first release): every
 * object's keys are re-inserted in Array.prototype.sort order, recursively,
 * then serialized with JSON.stringify. Because JS objects enumerate
 * array-index keys ("0".."4294967294") first in ascending numeric order, the
 * emitted order is: array-index keys numerically, then all other keys in
 * UTF-16 code-unit order. Changing this ordering changes stored approval and
 * idempotency digests and would need an explicit, versioned migration.
 *
 * Object.fromEntries defines own data properties, so a JSON "__proto__" key is
 * kept as data rather than (as plain assignment would do) becoming the new
 * object's prototype and silently vanishing from the digest.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(Object.getOwnPropertyDescriptor(record, key)?.value)]));
  }
  return value;
}

/** SHA-256 hex of the canonical JSON form. Used to bind approvals and idempotency keys to an exact payload. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
