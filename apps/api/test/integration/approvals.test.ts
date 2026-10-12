import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, freshDatabase, memberSession, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

async function tenantQuery(tenantId: string, sql: string, params: unknown[]) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    return r;
  } finally { client.release(); }
}

test('consequential action parks in awaiting_approval; approve executes, decision is immutable', async () => {
  const W = await seedWorkspace(t, 'appr', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'a-1', { prompt: 'post it' })).json().data;
  assert.equal(task.status, 'awaiting_approval'); assert.ok(task.approvalId);
  const ranFor = (id: string) => t.adapter.submissions.filter((s) => s.taskId === id).length;
  assert.equal(ranFor(task.id), 0, 'nothing reaches the adapter before approval');

  const pending = (await call(t, 'GET', `${base}/approvals?status=pending`, { session: W.owner })).json().data;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'task.execute'); assert.equal(pending[0].taskId, task.id);
  assert.match(pending[0].payloadDigest, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(pending[0].expiresAt) > Date.now());

  const approve = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().data.status, 'approved'); assert.equal(approve.json().data.decidedBy, W.ownerId);
  const ran = (await call(t, 'GET', `${base}/tasks/${task.id}`, { session: W.owner })).json().data;
  assert.equal(ran.status, 'succeeded'); assert.equal(ranFor(task.id), 1);

  // replay of a decided approval
  const replay = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'reject' } });
  assert.equal(replay.statusCode, 409); assert.equal(replay.json().error.code, 'approval_already_decided');
  const still = (await call(t, 'GET', `${base}/approvals`, { session: W.owner })).json().data.find((a: { id: string }) => a.id === task.approvalId);
  assert.equal(still.status, 'approved');
  assert.equal(ranFor(task.id), 1, 'replay must not execute again');

  const audit = (await call(t, 'GET', `${base}/audit-events`, { session: W.owner })).json().data.map((e: { action: string }) => e.action);
  for (const a of ['approval.requested', 'approval.decided', 'task.submitted', 'task.succeeded']) assert.ok(audit.includes(a), a);
});

test('reject cancels the task and records the reason', async () => {
  const W = await seedWorkspace(t, 'rej', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'r-1')).json().data;
  const rej = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'reject', reason: 'not for this site' } });
  assert.equal(rej.statusCode, 200); assert.equal(rej.json().data.status, 'rejected'); assert.equal(rej.json().data.reason, 'not for this site');
  const after = (await call(t, 'GET', `${base}/tasks/${task.id}`, { session: W.owner })).json().data;
  assert.equal(after.status, 'cancelled'); assert.match(after.error, /rejected: not for this site/);
  assert.equal(t.adapter.submissions.filter((s) => s.taskId === task.id).length, 0);
});

test('payload change after approval creation invalidates it (no replay into a changed action)', async () => {
  const W = await seedWorkspace(t, 'mut', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'm-1', { prompt: 'benign' })).json().data;
  await tenantQuery(W.tenantId, `UPDATE tasks SET input = '{"prompt":"malicious"}'::jsonb WHERE id = $1`, [task.id]);
  const res = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(res.statusCode, 409); assert.equal(res.json().error.code, 'approval_payload_mismatch');
  const still = (await call(t, 'GET', `${base}/approvals`, { session: W.owner })).json().data.find((a: { id: string }) => a.id === task.approvalId);
  assert.equal(still.status, 'pending', 'mismatch does not consume the approval');
  assert.equal((await call(t, 'GET', `${base}/tasks/${task.id}`, { session: W.owner })).json().data.status, 'awaiting_approval');
  assert.equal(t.adapter.submissions.filter((s) => s.taskId === task.id).length, 0);
});

test('expired approval cannot be decided and is marked expired', async () => {
  const W = await seedWorkspace(t, 'exp', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'e-1')).json().data;
  await tenantQuery(W.tenantId, `UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1`, [task.approvalId]);
  const res = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(res.statusCode, 409); assert.equal(res.json().error.code, 'approval_expired');
  const row = (await call(t, 'GET', `${base}/approvals?status=expired`, { session: W.owner })).json().data.find((a: { id: string }) => a.id === task.approvalId);
  assert.equal(row.status, 'expired');
  const again = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
  assert.equal(again.json().error.code, 'approval_expired');
  assert.equal(t.adapter.submissions.filter((s) => s.taskId === task.id).length, 0);
});

test('only owner/admin can decide; approval for an unknown id is 404', async () => {
  const W = await seedWorkspace(t, 'who', true);
  const base = `/api/v1/tenants/${W.tenantId}`;
  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'w-1')).json().data;
  const operator = await memberSession(t, W.tenantId, 'operator', 'who');
  const viewer = await memberSession(t, W.tenantId, 'viewer', 'who');
  const admin = await memberSession(t, W.tenantId, 'admin', 'who');
  assert.equal((await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: operator, payload: { decision: 'approve' } })).statusCode, 403);
  assert.equal((await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: viewer, payload: { decision: 'approve' } })).statusCode, 403);
  assert.equal((await call(t, 'POST', `${base}/approvals/00000000-0000-4000-8000-000000000000/decision`, { session: admin, payload: { decision: 'approve' } })).statusCode, 404);
  assert.equal((await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: admin, payload: { decision: 'maybe' } })).statusCode, 400);
  const ok = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: admin, payload: { decision: 'approve' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().data.decidedBy, admin.userId);
});
