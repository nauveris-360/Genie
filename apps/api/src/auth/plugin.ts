import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';
import { withClient } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { checkTrustedOrigin } from './originCheck.js';
import { csrfHeaderMatchesSession, CSRF_HEADER, isStateChangingMethod } from './csrf.js';
import { resolveSession, type ResolvedSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: ResolvedSession | null;
    sessionToken: string | null;
  }
}

/**
 * State-changing routes that may be called without a session. The Origin
 * check still applies to them. /invitations/accept enforces the CSRF header
 * itself whenever the caller does have a session.
 */
const PUBLIC_WRITE_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/invitations/accept']);

/**
 * Request pipeline for every route:
 *  1. Resolve the opaque session cookie to a server-side session (or null).
 *  2. For POST/PUT/PATCH/DELETE: require a trusted Origin/Referer (login-CSRF
 *     defense; applies to the public routes too, which have no session yet).
 *  3. For POST/PUT/PATCH/DELETE other than the public routes: require a valid
 *     session AND an X-CSRF-Token header equal to that session's csrf_secret.
 * Handlers then call requireUser() and requireTenantPermission() themselves.
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  app.decorateRequest('auth', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (request) => {
    const raw = request.cookies[config.sessionCookieName];
    request.sessionToken = raw ?? null;
    request.auth = raw ? await withClient((client) => resolveSession(client, raw)) : null;
  });

  app.addHook('preHandler', async (request) => {
    if (!isStateChangingMethod(request.method)) return;

    const originVerdict = checkTrustedOrigin(request, config.allowedOrigins);
    if (!originVerdict.ok) throw errors.untrustedOrigin();

    if (request.routeOptions.url && PUBLIC_WRITE_ROUTES.has(request.routeOptions.url)) return;

    if (!request.auth) throw errors.unauthorized();
    if (!csrfHeaderMatchesSession(request.headers[CSRF_HEADER], request.auth.session.csrfSecret)) {
      throw errors.csrf();
    }
  });
}

// Opt out of Fastify's plugin encapsulation so the hooks above apply to every
// route in the app (including the /api/v1 child context), not only to routes
// registered inside this plugin. Same effect as wrapping with fastify-plugin.
(authPlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export function requireUser(request: FastifyRequest): ResolvedSession {
  if (!request.auth) throw errors.unauthorized();
  return request.auth;
}
