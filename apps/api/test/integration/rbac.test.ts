import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_ROLES, roleHasPermission, type Role } from '@genie/contracts';
import { call, freshDatabase, memberSession, seedWorkspace, startApp, submitTask, teardown, type Session, type TestApp } from './helpers.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

const expectStatus = (allowed: boolean, status: number, label: string, body: string) => {
  if (allowed) assert.ok(status < 400, `${label}: expected success, got ${status} ${body}`);
  else assert.equal(status, 403, `${label}: expected 403, got ${status} ${body}`);
};

test('server-enforced permission matrix matches the shared contract table for every role', async () => {
  const W = await seedWorkspace(t, 'rbac', true);
  const sessions: Record<Role, Session> = {
    owner: W.owner,
    admin: await memberSession(t, W.tenantId, 'admin', 'rbac'),
    operator: await memberSession(t, W.tenantId, 'operator', 'rbac'),
    viewer: await memberSession(t, W.tenantId, 'viewer', 'rbac'),
  };
  const site = (await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/websites`, { session: W.owner, payload: { label: 's', url: 'https://s.example' } })).json().data;

  for (const role of ['owner', 'admin', 'operator', 'viewer'] as Role[]) {
    const s = sessions[role];
    const base = `/api/v1/tenants/${W.tenantId}`;
    const reads: Array<[string, string]> = [
      ['website:read', `${base}/websites`], ['agent:read', `${base}/agents`], ['provider:read', `${base}/providers`], ['modelPolicy:read', `${base}/model-policy`],
      ['modelPolicy:read', `${base}/models`], ['task:read', `${base}/tasks`], ['approval:read', `${base}/approvals`], ['auditEvent:read', `${base}/audit-events`],
    ];
    for (const [perm, url] of reads) {
      const r = await call(t, 'GET', url, { session: s });
      expectStatus(roleHasPermission(role, perm as never), r.statusCode, `${role} GET ${url}`, r.body);
    }

    const w = (await call(t, 'POST', `${base}/websites`, { session: s, payload: { label: `${role}`, url: 'https://w.example' } }));
    expectStatus(roleHasPermission(role, 'website:write'), w.statusCode, `${role} create website`, w.body);
    const p = await call(t, 'PATCH', `${base}/websites/${site.id}`, { session: s, payload: { label: `by-${role}` } });
    expectStatus(roleHasPermission(role, 'website:write'), p.statusCode, `${role} patch website`, p.body);
    const a = await call(t, 'POST', `${base}/agents`, { session: s, payload: { name: `${role}-agent`, providerConnectionId: W.providerConnectionId, modelId: 'openrouter/some-model:free' } });
    expectStatus(roleHasPermission(role, 'agent:write'), a.statusCode, `${role} create agent`, a.body);
    const pa = await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: s, payload: { description: role } });
    expectStatus(roleHasPermission(role, 'agent:write'), pa.statusCode, `${role} patch agent`, pa.body);
    const pr = await call(t, 'POST', `${base}/providers`, { session: s, payload: { provider: 'gemini', label: role, credential: 'k-SECRET' } });
    expectStatus(roleHasPermission(role, 'provider:write'), pr.statusCode, `${role} save provider`, pr.body);
    const mp = await call(t, 'PUT', `${base}/model-policy`, { session: s, payload: { allowPaidFallback: false } });
    expectStatus(roleHasPermission(role, 'modelPolicy:write'), mp.statusCode, `${role} put model-policy`, mp.body);
    const ts = await submitTask(t, s, W.tenantId, W.agentId, `rbac-${role}`);
    expectStatus(roleHasPermission(role, 'task:submit'), ts.statusCode, `${role} submit task`, ts.body);

    if (ts.statusCode === 202) {
      const task = ts.json().data;
      const dec = await call(t, 'POST', `${base}/approvals/${task.approvalId}/decision`, { session: s, payload: { decision: 'reject', reason: 'rbac' } });
      expectStatus(roleHasPermission(role, 'approval:decide'), dec.statusCode, `${role} decide approval`, dec.body);
      const canc = await call(t, 'POST', `${base}/tasks/${task.id}/cancel`, { session: s });
      // cancel on an already-rejected (cancelled) task is idempotent 200 for permitted roles
      expectStatus(roleHasPermission(role, 'task:cancel'), canc.statusCode, `${role} cancel task`, canc.body);
    }
  }

  // viewer-specific: a cancel/decide on someone else's pending items is 403, not 404 (membership exists, role lacks permission)
  const pending = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'rbac-pending')).json().data;
  assert.equal((await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/tasks/${pending.id}/cancel`, { session: sessions.viewer })).statusCode, 403);
  assert.equal((await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${pending.approvalId}/decision`, { session: sessions.operator, payload: { decision: 'approve' } })).statusCode, 403);
  assert.equal((await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${pending.id}`, { session: sessions.viewer })).statusCode, 200);
});

test('contract table sanity: viewer has no write permission, owner has every permission', () => {
  for (const [perm, roles] of Object.entries(PERMISSION_ROLES)) {
    assert.ok(roles.includes('owner'), `owner missing ${perm}`);
    if (perm.endsWith(':write') || perm.endsWith(':submit') || perm.endsWith(':cancel') || perm.endsWith(':decide')) {
      assert.ok(!roles.includes('viewer'), `viewer must not have ${perm}`);
    }
  }
  assert.ok(!roleHasPermission('operator', 'provider:write'));
  assert.ok(!roleHasPermission('operator', 'approval:decide'));
  assert.ok(!roleHasPermission('operator', 'modelPolicy:write'));
});
