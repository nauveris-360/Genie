import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, FREE_MODEL, freshDatabase, seedWorkspace, startApp, stopApp, submitTask, teardown, type TestApp } from './helpers.js';
import { closePool, getPool } from '../../src/db/index.js';
import { HermesAdapter } from '../../src/adapters/HermesAdapter.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

test('202 returns the persisted record; repeated idempotency key creates exactly one task', async () => {
  const W = await seedWorkspace(t, 'idem');
  const first = await submitTask(t, W.owner, W.tenantId, W.agentId, 'key-1', { prompt: 'draft reply' });
  assert.equal(first.statusCode, 202);
  const task = first.json().data;
  assert.match(task.id, /^[0-9a-f-]{36}$/);
  assert.equal(task.idempotencyKey, 'key-1');
  assert.equal(task.status, 'succeeded');
  assert.equal(task.result.text, `[mock:${FREE_MODEL}] draft reply`);
  assert.match(task.createdAt, /Z$/);

  const again = await submitTask(t, W.owner, W.tenantId, W.agentId, 'key-1', { prompt: 'draft reply' });
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().data.id, task.id);
  const parallel = await Promise.all([1, 2, 3].map(() => submitTask(t, W.owner, W.tenantId, W.agentId, 'key-par', { prompt: 'p' })));
  const ids = new Set(parallel.filter((r) => r.statusCode === 202).map((r) => r.json().data.id));
  assert.equal(ids.size, 1, 'concurrent duplicates must collapse to one task');
  assert.ok(parallel.every((r) => r.statusCode === 202 || r.statusCode === 409), parallel.map((r) => r.statusCode).join());

  const list = await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks`, { session: W.owner });
  assert.equal(list.json().data.filter((x: { idempotencyKey: string }) => x.idempotencyKey === 'key-1').length, 1);
  assert.equal(t.adapter.submissions.filter((s) => s.input.prompt === 'draft reply').length, 1, 'adapter must run once');

  const conflict = await submitTask(t, W.owner, W.tenantId, W.agentId, 'key-1', { prompt: 'DIFFERENT' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_key_conflict');
  const missing = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/tasks`, { session: W.owner, payload: { agentId: W.agentId, type: 'chat', input: {} } });
  assert.equal(missing.statusCode, 400);
});

test('cancel semantics and status filter', async () => {
  const W = await seedWorkspace(t, 'cancel', true);
  const pending = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'c-1')).json().data;
  assert.equal(pending.status, 'awaiting_approval');
  const c1 = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/tasks/${pending.id}/cancel`, { session: W.owner });
  assert.equal(c1.statusCode, 200); assert.equal(c1.json().data.status, 'cancelled');
  const approvals = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/approvals?status=expired`, { session: W.owner })).json().data;
  assert.ok(approvals.some((a: { id: string }) => a.id === pending.approvalId), 'cancelling a task expires its pending approval');
  const c2 = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/tasks/${pending.id}/cancel`, { session: W.owner });
  assert.equal(c2.statusCode, 200, 'cancel is idempotent');

  const W2 = await seedWorkspace(t, 'cancel2');
  const done = (await submitTask(t, W2.owner, W2.tenantId, W2.agentId, 'c-2')).json().data;
  const c3 = await call(t, 'POST', `/api/v1/tenants/${W2.tenantId}/tasks/${done.id}/cancel`, { session: W2.owner });
  assert.equal(c3.statusCode, 409); assert.equal(c3.json().error.code, 'task_not_cancellable');
  const filtered = await call(t, 'GET', `/api/v1/tenants/${W2.tenantId}/tasks?status=succeeded`, { session: W2.owner });
  assert.ok(filtered.json().data.every((x: { status: string }) => x.status === 'succeeded'));
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W2.tenantId}/tasks?status=bogus`, { session: W2.owner })).statusCode, 400);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W2.tenantId}/tasks/00000000-0000-4000-8000-000000000000`, { session: W2.owner })).statusCode, 404);
});

test('adapter failure and unavailable Hermes adapter fail visibly, never fake success', async () => {
  const W = await seedWorkspace(t, 'fail');
  t.adapter.nextOutcome = 'fail';
  const failed = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'f-1')).json().data;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /mock adapter configured to fail/);
  t.adapter.nextOutcome = 'succeed';

  const { buildApp } = await import('../../src/app.js');
  const hermesApp = await buildApp({ adapter: new HermesAdapter(), logger: false });
  const res = await hermesApp.inject({ method: 'POST', url: `/api/v1/tenants/${W.tenantId}/tasks`, headers: { origin: 'http://localhost:5173', cookie: W.owner.cookie, 'x-csrf-token': W.owner.csrf, 'idempotency-key': 'h-1' }, payload: { agentId: W.agentId, type: 'chat', input: { prompt: 'x' } } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().data.status, 'failed');
  assert.match(res.json().data.error, /Hermes programmatic interface not configured/);
  await hermesApp.close();
});

test('pagination cursors walk the full list without gaps or duplicates', async () => {
  const W = await seedWorkspace(t, 'page');
  for (let i = 0; i < 7; i++) await submitTask(t, W.owner, W.tenantId, W.agentId, `p-${i}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const url: string = `/api/v1/tenants/${W.tenantId}/tasks?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
    const page = (await call(t, 'GET', url, { session: W.owner })).json();
    seen.push(...page.data.map((x: { id: string }) => x.id));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 7); assert.equal(new Set(seen).size, 7);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks?limit=101`, { session: W.owner })).statusCode, 400);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks?cursor=garbage`, { session: W.owner })).statusCode, 400);
});

test('restart preserves task history, approvals and audit trail', async () => {
  const W = await seedWorkspace(t, 'restart', true);
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'r-1')).json().data;
  const auditBefore = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/audit-events`, { session: W.owner })).json().data.length;

  await stopApp(t); await closePool();
  t = await startApp();
  const cookie = W.owner; // sessions are server-side rows, so they survive the restart too

  const after = await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${task.id}`, { session: cookie });
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json().data, task);
  const approvals = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/approvals`, { session: cookie })).json().data;
  assert.equal(approvals[0].id, task.approvalId); assert.equal(approvals[0].status, 'pending');
  const auditAfter = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/audit-events`, { session: cookie })).json().data.length;
  assert.equal(auditAfter, auditBefore);
  const { rows } = await getPool().query('SELECT id FROM schema_migrations ORDER BY id');
  assert.deepEqual(rows.map((r) => r.id), ['001_core', '002_tenant_scoped', '003_seed_models', '004_rls_nullif', '005_rate_limit_and_verification', '006_approval_digest_v2', '007_invitations']);
});
