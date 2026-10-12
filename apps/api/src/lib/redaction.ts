/**
 * Redaction applied in two places:
 *  1. The pino logger config (REDACT_PATHS) so request/response logs never
 *     contain cookies, authorization headers, CSRF tokens or credential fields.
 *  2. Audit-event metadata and task results (scrubObject) so a credential or
 *     secret-looking field can never be persisted or returned by accident.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  '*.credential',
  '*.password',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.secret',
];

const SENSITIVE_KEY = /(credential|password|passwd|secret|token|api[-_]?key|authorization|cookie|private[-_]?key)/i;

/** Returns a deep copy of value with any sensitive-looking key replaced by "[redacted]". */
export function scrubObject<T>(value: T): T {
  return scrub(value, 0) as T;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > 20) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    // Object.fromEntries defines own data properties, so a "__proto__" key is
    // kept (and scrubbed) instead of becoming the result's prototype.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(v, depth + 1)]),
    );
  }
  return value;
}
