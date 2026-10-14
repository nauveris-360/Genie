import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { getPool, closePool } from '../../src/db/index.js';
import { HermesApiAdapter } from '../../src/adapters/HermesApiAdapter.js';
import { HermesAdapter } from '../../src/adapters/HermesAdapter.js';
import { selectAdapter } from '../../src/adapters/index.js';
import { loadConfig, MASKED_ENV_VALUE, resetConfigForTests, withoutMaskedValues } from '../../src/config.js';
import { recordTrustedVerification } from '../../src/policy/freeFirst.js';
import { call, FREE_MODEL, freshDatabase, PAID_MODEL, seedWorkspace, startApp, stopApp, submitTask, type TestApp } from './helpers.js';

/**
 * The constrained Hermes adapter against a local stand-in for the Hermes API
 * server (the documented /v1/capabilities, /v1/toolsets and /v1/runs routes).
 * No real Hermes, provider or model is contacted; nothing is spent.
 */

const HERMES_KEY = 'hermes-test-key-0123456789abcdef';
const FREE_ID = FREE_MODEL.slice('openrouter/'.length);

interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }
interface FakeRun { status: string; output?: string; error?: string; runtime?: Record<string, unknown>; usage?: Record<string, unknown> }

const fake = {
  server: undefined as Server | undefined,
  url: '',
  requests: [] as Recorded[],
  runs: new Map<string, FakeRun>(),
  toolsets: [] as Array<Record<string, unknown>>,
  capabilities: {} as Record<string, unknown>,
  statusDown: false,
  redirectCapabilities: false,
  counter: 0,
  reset() {
    this.requests = []; this.runs.clear(); this.statusDown = false; this.redirectCapabilities = false;
    this.toolsets = [{ name: 'terminal', enabled: false, tools: ['terminal'] }, { name: 'web', enabled: false, tools: ['web_search'] }];
    this.capabilities = {
      object: 'hermes.api_server.capabilities', platform: 'hermes-agent', model: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      features: { chat_completions: true, responses_api: true, run_submission: true, run_status: true, run_events_sse: true, run_stop: true },
    };
  },
  runPosts() { return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/runs'); },
  statusGets() { return this.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/v1/runs/')); },
  stops() { return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/stop')); },
  lastRunId() { return [...this.runs.keys()].at(-1)!; },
  complete(runId: string, over: Partial<FakeRun> = {}) {
    this.runs.set(runId, {
      status: 'completed', output: 'Hello from the stand-in.',
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      runtime: { provider: 'openrouter', model: FREE_ID, route_source: 'raw_request' }, ...over,
    });
  },
};

async function startFake(): Promise<void> {
  fake.reset();
  fake.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      fake.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      const send = (code: number, json: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== `Bearer ${HERMES_KEY}`) return send(401, { error: { message: 'Invalid API key' } });
      if (req.method === 'GET' && path === '/v1/capabilities') {
        if (fake.redirectCapabilities) { res.writeHead(302, { location: `${fake.url}/elsewhere` }); return res.end(); }
        return send(200, fake.capabilities);
      }
      if (req.method === 'GET' && path === '/v1/toolsets') return send(200, fake.toolsets);
      if (req.method === 'POST' && path === '/v1/runs') {
        const runId = `run_${(++fake.counter).toString(16).padStart(8, '0')}`;
        fake.runs.set(runId, { status: 'running' });
        return send(202, { run_id: runId, status: 'started' });
      }
      const m = /^\/v1\/runs\/([^/]+)(\/stop)?$/.exec(path);
      if (m) {
        const run = fake.runs.get(m[1]!);
        if (!run) return send(404, { error: { message: 'not found' } });
        if (m[2] && req.method === 'POST') { run.status = 'cancelled'; return send(200, { run_id: m[1], status: 'stopping' }); }
        if (fake.statusDown) return send(503, { error: { message: 'down' } });
        return send(200, { object: 'hermes.run', run_id: m[1], ...run });
      }
      return send(404, { error: { message: 'no route' } });
    });
  });
  await new Promise<void>((r) => fake.server!.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(fake.server!.address() as AddressInfo).port}`;
}

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;
let A: Workspace; let B: Workspace; let A2: Workspace;
let t: TestApp & { app: FastifyInstance };
let hermes: HermesApiAdapter;

before(async () => {
  await freshDatabase();
  await startFake();
  // Seed through a mock-backed app; sessions live in the database, so they stay valid for the Hermes-backed app.
  const seeding = await startApp();
  A = await seedWorkspace(seeding, 'hermes-a');
  A2 = await seedWorkspace(seeding, 'hermes-a2', true);
  B = await seedWorkspace(seeding, 'hermes-b');
  await stopApp(seeding);
  // Bound to tenant A only. No availability cache so each test sees the stand-in's current state.
  hermes = new HermesApiAdapter({ baseUrl: fake.url, apiKey: HERMES_KEY, tenantId: A.tenantId, availabilityCacheMs: 0 });
  const app = await buildApp({ adapter: hermes, logger: false });
  await app.ready();
  t = { app, adapter: undefined } as unknown as TestApp & { app: FastifyInstance };
});
after(async () => {
  await t.app.close();
  await new Promise<void>((r) => fake.server!.close(() => r()));
  await closePool();
});
beforeEach(() => fake.reset());

const getTask = async (W: Workspace, id: string) => (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${id}`, { session: W.owner })).json().data;
const anyRequestContains = (needle: string) => fake.requests.some((r) => r.body.includes(needle) || JSON.stringify(r.headers).includes(needle));
async function withClient<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { return await fn(c); } finally { c.release(); }
}
const restoreFree = () => withClient((c) => recordTrustedVerification(c, { provider: 'openrouter', modelId: FREE_MODEL, displayName: 'Test verified free', pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0 }));

test('preflight: readiness is unavailable while Hermes has any toolset enabled, lacks auth, rejects the key or redirects', async () => {
  const ready = async () => { const r = await t.app.inject({ method: 'GET', url: '/api/v1/health/ready' }); return { code: r.statusCode, body: r.body, check: r.json().data.checks.agentAdapter }; };

  let r = await ready();
  assert.equal(r.code, 200, r.body);
  assert.equal(r.check.status, 'ok');
  assert.match(r.check.detail, /no toolsets enabled/);

  fake.toolsets[0]!.enabled = true;
  r = await ready();
  assert.equal(r.code, 503);
  assert.match(r.check.detail, /toolsets enabled.*terminal/);
  assert.doesNotMatch(r.check.detail, /web/, 'disabled toolsets are not listed');

  fake.reset();
  fake.toolsets.push({ name: 'mystery' }); // no explicit enabled:false -> treated as enabled
  assert.equal((await ready()).code, 503);

  fake.reset();
  fake.capabilities.auth = { type: 'bearer', required: false };
  r = await ready();
  assert.equal(r.code, 503);
  assert.match(r.check.detail, /does not require authentication/);

  fake.reset();
  (fake.capabilities.features as Record<string, boolean>).run_stop = false;
  assert.match((await ready()).check.detail, /does not offer run_stop/);

  fake.reset();
  fake.redirectCapabilities = true;
  r = await ready();
  assert.equal(r.code, 503, 'a redirect is never followed');
  assert.equal(fake.requests.filter((q) => q.path === '/elsewhere').length, 0, 'the key is not replayed to a redirect target');

  fake.reset();
  const wrongKey = new HermesApiAdapter({ baseUrl: fake.url, apiKey: 'wrong-key-0123456789abcdef', tenantId: A.tenantId, availabilityCacheMs: 0 });
  assert.deepEqual(await wrongKey.availability(), { available: false, detail: 'Hermes rejected the configured API key.' });

  const down = new HermesApiAdapter({ baseUrl: 'http://127.0.0.1:9', apiKey: HERMES_KEY, tenantId: A.tenantId, availabilityCacheMs: 0 });
  assert.deepEqual(await down.availability(), { available: false, detail: 'Hermes API server is unreachable.' });

  for (const detail of [r.check.detail, (await wrongKey.availability()).detail]) {
    assert.ok(!detail.includes(HERMES_KEY) && !detail.includes(fake.url), 'details never contain the key or the URL');
  }
});

test('dispatch: exactly one constrained run; tenant credential never leaves Genie; result settles on read', async () => {
  const res = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-ok', { prompt: 'Say hello' });
  assert.equal(res.statusCode, 202, res.body);
  const task = res.json().data;
  assert.equal(task.status, 'running', 'Hermes runs are asynchronous');

  const posts = fake.runPosts();
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0]!.body), { input: 'Say hello', model: FREE_ID, provider: 'openrouter' }, 'no session, history, instructions or tools are sent');
  assert.equal(posts[0]!.headers['idempotency-key'], `genie-task-${task.id}`);
  for (const h of ['x-hermes-session-id', 'x-hermes-session-key']) assert.equal(posts[0]!.headers[h], undefined);
  assert.equal(anyRequestContains(A.credential), false, "the tenant's provider credential is not forwarded to Hermes");
  assert.equal(JSON.stringify(task).includes(HERMES_KEY), false);

  // Still running on Hermes: reading does not change it.
  assert.equal((await getTask(A, task.id)).status, 'running');

  fake.complete(fake.lastRunId());
  const done = await getTask(A, task.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.text, 'Hello from the stand-in.');
  assert.deepEqual(done.result.servedBy, { adapter: 'hermes', provider: 'openrouter', model: FREE_ID });
  assert.deepEqual(done.result.usage, { reportedBy: 'hermes', unit: 'tokens', input: 12, output: 5, total: 17 }, 'reported usage survives redaction');

  const calls = fake.statusGets().length;
  await getTask(A, task.id);
  assert.equal(fake.statusGets().length, calls, 'a settled task is not polled again');

  const audit = (await call(t, 'GET', `/api/v1/tenants/${A.tenantId}/audit-events?limit=100`, { session: A.owner })).json().data;
  assert.ok(audit.some((e: { action: string; targetId: string; metadata: { adapter?: string } }) => e.action === 'task.succeeded' && e.targetId === task.id && e.metadata.adapter === 'hermes'));

  // The same Genie task can never start a second Hermes run.
  const again = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-ok', { prompt: 'Say hello' });
  assert.equal(again.json().data.id, task.id);
  assert.equal(fake.runPosts().length, 1);
});

test('tenant isolation: only the bound tenant reaches Hermes; other tenants cannot read, settle or stop its runs', async () => {
  const resB = await submitTask(t, B.owner, B.tenantId, B.agentId, 'h-b', { prompt: 'from B' });
  assert.equal(resB.statusCode, 202);
  assert.equal(resB.json().data.status, 'failed');
  assert.equal(resB.json().data.error, 'Hermes is not enabled for this tenant.');
  assert.equal(fake.requests.length, 0, "tenant B never causes any Hermes request, not even a preflight");

  const resA = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-iso', { prompt: 'from A' });
  const taskA = resA.json().data;
  fake.complete(fake.lastRunId());
  const before = fake.requests.length;

  for (const [m, url] of [['GET', `/api/v1/tenants/${B.tenantId}/tasks/${taskA.id}`], ['POST', `/api/v1/tenants/${B.tenantId}/tasks/${taskA.id}/cancel`]] as const) {
    assert.equal((await call(t, m, url, { session: B.owner })).statusCode, 404, `${m} ${url}`);
  }
  for (const [m, url] of [['GET', `/api/v1/tenants/${A.tenantId}/tasks/${taskA.id}`], ['POST', `/api/v1/tenants/${A.tenantId}/tasks/${taskA.id}/cancel`]] as const) {
    assert.equal((await call(t, m, url, { session: B.owner })).statusCode, 404, `B on A's URL: ${m}`);
  }
  assert.equal(fake.requests.length, before, "B's attempts never reach Hermes");
  assert.equal((await getTask(A, taskA.id)).status, 'succeeded', "A's own read settles it");
});

test('primary free-only: paid or unverified models never reach Hermes; a fallback-served run is discarded', async () => {
  const base = `/api/v1/tenants/${A.tenantId}`;
  // Paid model with paid fallback off: refused at the API before any Hermes call.
  await call(t, 'PUT', `${base}/model-policy`, { session: A.owner, payload: { allowPaidFallback: true } });
  assert.equal((await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { modelId: PAID_MODEL } })).statusCode, 200);
  await call(t, 'PUT', `${base}/model-policy`, { session: A.owner, payload: { allowPaidFallback: false } });
  const paid = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-paid', { prompt: 'x' });
  assert.equal(paid.statusCode, 409, paid.body);
  assert.equal(paid.json().error.code, 'model_not_allowed');
  assert.equal((await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { modelId: FREE_MODEL } })).statusCode, 200);

  // Free model whose verification has gone stale: refused.
  await getPool().query(`UPDATE models SET last_verified_at = now() - interval '100 hours' WHERE model_id = $1`, [FREE_MODEL]);
  const stale = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-stale', { prompt: 'x' });
  assert.equal(stale.statusCode, 409);
  await restoreFree();
  assert.equal(fake.runPosts().length, 0);

  // Hermes switched to a fallback provider/model: the output is discarded and the task fails visibly.
  const fb = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-fallback', { prompt: 'x' })).json().data;
  fake.complete(fake.lastRunId(), { runtime: { provider: 'anthropic', model: 'some-paid-model', route_source: 'global' }, output: 'SHOULD-NOT-APPEAR' });
  const fbDone = await getTask(A, fb.id);
  assert.equal(fbDone.status, 'failed');
  assert.equal(fbDone.result, null);
  assert.match(fbDone.error, /served the run with anthropic\/some-paid-model instead of openrouter\/test-verified-free:free; output discarded/);

  // No report of the serving model at all: also discarded.
  const nr = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-noruntime', { prompt: 'x' })).json().data;
  fake.complete(fake.lastRunId(), { runtime: undefined });
  const nrDone = await getTask(A, nr.id);
  assert.equal(nrDone.status, 'failed');
  assert.match(nrDone.error, /did not report which model served the run/);
  assert.equal(JSON.stringify(await getTask(A, fb.id)).includes('SHOULD-NOT-APPEAR'), false);
});

test('auxiliary free-only: summarize, embed and title_generate are never sent to Hermes, free or paid', async () => {
  for (const type of ['summarize', 'embed', 'title_generate']) {
    const res = await submitTask(t, A.owner, A.tenantId, A.agentId, `h-aux-${type}`, { prompt: 'x' }, type);
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().data.status, 'failed');
    assert.match(res.json().data.error, new RegExp(`tool-free chat only; ${type} tasks are not dispatched`));
  }
  const base = `/api/v1/tenants/${A.tenantId}`;
  await call(t, 'PUT', `${base}/model-policy`, { session: A.owner, payload: { allowPaidFallback: true } });
  await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { modelId: PAID_MODEL } });
  await call(t, 'PUT', `${base}/model-policy`, { session: A.owner, payload: { allowPaidFallback: false } });
  for (const type of ['summarize', 'embed', 'title_generate']) {
    const res = await submitTask(t, A.owner, A.tenantId, A.agentId, `h-aux-paid-${type}`, { prompt: 'x' }, type);
    assert.equal(res.statusCode, 409, `${type}: paid auxiliary call refused by policy`);
    assert.equal(res.json().error.code, 'model_not_allowed');
  }
  await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { modelId: FREE_MODEL } });
  // Chat input with extra fields (e.g. a smuggled tools/history field) is not forwarded either.
  const extra = await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-extra', { prompt: 'x', tools: ['terminal'] });
  assert.equal(extra.json().data.status, 'failed');
  assert.match(extra.json().data.error, /exactly \{ "prompt": "<text>" \}/);
  assert.equal(fake.runPosts().length, 0);
});

test('approval binding: no Hermes run until approved, none after an agent change or rejection, one per approval', async () => {
  const base = `/api/v1/tenants/${A2.tenantId}`;
  // Re-bind a second adapter to A2 (approval-requiring workspace) on its own app.
  const h2 = new HermesApiAdapter({ baseUrl: fake.url, apiKey: HERMES_KEY, tenantId: A2.tenantId, availabilityCacheMs: 0 });
  const app2 = await buildApp({ adapter: h2, logger: false });
  await app2.ready();
  const t2 = { app: app2 } as unknown as TestApp;
  try {
    const submit = async (key: string) => {
      const r = await submitTask(t2, A2.owner, A2.tenantId, A2.agentId, key, { prompt: key });
      assert.equal(r.json().data.status, 'awaiting_approval');
      return r.json().data as { id: string; approvalId: string };
    };
    const decide = (id: string, decision: 'approve' | 'reject') => call(t2, 'POST', `${base}/approvals/${id}/decision`, { session: A2.owner, payload: { decision } });

    const ok = await submit('h-ap-ok');
    const changed = await submit('h-ap-changed');
    const rejected = await submit('h-ap-rejected');
    assert.equal(fake.runPosts().length, 0, 'nothing is sent while awaiting approval');

    assert.equal((await decide(rejected.approvalId, 'reject')).statusCode, 200);
    assert.equal(fake.runPosts().length, 0);

    assert.equal((await decide(ok.approvalId, 'approve')).statusCode, 200);
    assert.equal(fake.runPosts().length, 1);
    assert.equal(fake.runPosts()[0]!.headers['idempotency-key'], `genie-task-${ok.id}`);
    assert.equal((await decide(ok.approvalId, 'approve')).statusCode, 409, 'an approval cannot be replayed');
    assert.equal(fake.runPosts().length, 1);

    // Material agent change after the request: the v2 digest no longer matches.
    assert.equal((await call(t2, 'PATCH', `${base}/agents/${A2.agentId}`, { session: A2.owner, payload: { config: { temperature: 0.9 } } })).statusCode, 200);
    const res = await decide(changed.approvalId, 'approve');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'approval_payload_mismatch');
    assert.equal(fake.runPosts().length, 1, 'no Hermes run for a changed agent');
    assert.equal((await call(t2, 'GET', `${base}/tasks/${changed.id}`, { session: A2.owner })).json().data.status, 'awaiting_approval');
  } finally {
    await app2.close();
  }
});

test('dispatch checks: disabled agent, stale pricing after approval, provider mismatch and tool requests all stop short of output', async () => {
  const base = `/api/v1/tenants/${A.tenantId}`;
  // Tasks waiting for a worker (as after an approval), created directly so setup sends nothing to Hermes.
  const { TaskService } = await import('../../src/modules/tasks/service.js');
  const svc = new TaskService(hermes);
  const queued = (key: string) => withClient(async (c) => {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tasks (tenant_id, agent_id, type, status, input, idempotency_key, request_payload_digest, created_by)
       VALUES ($1, $2, 'chat', 'queued', '{"prompt":"x"}', $3, 'test', $4) RETURNING id`, [A.tenantId, A.agentId, key, A.ownerId]);
    await c.query('COMMIT');
    return rows[0]!.id;
  });

  const disabledId = await queued('h-disabled');
  await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { status: 'disabled' } });
  const disabled = await svc.run(A.tenantId, disabledId);
  await call(t, 'PATCH', `${base}/agents/${A.agentId}`, { session: A.owner, payload: { status: 'active' } });
  assert.equal(disabled.status, 'failed');
  assert.match(disabled.error!, /^Blocked before dispatch: agent is disabled/);

  const staleId = await queued('h-stale-later');
  await getPool().query(`UPDATE models SET last_verified_at = now() - interval '100 hours' WHERE model_id = $1`, [FREE_MODEL]);
  const stale = await svc.run(A.tenantId, staleId);
  await restoreFree();
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!, /^Blocked before dispatch: model_not_allowed/);

  const otherId = await queued('h-other-tenant');
  await assert.rejects(svc.run(B.tenantId, otherId), (e: { code?: string }) => e.code === 'not_found');
  assert.equal(fake.requests.length, 0, 'none of these reached Hermes, not even a preflight');
  assert.equal((await getTask(A, otherId)).status, 'queued', "another tenant's worker context cannot claim the task");

  // Hermes parks a run waiting for a tool approval: Genie stops it and fails the task.
  const tool = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-tool', { prompt: 'run ls' })).json().data;
  fake.runs.set(fake.lastRunId(), { status: 'waiting_for_approval' });
  const toolDone = await getTask(A, tool.id);
  assert.equal(toolDone.status, 'failed');
  assert.match(toolDone.error, /asked to use a tool; tool use is not permitted/);
  assert.equal(fake.stops().length, 1);

  // A gemini model on a gemini connection passes Genie's policy elsewhere, but is never sent through Hermes.
  await assert.rejects(hermes.submit({ taskId: '00000000-0000-4000-8000-000000000000', tenantId: A.tenantId, agentId: A.agentId, type: 'chat', modelId: 'gemini/x', provider: 'gemini', credential: 'k', input: { prompt: 'x' } }), /OpenRouter models only/);
});

test('cancel stops the Hermes run and wins over a later completion; an unreachable Hermes leaves the task running', async () => {
  const task = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-cancel', { prompt: 'long' })).json().data;
  const runId = fake.lastRunId();
  const res = await call(t, 'POST', `/api/v1/tenants/${A.tenantId}/tasks/${task.id}/cancel`, { session: A.owner });
  assert.equal(res.json().data.status, 'cancelled');
  assert.equal(fake.stops().length, 1);
  assert.ok(fake.stops()[0]!.path.includes(runId));
  fake.complete(runId);
  assert.equal((await getTask(A, task.id)).status, 'cancelled');

  const t2 = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-down', { prompt: 'x' })).json().data;
  fake.statusDown = true;
  assert.equal((await getTask(A, t2.id)).status, 'running', 'a transient Hermes error does not fail the task');
  fake.statusDown = false;
  fake.complete(fake.lastRunId());
  assert.equal((await getTask(A, t2.id)).status, 'succeeded');
});

test('settings: masked or missing Hermes settings select the unavailable adapter and name the setting, never its value', async () => {
  const cfg = loadConfig();
  const masked = withoutMaskedValues({ HERMES_API_KEY: MASKED_ENV_VALUE, OTHER: 'kept' });
  assert.deepEqual(masked, { OTHER: 'kept' });

  const pick = (o: Partial<typeof cfg>) => selectAdapter({ ...cfg, hermesEnabled: true, hermesBaseUrl: fake.url, hermesApiKey: HERMES_KEY, hermesTenantId: A.tenantId, ...o });
  assert.ok(pick({}) instanceof HermesApiAdapter);
  assert.ok(selectAdapter({ ...cfg, hermesEnabled: false, hermesBaseUrl: fake.url, hermesApiKey: HERMES_KEY, hermesTenantId: A.tenantId }) instanceof HermesAdapter);

  const cases: Array<[Partial<typeof cfg>, RegExp]> = [
    [{ hermesApiKey: undefined }, /HERMES_API_KEY is not set/],
    [{ hermesApiKey: 'short' }, /HERMES_API_KEY must be at least 16 characters/],
    [{ hermesBaseUrl: 'http://user:pw@hermes:8642' }, /HERMES_BASE_URL must be an http\(s\) URL without credentials/],
    [{ hermesBaseUrl: 'ftp://hermes' }, /HERMES_BASE_URL must be/],
    [{ hermesTenantId: undefined }, /HERMES_TENANT_ID is not set/],
    [{ hermesTenantId: 'everyone' }, /HERMES_TENANT_ID must be a tenant UUID/],
  ];
  for (const [o, re] of cases) {
    const adapter = pick(o);
    assert.ok(adapter instanceof HermesAdapter, String(re));
    const a = await adapter.availability();
    assert.equal(a.available, false);
    assert.match(a.detail, re);
    assert.ok(!a.detail.includes('pw') && !a.detail.includes('short'), 'values are not echoed');
  }

  // Through loadConfig: a masked key behaves exactly like an unset one.
  resetConfigForTests();
  try {
    const c = loadConfig({ ...process.env, HERMES_ENABLED: 'true', HERMES_BASE_URL: fake.url, HERMES_API_KEY: MASKED_ENV_VALUE, HERMES_TENANT_ID: A.tenantId, TRUSTED_PROXIES: MASKED_ENV_VALUE });
    assert.equal(c.hermesApiKey, undefined);
    assert.deepEqual(c.trustedProxies, [], 'a masked optional setting takes its default');
    const a = await selectAdapter(c).availability();
    assert.match(a.detail, /HERMES_API_KEY is not set/);
    assert.ok(!a.detail.includes(MASKED_ENV_VALUE));
    resetConfigForTests();
    assert.throws(() => loadConfig({ ...process.env, CREDENTIAL_ENCRYPTION_KEY: MASKED_ENV_VALUE }), /Missing required environment variable CREDENTIAL_ENCRYPTION_KEY/);
  } finally {
    resetConfigForTests();
    loadConfig();
  }
});

test('a toolset enabled after a passing readiness check still blocks the next dispatch (fresh preflight per run)', async () => {
  const cachedAdapter = new HermesApiAdapter({ baseUrl: fake.url, apiKey: HERMES_KEY, tenantId: A.tenantId }); // default 30 s readiness cache
  assert.equal((await cachedAdapter.availability()).available, true);
  fake.toolsets[0]!.enabled = true;
  assert.equal((await cachedAdapter.availability()).available, true, 'readiness may serve its cached answer');
  await assert.rejects(
    cachedAdapter.submit({ taskId: '00000000-0000-4000-8000-000000000001', tenantId: A.tenantId, agentId: A.agentId, type: 'chat', modelId: FREE_MODEL, provider: 'openrouter', credential: A.credential, input: { prompt: 'x' } }),
    /toolsets enabled for its api_server platform \(terminal\)/,
  );
  assert.equal(fake.runPosts().length, 0);
  assert.equal((await cachedAdapter.availability()).available, false, 'the failed dispatch preflight also updates readiness');
});

test('a cancellation recorded while Hermes is being asked for the outcome wins over that outcome', async () => {
  const task = (await submitTask(t, A.owner, A.tenantId, A.agentId, 'h-race', { prompt: 'x' })).json().data;
  fake.complete(fake.lastRunId());
  const { TaskService } = await import('../../src/modules/tasks/service.js');
  const racing = Object.create(hermes) as HermesApiAdapter;
  racing.status = async (ref: string) => {
    await withClient(async (c) => {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await c.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [task.id]);
      await c.query('COMMIT');
    });
    return hermes.status(ref);
  };
  const row = await new TaskService(racing).refresh(A.tenantId, task.id);
  assert.equal(row?.status, 'cancelled');
  assert.equal(row?.result, null);
});

test('a cancellation recorded while the submission is in flight also stops the Hermes run', async () => {
  const { TaskService } = await import('../../src/modules/tasks/service.js');
  const id = await withClient(async (c) => {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tasks (tenant_id, agent_id, type, status, input, idempotency_key, request_payload_digest, created_by)
       VALUES ($1, $2, 'chat', 'queued', '{"prompt":"x"}', 'h-inflight', 'test', $3) RETURNING id`, [A.tenantId, A.agentId, A.ownerId]);
    await c.query('COMMIT');
    return rows[0]!.id;
  });
  const slow = Object.create(hermes) as HermesApiAdapter;
  slow.submit = async (s) => {
    const submitted = await hermes.submit(s);
    // The user cancels while Genie is still waiting for Hermes to accept the run.
    const res = await call(t, 'POST', `/api/v1/tenants/${A.tenantId}/tasks/${id}/cancel`, { session: A.owner });
    assert.equal(res.json().data.status, 'cancelled');
    return submitted;
  };
  const row = await new TaskService(slow).run(A.tenantId, id);
  assert.equal(row.status, 'cancelled');
  assert.equal(fake.runPosts().length, 1);
  assert.equal(fake.stops().length, 1, 'the run Hermes accepted is stopped');
  assert.equal(fake.runs.get(fake.lastRunId())!.status, 'cancelled');
});
