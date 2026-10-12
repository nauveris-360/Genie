import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Role } from '@genie/contracts';
import { buildApp } from '../../src/app.js';
import { closePool, getPool } from '../../src/db/index.js';
import { migrateUp } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/auth/password.js';
import { MockAdapter } from '../../src/adapters/MockAdapter.js';
import { loadConfig } from '../../src/config.js';

export const ORIGIN = 'http://localhost:5173';
export const FREE_MODEL = 'openrouter/some-model:free';
export const PAID_MODEL = 'openrouter/some-other-model';
export const UNKNOWN_MODEL = 'gemini/some-preview-model';

const TENANT_TABLES = ['audit_events', 'approvals', 'tasks', 'agents', 'provider_connections', 'model_policies', 'websites'];
const GLOBAL_TABLES = ['sessions', 'memberships', 'tenants', 'users'];

export interface TestApp {
  app: FastifyInstance & { adapter: MockAdapter };
  adapter: MockAdapter;
}

/** Migrates the test database from whatever state it is in, then wipes all data (schema and model seed stay). */
export async function freshDatabase(): Promise<void> {
  if (loadConfig().nodeEnv !== 'test') throw new Error('refusing to wipe a non-test database');
  const pool = getPool();
  await migrateUp(pool);
  await pool.query(`TRUNCATE ${[...TENANT_TABLES, ...GLOBAL_TABLES].join(', ')} CASCADE`);
}

export async function startApp(): Promise<TestApp> {
  const adapter = new MockAdapter();
  const app = (await buildApp({ adapter, logger: false })) as FastifyInstance & { adapter: MockAdapter };
  await app.ready();
  return { app, adapter };
}

export async function stopApp(t: TestApp): Promise<void> {
  await t.app.close();
}

export async function teardown(t?: TestApp): Promise<void> {
  if (t) await stopApp(t);
  await closePool();
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export async function createUser(email: string, password = 'correct-horse-battery-staple'): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, email.toLowerCase(), await hashPassword(password), email.split('@')[0]],
  );
  return rows[0]!.id;
}

export async function createTenant(name: string, ownerUserId: string): Promise<string> {
  const pool = getPool();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query<{ id: string }>('INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id', [name, slug]);
  const tenantId = rows[0]!.id;
  await addMember(tenantId, ownerUserId, 'owner');
  return tenantId;
}

export async function addMember(tenantId: string, userId: string, role: Role): Promise<void> {
  await getPool().query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenantId, userId, role]);
}

function cookieHeader(res: LightMyRequestResponse): { cookie: string; csrf: string } {
  const config = loadConfig();
  const sid = res.cookies.find((c) => c.name === config.sessionCookieName);
  const csrf = res.cookies.find((c) => c.name === config.csrfCookieName);
  if (!sid || !csrf) throw new Error('login did not set both cookies');
  return { cookie: `${sid.name}=${sid.value}; ${csrf.name}=${csrf.value}`, csrf: csrf.value };
}

export async function login(t: TestApp, email: string, password = 'correct-horse-battery-staple'): Promise<Session> {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const { cookie, csrf } = cookieHeader(res);
  return { cookie, csrf, userId: res.json().data.user.id };
}

export interface CallOptions {
  session?: Session | null;
  headers?: Record<string, string>;
  payload?: unknown;
  /** Set false to omit the CSRF header on a state-changing request. */
  csrf?: boolean;
  /** Override/omit the Origin header (null omits it). */
  origin?: string | null;
}

/** Issues a request the way the real frontend would: Origin, both cookies, and the CSRF header on writes. */
export async function call(t: TestApp, method: InjectOptions['method'], url: string, opts: CallOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    if (opts.csrf !== false && method !== 'GET') headers['x-csrf-token'] = opts.session.csrf;
  }
  return t.app.inject({ method, url, headers, payload: opts.payload as InjectOptions['payload'] });
}

/** Full fixture: owner + tenant + provider connection + verified-free agent (requiresApproval configurable). */
export async function seedWorkspace(t: TestApp, label: string, requiresApproval = false) {
  const ownerEmail = `${label}-owner@example.com`;
  const ownerId = await createUser(ownerEmail);
  const tenantId = await createTenant(`${label} Co`, ownerId);
  const owner = await login(t, ownerEmail);

  const provider = await call(t, 'POST', `/api/v1/tenants/${tenantId}/providers`, {
    session: owner, payload: { provider: 'openrouter', label: `${label} key`, credential: `sk-or-${label}-SECRET-VALUE` },
  });
  if (provider.statusCode !== 201) throw new Error(`provider: ${provider.body}`);
  const providerConnectionId = provider.json().data.id as string;

  const agent = await call(t, 'POST', `/api/v1/tenants/${tenantId}/agents`, {
    session: owner, payload: { name: `${label} agent`, providerConnectionId, modelId: FREE_MODEL, requiresApproval },
  });
  if (agent.statusCode !== 201) throw new Error(`agent: ${agent.body}`);

  return { ownerEmail, ownerId, owner, tenantId, providerConnectionId, agentId: agent.json().data.id as string, credential: `sk-or-${label}-SECRET-VALUE` };
}

export async function memberSession(t: TestApp, tenantId: string, role: Role, label: string): Promise<Session> {
  const email = `${label}-${role}@example.com`;
  const userId = await createUser(email);
  await addMember(tenantId, userId, role);
  return login(t, email);
}

export function submitTask(t: TestApp, session: Session, tenantId: string, agentId: string, key: string, input: Record<string, unknown> = { prompt: 'hello' }, type = 'chat') {
  return call(t, 'POST', `/api/v1/tenants/${tenantId}/tasks`, { session, headers: { 'idempotency-key': key }, payload: { agentId, type, input } });
}
