import { timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF check bound to the server-side session. The header value
 * must equal the csrf_secret stored on the session row (which is also what was
 * issued in the non-HttpOnly CSRF cookie at login). Comparing against the
 * stored server value rather than only the cookie means a forged/foreign CSRF
 * cookie cannot satisfy the check, and a constant-time comparison avoids
 * leaking the secret byte-by-byte through timing.
 */
export function csrfHeaderMatchesSession(headerValue: string | string[] | undefined, sessionCsrfSecret: string): boolean {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return false;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(sessionCsrfSecret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isStateChangingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
