import type { FastifyRequest } from 'fastify';

/**
 * Strict Origin/Referer validation for state-changing requests.
 *
 * This is the defense against login-CSRF: /auth/login has no session yet, so
 * the CSRF-token double-submit check cannot apply, but an attacker can still
 * cross-site-POST a victim's browser into logging in to an attacker-controlled
 * account. Browsers always attach an Origin header to cross-origin form POSTs
 * and fetch() calls and the attacker cannot forge or suppress it, so requiring
 * Origin (falling back to Referer's origin) to be on an explicit allowlist
 * blocks that class of attack regardless of session state. It is applied to
 * every POST/PUT/PATCH/DELETE, not only login, as defense in depth alongside
 * the CSRF token check.
 */
export type OriginVerdict = { ok: true } | { ok: false; reason: 'missing' | 'untrusted' | 'malformed' };

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

export function checkTrustedOrigin(request: FastifyRequest, allowedOrigins: ReadonlySet<string>): OriginVerdict {
  const originHeader = request.headers.origin;
  const refererHeader = request.headers.referer;

  let candidate: string | null = null;
  if (typeof originHeader === 'string' && originHeader !== '' && originHeader !== 'null') {
    candidate = originOf(originHeader);
    if (!candidate) return { ok: false, reason: 'malformed' };
  } else if (typeof refererHeader === 'string' && refererHeader !== '') {
    candidate = originOf(refererHeader);
    if (!candidate) return { ok: false, reason: 'malformed' };
  }

  if (!candidate) return { ok: false, reason: 'missing' };
  if (!allowedOrigins.has(candidate)) return { ok: false, reason: 'untrusted' };
  return { ok: true };
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const origin = originOf(trimmed);
    if (!origin) {
      throw new Error(`ALLOWED_ORIGINS entry "${trimmed}" is not a valid absolute origin (expected e.g. https://app.example.com).`);
    }
    set.add(origin);
  }
  return set;
}
