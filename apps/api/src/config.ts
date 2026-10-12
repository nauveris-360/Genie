import { parseAllowedOrigins } from './auth/originCheck.js';

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example and fill it in.`);
  }
  return value;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
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
  defaultAllowPaidFallback: boolean;
  hermesEnabled: boolean;
  hermesBaseUrl: string | undefined;
  hermesApiKey: string | undefined;
}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
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
    defaultAllowPaidFallback: bool(env.DEFAULT_ALLOW_PAID_FALLBACK, false),
    hermesEnabled: bool(env.HERMES_ENABLED, false),
    hermesBaseUrl: env.HERMES_BASE_URL || undefined,
    hermesApiKey: env.HERMES_API_KEY || undefined,
  };
  return cached;
}

/** Test-only: clears the cached config so a test can load a fresh env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
