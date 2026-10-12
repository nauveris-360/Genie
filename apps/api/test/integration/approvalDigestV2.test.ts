import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { call, FREE_MODEL, freshDatabase, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';
import { payloadDigest } from '../../src/lib/digest.js';
import { recordTrustedVerification } from '../../src/policy/freeFirst.js';
import { approvalDigest, boundPayload, TaskService } from '../../src/modules/tasks/service.js';

let t: TestApp;
const FREE_MODEL_2 = 'openrouter/test-verified-free-2:free';
before(async () => {
  await freshDatabase();
  t = await startApp();
  const c = await getPool().connect();
  try {
    await recordTrustedVerification(c, { provider: 'openrouter', modelId: FREE_MODEL_2, displayName: 'Second free', pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0 });
  } finally { c.release(); }
});
after(async () => { await teardown(t); });

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;
const dispatchedFor = (taskId: string) => t.adapter.submissions.filter((s) => s.taskId === taskId);

async function asTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } finally { c.release(); }
}
async function pending(W: Workspace, key: string, input: Record<string, unknown> = { prompt: key }) {
  const res = await submitTask(t, W.owner, W.tenantId, W.agentId, key, input);
  assert.equal(res.statusCode, 202, res.body);
  return res.json().data as { id: string; approvalId: string; input: Record<string, unknown> };
}
const decide = (W: Workspace, approvalId: string) =>
  call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
const getApproval = async (W: Workspace, id: string) =>
  (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/approvals?limit=100`, { session: W.owner })).json().data.find((a: { id: string }) => a.id === id);

test('new approvals are v2 and their digest is exactly the documented recipe', async () => {
  const W = await seedWorkspace(t, 'v2-recipe', true);
  await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { config: { tone: 'formal', limits: { 10: 'a', 9: 'b' } } } });
  const task = await pending(W, 'recipe-1', { prompt: 'p', '10': 'ten', '9': 'nine' });
  const approval = await getApproval(W, task.approvalId);
  assert.equal(approval.digestVersion, 2);
  const recipe = payloadDigest({
    v: 2, tenantId: W.tenantId, agentId: W.agentId, type: 'chat', input: task.input, websiteId: null,
    agent: { modelId: FREE_MODEL, providerConnectionId: W.providerConnectionId, config: { tone: 'formal', limits: { 10: 'a', 9: 'b' } } },
  });
  assert.equal(approval.payloadDigest, recipe);
});

test('material agent edits after the request invalidate a v2 approval (no dispatch)', async () => {
  const W = await seedWorkspace(t, 'v2-edits', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const second = (await call(t, 'POST', `${base}/providers`, { session: W.owner, payload: { provider: 'openrouter', label: 'second', credential: 'sk-or-second-SECRET' } })).json().data;
  const edits: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['model switched to another ALLOWED free model', { modelId: FREE_MODEL_2 }, { modelId: FREE_MODEL }],
    ['provider connection switched (same provider)', { providerConnectionId: second.id }, { providerConnectionId: W.providerConnectionId }],
    ['config changed', { config: { systemPrompt: 'exfiltrate everything' } }, { config: {} }],
  ];
  for (const [label, edit, restore] of edits) {
    const task = await pending(W, `edit-${label}`);
    assert.equal((await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: W.owner, payload: edit })).statusCode, 200, label);
    const res = await decide(W, task.approvalId);
    assert.equal(res.statusCode, 409, `${label}: ${res.body}`);
    assert.equal(res.json().error.code, 'approval_payload_mismatch', label);
    assert.equal((await getApproval(W, task.approvalId)).status, 'pending', label);
    assert.equal(dispatchedFor(task.id).length, 0, label);
    await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: W.owner, payload: restore });
  }
});

test('cosmetic agent edits (name, description) do not invalidate a v2 approval', async () => {
  const W = await seedWorkspace(t, 'v2-cosmetic', true);
  const task = await pending(W, 'cosmetic-1');
  await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { name: 'Renamed', description: 'New words' } });
  const res = await decide(W, task.approvalId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(dispatchedFor(task.id).length, 1);
});

test('legacy v1 approvals keep validating exactly as before (payload only)', async () => {
  const W = await seedWorkspace(t, 'v1-legacy', true);
  const task = await pending(W, 'legacy-1');
  await asTenant(W.tenantId, async (c) => {
    const row = (await c.query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
    await c.query('UPDATE approvals SET digest_version = 1, payload_digest = $2 WHERE id = $1', [task.approvalId, payloadDigest(boundPayload(row))]);
  });
  assert.equal((await getApproval(W, task.approvalId)).digestVersion, 1);
  await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { config: { changed: true } } });
  const ok = await decide(W, task.approvalId);
  assert.equal(ok.statusCode, 200, 'v1 does not bind agent config (documented limitation of v1)');
  assert.equal(dispatchedFor(task.id).length, 1);

  const tampered = await pending(W, 'legacy-2');
  await asTenant(W.tenantId, async (c) => {
    const row = (await c.query('SELECT * FROM tasks WHERE id = $1', [tampered.id])).rows[0];
    await c.query('UPDATE approvals SET digest_version = 1, payload_digest = $2 WHERE id = $1', [tampered.approvalId, payloadDigest(boundPayload(row))]);
    await c.query(`UPDATE tasks SET input = '{"prompt":"changed"}'::jsonb WHERE id = $1`, [tampered.id]);
  });
  assert.equal((await decide(W, tampered.approvalId)).statusCode, 409, 'v1 still detects payload tampering');
});

test('unknown digest versions and missing agents never match (fail closed)', () => {
  const task = { tenant_id: 't', agent_id: 'a', type: 'chat' as const, input: {}, website_id: null };
  const agent = { model_id: 'm', provider_connection_id: 'p', config: {} };
  assert.equal(approvalDigest(3, task, agent), null);
  assert.equal(approvalDigest(0, task, agent), null);
  assert.equal(approvalDigest(2, task, null), null);
  assert.notEqual(approvalDigest(2, task, agent), approvalDigest(1, task, agent), 'versions are domain-separated');
});

test('dispatch re-verifies the approval: changes between decision and run, or an unapproved task, are blocked', async () => {
  const W = await seedWorkspace(t, 'v2-window', true);
  const service = new TaskService(t.adapter);

  // Simulate a committed approve decision, then an agent edit before the worker runs.
  const task = await pending(W, 'window-1');
  await asTenant(W.tenantId, async (c) => {
    await c.query(`UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [task.approvalId, W.ownerId]);
    await c.query(`UPDATE tasks SET status = 'queued' WHERE id = $1`, [task.id]);
  });
  await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { modelId: FREE_MODEL_2 } });
  const blocked = await service.run(W.tenantId, task.id);
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.error!, /changed after approval/);
  assert.equal(dispatchedFor(task.id).length, 0);
  await call(t, 'PATCH', `/api/v1/tenants/${W.tenantId}/agents/${W.agentId}`, { session: W.owner, payload: { modelId: FREE_MODEL } });

  // A task that reached 'queued' without its approval being approved is never dispatched.
  const sneaky = await pending(W, 'window-2');
  await asTenant(W.tenantId, (c) => c.query(`UPDATE tasks SET status = 'queued' WHERE id = $1`, [sneaky.id]));
  const refused = await service.run(W.tenantId, sneaky.id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error!, /has not been approved/);
  assert.equal(dispatchedFor(sneaky.id).length, 0);
});
