import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, FREE_MODEL, freshDatabase, PAID_MODEL, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';
import { recordTrustedVerification } from '../../src/policy/freeFirst.js';
import { TaskService } from '../../src/modules/tasks/service.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;
const dispatchedFor = (taskId: string) => t.adapter.submissions.filter((s) => s.taskId === taskId);

async function withClient<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { return await fn(c); } finally { c.release(); }
}
async function restoreFreeModel() {
  await withClient((c) => recordTrustedVerification(c, { provider: 'openrouter', modelId: FREE_MODEL, displayName: 'Test verified free', pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0 }));
}
async function pending(W: Workspace, key: string, type = 'chat', agentId = W.agentId) {
  const res = await submitTask(t, W.owner, W.tenantId, agentId, key, { prompt: key }, type);
  assert.equal(res.statusCode, 202, res.body);
  const task = res.json().data;
  assert.equal(task.status, 'awaiting_approval');
  return task as { id: string; approvalId: string };
}
async function approveAndExpectBlocked(W: Workspace, task: { id: string; approvalId: string }, reason: RegExp) {
  const res = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.status, 'approved', 'the human decision is still recorded');
  const after = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${task.id}`, { session: W.owner })).json().data;
  assert.equal(after.status, 'failed');
  assert.match(after.error, /^Blocked before dispatch: /);
  assert.match(after.error, reason);
  assert.equal(dispatchedFor(task.id).length, 0, 'no adapter dispatch');
  const audit = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/audit-events?limit=100`, { session: W.owner })).json().data;
  const ev = audit.find((e: { action: string; targetId: string }) => e.action === 'task.dispatch_blocked' && e.targetId === task.id);
  assert.ok(ev, 'blocked dispatch is audited');
  assert.match(String(ev.metadata.reason), reason);
  // a blocked task can never be picked up again
  const rerun = await new TaskService(t.adapter).run(W.tenantId, task.id);
  assert.equal(rerun.status, 'failed');
  assert.equal(dispatchedFor(task.id).length, 0);
}

test('control: an unchanged approved task is dispatched exactly once with the checked model', async () => {
  const W = await seedWorkspace(t, 'gate-ok', true);
  const task = await pending(W, 'ok-1');
  const res = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(res.statusCode, 200);
  const sent = dispatchedFor(task.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.modelId, FREE_MODEL); assert.equal(sent[0]!.provider, 'openrouter'); assert.equal(sent[0]!.tenantId, W.tenantId);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${task.id}`, { session: W.owner })).json().data.status, 'succeeded');
});

test('agent switched to a paid model after submission, fallback OFF at approval: blocked', async () => {
  const W = await seedWorkspace(t, 'gate-switch', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = await pending(W, 'sw-1');
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  assert.equal((await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: W.owner, payload: { modelId: PAID_MODEL } })).statusCode, 200);
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: false } });
  await approveAndExpectBlocked(W, task, /model_not_allowed: .*paid fallback is disabled/);
});

test('paid fallback turned OFF while a paid-model task waits for approval: blocked', async () => {
  const W = await seedWorkspace(t, 'gate-fallback', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  const paidAgent = (await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'paid', providerConnectionId: W.providerConnectionId, modelId: PAID_MODEL } })).json().data;
  const task = await pending(W, 'fb-1', 'chat', paidAgent.id);
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: false } });
  await approveAndExpectBlocked(W, task, /model_not_allowed/);
});

test('control: paid model with fallback still ON at approval is dispatched (gate does not over-block)', async () => {
  const W = await seedWorkspace(t, 'gate-paid-ok', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  const paidAgent = (await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'paid', providerConnectionId: W.providerConnectionId, modelId: PAID_MODEL } })).json().data;
  const task = await pending(W, 'po-1', 'chat', paidAgent.id);
  await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(dispatchedFor(task.id).length, 1);
  assert.equal(dispatchedFor(task.id)[0]!.modelId, PAID_MODEL);
});

test('pricing verification goes stale while waiting: blocked for every call kind', async () => {
  const W = await seedWorkspace(t, 'gate-stale', true);
  const tasks = [];
  for (const type of ['chat', 'summarize', 'embed', 'title_generate']) tasks.push(await pending(W, `st-${type}`, type));
  await getPool().query(`UPDATE models SET last_verified_at = now() - interval '73 hours' WHERE model_id = $1`, [FREE_MODEL]);
  try {
    for (const task of tasks) await approveAndExpectBlocked(W, task, /model_not_allowed: .*stale/);
  } finally { await restoreFreeModel(); }
});

test('provider starts charging (re-verified as paid) while waiting: blocked', async () => {
  const W = await seedWorkspace(t, 'gate-reprice', true);
  const task = await pending(W, 'rp-1');
  await withClient((c) => recordTrustedVerification(c, { provider: 'openrouter', modelId: FREE_MODEL, displayName: 'now paid', pricingStatus: 'paid', inputPrice: 1, outputPrice: 2 }));
  try { await approveAndExpectBlocked(W, task, /model_not_allowed/); } finally { await restoreFreeModel(); }
});

test('verification revoked to an untrusted placeholder while waiting: blocked', async () => {
  const W = await seedWorkspace(t, 'gate-revoke', true);
  const task = await pending(W, 'rv-1');
  await getPool().query(`UPDATE models SET verification_source = 'seed' WHERE model_id = $1`, [FREE_MODEL]);
  try { await approveAndExpectBlocked(W, task, /model_not_allowed: .*trusted verification/); } finally { await restoreFreeModel(); }
});

test('agent disabled while waiting: blocked', async () => {
  const W = await seedWorkspace(t, 'gate-disabled', true);
  const task = await pending(W, 'ds-1');
  assert.equal((await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { status: 'disabled' } })).statusCode, 200);
  await approveAndExpectBlocked(W, task, /agent is disabled/);
});

test("agent moved to a connection for a different provider than the model's: blocked", async () => {
  const W = await seedWorkspace(t, 'gate-provider', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = await pending(W, 'pv-1');
  const gemini = (await call(t, 'POST', `${base}/providers`, { session: W.owner, payload: { provider: 'gemini', label: 'g', credential: 'gemini-test-SECRET' } })).json().data;
  assert.equal((await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: W.owner, payload: { providerConnectionId: gemini.id } })).statusCode, 200);
  await approveAndExpectBlocked(W, task, /registered for openrouter but the agent's connection is gemini/);
});

test('run() under another tenant cannot claim, dispatch or alter the task', async () => {
  const A = await seedWorkspace(t, 'gate-tenant-a', true);
  const B = await seedWorkspace(t, 'gate-tenant-b', true);
  const task = await pending(A, 'tn-1');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    await client.query(`UPDATE tasks SET status = 'queued' WHERE id = $1`, [task.id]);
    await client.query('COMMIT');
  } finally { client.release(); }

  const service = new TaskService(t.adapter);
  await assert.rejects(service.run(B.tenantId, task.id), (e: { code?: string }) => e.code === 'not_found');
  assert.equal(dispatchedFor(task.id).length, 0);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${A.tenantId}/tasks/${task.id}`, { session: A.owner })).json().data.status, 'queued');

  const ran = await service.run(A.tenantId, task.id);
  assert.equal(ran.status, 'succeeded');
  assert.equal(dispatchedFor(task.id).length, 1);
  assert.equal(dispatchedFor(task.id)[0]!.tenantId, A.tenantId);
  assert.equal(dispatchedFor(task.id)[0]!.credential, A.credential, "dispatched with the task tenant's own credential");
});
