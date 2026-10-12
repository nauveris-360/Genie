import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, freshDatabase, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

test('tenant A cannot read, edit, execute, cancel or decide tenant B records by tampering IDs', async () => {
  const A = await seedWorkspace(t, 'alpha');
  const B = await seedWorkspace(t, 'beta', true);

  const siteB = (await call(t, 'POST', `/api/v1/tenants/${B.tenantId}/websites`, { session: B.owner, payload: { label: 'B site', url: 'https://b.example' } })).json().data;
  const taskB = (await submitTask(t, B.owner, B.tenantId, B.agentId, 'b-1')).json().data;
  assert.equal(taskB.status, 'awaiting_approval');

  // Every B URL with A's session: 404 (membership missing is indistinguishable from non-existence).
  for (const [method, url, payload] of [
    ['GET', `/api/v1/tenants/${B.tenantId}/websites`], ['GET', `/api/v1/tenants/${B.tenantId}/agents`], ['GET', `/api/v1/tenants/${B.tenantId}/providers`],
    ['GET', `/api/v1/tenants/${B.tenantId}/tasks`], ['GET', `/api/v1/tenants/${B.tenantId}/tasks/${taskB.id}`], ['GET', `/api/v1/tenants/${B.tenantId}/approvals`],
    ['GET', `/api/v1/tenants/${B.tenantId}/audit-events`], ['GET', `/api/v1/tenants/${B.tenantId}/model-policy`], ['GET', `/api/v1/tenants/${B.tenantId}/models`],
    ['PATCH', `/api/v1/tenants/${B.tenantId}/websites/${siteB.id}`, { label: 'pwned' }],
    ['PATCH', `/api/v1/tenants/${B.tenantId}/agents/${B.agentId}`, { name: 'pwned' }],
    ['POST', `/api/v1/tenants/${B.tenantId}/tasks/${taskB.id}/cancel`],
    ['POST', `/api/v1/tenants/${B.tenantId}/approvals/${taskB.approvalId}/decision`, { decision: 'approve' }],
    ['PUT', `/api/v1/tenants/${B.tenantId}/model-policy`, { allowPaidFallback: true }],
    ['POST', `/api/v1/tenants/${B.tenantId}/providers`, { provider: 'openrouter', label: 'x', credential: 'sk-x' }],
  ] as const) {
    const res = await call(t, method, url, { session: A.owner, payload, headers: { 'idempotency-key': 'k' } });
    assert.equal(res.statusCode, 404, `${method} ${url} -> ${res.statusCode} ${res.body}`);
  }

  // Cross-tenant references inside A's own URL space: B's agent/connection/website/task ids do not resolve in A.
  assert.equal((await submitTask(t, A.owner, A.tenantId, B.agentId, 'a-x')).statusCode, 404);
  assert.equal((await call(t, 'POST', `/api/v1/tenants/${A.tenantId}/agents`, { session: A.owner, payload: { name: 'x', providerConnectionId: B.providerConnectionId, modelId: 'openrouter/some-model:free' } })).statusCode, 404);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${A.tenantId}/tasks/${taskB.id}`, { session: A.owner })).statusCode, 404);
  assert.equal((await call(t, 'PATCH', `/api/v1/tenants/${A.tenantId}/websites/${siteB.id}`, { session: A.owner, payload: { label: 'x' } })).statusCode, 404);
  assert.equal((await call(t, 'POST', `/api/v1/tenants/${A.tenantId}/approvals/${taskB.approvalId}/decision`, { session: A.owner, payload: { decision: 'approve' } })).statusCode, 404);

  // Nothing in B changed.
  const after = await call(t, 'GET', `/api/v1/tenants/${B.tenantId}/tasks/${taskB.id}`, { session: B.owner });
  assert.equal(after.json().data.status, 'awaiting_approval');
  const policy = await call(t, 'GET', `/api/v1/tenants/${B.tenantId}/model-policy`, { session: B.owner });
  assert.equal(policy.json().data.allowPaidFallback, false);
  // A's listings only ever contain A's rows.
  const aTasks = (await call(t, 'GET', `/api/v1/tenants/${A.tenantId}/tasks`, { session: A.owner })).json().data;
  assert.ok(aTasks.every((x: { tenantId: string }) => x.tenantId === A.tenantId));
  const tenants = (await call(t, 'GET', '/api/v1/tenants', { session: A.owner })).json().data;
  assert.deepEqual(tenants.map((x: { id: string }) => x.id), [A.tenantId]);
});

test('database policies: without tenant context nothing is visible or writable; wrong context sees zero rows', async () => {
  const A = await seedWorkspace(t, 'gamma');
  const pool = getPool();
  const none = await pool.query('SELECT count(*)::int AS n FROM agents');
  assert.equal(none.rows[0].n, 0, 'RLS must default-deny when app.current_tenant_id is unset');
  await assert.rejects(pool.query("INSERT INTO websites (tenant_id, label, url) VALUES ($1, 'x', 'https://x')", [A.tenantId]), /row-level security/);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", ['00000000-0000-4000-8000-000000000000']);
    const other = await client.query('SELECT count(*)::int AS n FROM agents');
    assert.equal(other.rows[0].n, 0);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    const mine = await client.query('SELECT count(*)::int AS n FROM agents');
    assert.equal(mine.rows[0].n, 1);
    // Even with A's context, an agent cannot be pointed at a connection owned by another tenant (trigger).
    const B = await seedWorkspace(t, 'delta');
    await assert.rejects(
      client.query('UPDATE agents SET provider_connection_id = $1 WHERE tenant_id = $2', [B.providerConnectionId, A.tenantId]),
      /same tenant|row-level security/,
    );
    await client.query('ROLLBACK');
  } finally { client.release(); }
});
