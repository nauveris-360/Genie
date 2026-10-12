import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, FREE_MODEL, freshDatabase, PAID_MODEL, seedWorkspace, startApp, submitTask, teardown, UNKNOWN_MODEL, type TestApp } from './helpers.js';
import { evaluateModel, type ModelRow } from '../../src/policy/freeFirst.js';
import { getPool } from '../../src/db/index.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

const row = (pricingStatus: ModelRow['pricingStatus'], input: number | null, output: number | null): ModelRow =>
  ({ provider: 'openrouter', modelId: 'm', displayName: 'm', pricingStatus, inputPrice: input, outputPrice: output, lastVerifiedAt: null });

test('policy engine: only verified zero-priced models are free; unknown/stale are never allowed; paid needs explicit opt-in', () => {
  for (const kind of ['chat', 'summarize', 'embed', 'title_generate', 'auxiliary', 'plugin'] as const) {
    assert.equal(evaluateModel(row('verified_free', 0, 0), false, kind).allowed, true, kind);
    assert.equal(evaluateModel(row('verified_free', 0, 0.5), false, kind).allowed, false, `${kind}: :free label with non-zero verified output price`);
    assert.equal(evaluateModel(row('paid', 3, 15), false, kind).allowed, false, kind);
    assert.equal(evaluateModel(row('paid', 3, 15), true, kind).allowed, true, kind);
    assert.equal(evaluateModel(row('unknown', null, null), false, kind).allowed, false, kind);
    assert.equal(evaluateModel(row('unknown', null, null), true, kind).allowed, false, `${kind}: unknown pricing even with paid fallback`);
    assert.equal(evaluateModel(row('stale', 0, 0), true, kind).allowed, false, `${kind}: stale verification`);
    assert.equal(evaluateModel(null, true, kind).allowed, false, `${kind}: unregistered model`);
  }
});

test('paid fallback is OFF by default and blocks paid/unknown models at agent creation and every task type', async () => {
  const W = await seedWorkspace(t, 'ff');
  const base = `/api/v1/tenants/${W.tenantId}`;
  const policy = (await call(t, 'GET', `${base}/model-policy`, { session: W.owner })).json().data;
  assert.equal(policy.allowPaidFallback, false);

  for (const modelId of [PAID_MODEL, UNKNOWN_MODEL, 'openrouter/not-registered:free']) {
    const res = await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'x', providerConnectionId: W.providerConnectionId, modelId } });
    assert.equal(res.statusCode, 409, modelId); assert.equal(res.json().error.code, 'model_not_allowed');
  }
  const patch = await call(t, 'PATCH', `${base}/agents/${W.agentId}`, { session: W.owner, payload: { modelId: PAID_MODEL } });
  assert.equal(patch.statusCode, 409);

  // An agent created under a permissive policy is re-checked at submit time once policy tightens.
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  const paidAgent = (await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'paid', providerConnectionId: W.providerConnectionId, modelId: PAID_MODEL } })).json().data;
  assert.equal(paidAgent.modelId, PAID_MODEL);
  const stillUnknown = await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'u', providerConnectionId: W.providerConnectionId, modelId: UNKNOWN_MODEL } });
  assert.equal(stillUnknown.statusCode, 409, 'paid fallback never unlocks unknown pricing');
  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: false } });

  for (const type of ['chat', 'summarize', 'embed', 'title_generate']) {
    const res = await submitTask(t, W.owner, W.tenantId, paidAgent.id, `ff-${type}`, { prompt: 'x' }, type);
    assert.equal(res.statusCode, 409, type); assert.equal(res.json().error.code, 'model_not_allowed');
    const ok = await submitTask(t, W.owner, W.tenantId, W.agentId, `ff-ok-${type}`, { prompt: 'x' }, type);
    assert.equal(ok.statusCode, 202, type);
  }
  assert.ok(t.adapter.submissions.every((s) => s.modelId === FREE_MODEL), 'no paid model ever reached the adapter');

  const audit = (await call(t, 'GET', `${base}/audit-events`, { session: W.owner })).json().data;
  const policyChanges = audit.filter((e: { action: string }) => e.action === 'model_policy.updated');
  assert.equal(policyChanges.length, 2, 'every policy flip is audited');
  const tasks = (await call(t, 'GET', `${base}/tasks`, { session: W.owner })).json().data;
  assert.ok(tasks.every((x: { agentId: string }) => x.agentId !== paidAgent.id), 'blocked submissions create no task row');
});

test('/models reports allowed flags from the policy and never invents usage balances', async () => {
  const W = await seedWorkspace(t, 'models');
  const base = `/api/v1/tenants/${W.tenantId}`;
  const models = (await call(t, 'GET', `${base}/models`, { session: W.owner })).json().data;
  const byId = Object.fromEntries(models.map((m: { modelId: string }) => [m.modelId, m]));
  assert.equal(byId[FREE_MODEL].allowed, true); assert.equal(byId[FREE_MODEL].pricingStatus, 'verified_free');
  assert.equal(byId[PAID_MODEL].allowed, false); assert.equal(byId[PAID_MODEL].pricingStatus, 'paid');
  assert.equal(byId[UNKNOWN_MODEL].allowed, false); assert.equal(byId[UNKNOWN_MODEL].lastVerifiedAt, null);
  assert.ok(models.every((m: { usage: unknown }) => m.usage === null), 'no usage integration => null, never a made-up number');

  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  const after = (await call(t, 'GET', `${base}/models`, { session: W.owner })).json().data;
  const after2 = Object.fromEntries(after.map((m: { modelId: string }) => [m.modelId, m]));
  assert.equal(after2[PAID_MODEL].allowed, true); assert.equal(after2[UNKNOWN_MODEL].allowed, false);
});

test('a tenant with no model_policies row is treated as paid fallback OFF (default-deny on missing config)', async () => {
  const W = await seedWorkspace(t, 'norow');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [W.tenantId]);
    await client.query('DELETE FROM model_policies WHERE tenant_id = $1', [W.tenantId]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const policy = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/model-policy`, { session: W.owner })).json().data;
  assert.equal(policy.allowPaidFallback, false);
  const res = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/agents`, { session: W.owner, payload: { name: 'x', providerConnectionId: W.providerConnectionId, modelId: PAID_MODEL } });
  assert.equal(res.statusCode, 409);
});
