import { isIP } from 'node:net';
import { parseAllowedOrigins } from './auth/originCheck.js';

/**
 * Value the deployment uses to mask a key that a container must not receive.
 * Coolify 4.4.6 injects the whole stack .env into every container, inherits
 * values for null entries and overwrites empty strings from saved values, so an
 * unneeded secret is set to this sentinel instead of being left blank. Genie
 * treats it exactly like an unset variable: a required setting then fails with
 * "missing", an optional one takes its default, and the sentinel itself is
 * never used as a key, URL or address.
 */
export const MASKED_ENV_VALUE = '__GENIE_NOT_AVAILABLE__';

/**
 * Returns a copy of env without masked values. A value that merely CONTAINS the
 * sentinel counts as masked too, e.g. a connection string assembled from a
 * masked password (postgres://genie_app:__GENIE_NOT_AVAILABLE__@db/genie): no
 * real setting ever contains it, and using it would only fail later and less
 * clearly (or, for a password, make the sentinel the password).
 */
export function withoutMaskedValues(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => !v?.includes(MASKED_ENV_VALUE)));
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name} (unset, empty or masked as ${MASKED_ENV_VALUE}). Copy .env.example and fill it in.`);
  }
  return value;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer.`);
  return n;
}

/**
 * Proxies whose X-Forwarded-For we believe. Empty (the default) means none:
 * the client IP is the TCP peer address and forwarded headers are ignored, so
 * a client cannot pick its own rate-limit bucket by sending X-Forwarded-For.
 * Entries are exact IPs or CIDR ranges of the reverse proxy in front of the API.
 */
function parseTrustedProxies(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [addr, bits, extra] = entry.split('/');
    const family = isIP(addr ?? '');
    const max = family === 4 ? 32 : 128;
    const validBits = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= max);
    if (!family || !validBits || extra !== undefined) {
      throw new Error(`TRUSTED_PROXIES entry "${entry}" is not an IP address or CIDR range.`);
    }
    out.push(entry);
  }
  return out;
}

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolMax: number;
  sessionCookieName: string;
  sessionCookieSecret: string;
  sessionTtlMinutes: number;
  csrfCookieName: string;
  credentialEncryptionKey: string;
  /** Absolute origins allowed to make state-changing requests (login-CSRF defense). */
  allowedOrigins: Set<string>;
  trustedProxies: string[];
  loginRateLimitWindowSeconds: number;
  loginMaxFailuresPerIp: number;
  loginMaxFailuresPerIpAccount: number;
  /** Run migrations at startup (true) or require a separate migration job to have done so (false). */
  migrateOnBoot: boolean;
  /** A trusted price verification older than this is treated as stale and fails closed. */
  modelPricingMaxAgeHours: number;
  defaultAllowPaidFallback: boolean;
  hermesEnabled: boolean;
  hermesBaseUrl: string | undefined;
  hermesApiKey: string | undefined;
  /** The one tenant allowed to dispatch through Hermes (Hermes runs on the platform's own provider credential). */
  hermesTenantId: string | undefined;
}

let cached: Config | undefined;

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const env = withoutMaskedValues(rawEnv);
  cached = {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    databaseSsl: bool(env.DATABASE_SSL, false),
    databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 10),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? 'genie_sid',
    sessionCookieSecret: required('SESSION_COOKIE_SECRET', env.SESSION_COOKIE_SECRET),
    sessionTtlMinutes: Number(env.SESSION_TTL_MINUTES ?? 720),
    csrfCookieName: env.CSRF_COOKIE_NAME ?? 'genie_csrf',
    credentialEncryptionKey: required('CREDENTIAL_ENCRYPTION_KEY', env.CREDENTIAL_ENCRYPTION_KEY),
    allowedOrigins: parseAllowedOrigins(required('ALLOWED_ORIGINS', env.ALLOWED_ORIGINS)),
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES),
    loginRateLimitWindowSeconds: positiveInt('LOGIN_RATE_LIMIT_WINDOW_SECONDS', env.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 900),
    loginMaxFailuresPerIp: positiveInt('LOGIN_MAX_FAILURES_PER_IP', env.LOGIN_MAX_FAILURES_PER_IP, 20),
    loginMaxFailuresPerIpAccount: positiveInt('LOGIN_MAX_FAILURES_PER_IP_ACCOUNT', env.LOGIN_MAX_FAILURES_PER_IP_ACCOUNT, 5),
    migrateOnBoot: bool(env.MIGRATE_ON_BOOT, true),
    modelPricingMaxAgeHours: positiveInt('MODEL_PRICING_MAX_AGE_HOURS', env.MODEL_PRICING_MAX_AGE_HOURS, 72),
    defaultAllowPaidFallback: bool(env.DEFAULT_ALLOW_PAID_FALLBACK, false),
    hermesEnabled: bool(env.HERMES_ENABLED, false),
    hermesBaseUrl: env.HERMES_BASE_URL || undefined,
    hermesApiKey: env.HERMES_API_KEY || undefined,
    hermesTenantId: env.HERMES_TENANT_ID?.trim() || undefined,
  };
  return cached;
}

/** Test-only: clears the cached config so a test can load a fresh env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
