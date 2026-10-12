import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  call, FREE_MODEL, freshDatabase, PAID_MODEL, SEEDED_FREE_MODEL, SEEDED_PAID_MODEL, SEEDED_UNKNOWN_MODEL,
  seedWorkspace, startApp, submitTask, teardown, UNKNOWN_MODEL, type TestApp,
} from './helpers.js';
import { effectivePricingStatus, evaluateModel, recordTrustedVerification, type ModelRow } from '../../src/policy/freeFirst.js';
import { getPool } from '../../src/db/index.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

const NOW = new Date('2026-10-12T12:00:00Z');
const HOURS = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const clock = { now: NOW, maxAgeHours: 72 };
const row = (o: Partial<ModelRow>): ModelRow => ({
  provider: 'openrouter', modelId: 'm', displayName: 'm', pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0,
  lastVerifiedAt: HOURS(1), verificationSource: 'trusted', ...o,
});
const KINDS = ['chat', 'summarize', 'embed', 'title_generate', 'auxiliary', 'plugin'] as const;

test('policy engine fails closed for seeded, stale, unknown and unregistered rows; paid needs opt-in', () => {
  for (const kind of KINDS) {
    for (const fallback of [false, true]) {
      const label = `${kind} fallback=${fallback}`;
      assert.equal(evaluateModel(row({}), fallback, kind, clock).allowed, true, `${label}: fresh trusted free`);
      // Seeded placeholder: fails no matter what it claims, even with paid fallback.
      assert.equal(evaluateModel(row({ verificationSource: 'seed' }), fallback, kind, clock).allowed, false, `${label}: seed claiming verified_free`);
      assert.equal(evaluateModel(row({ verificationSource: 'seed', pricingStatus: 'paid', inputPrice: 3, outputPrice: 15 }), fallback, kind, clock).allowed, false, `${label}: seed paid`);
      assert.equal(evaluateModel(row({ verificationSource: 'seed', lastVerifiedAt: null }), fallback, kind, clock).allowed, false, `${label}: seed no timestamp`);
      // Stale: aged trusted verification, or explicitly stale status.
      assert.equal(evaluateModel(row({ lastVerifiedAt: HOURS(73) }), fallback, kind, clock).allowed, false, `${label}: aged free`);
      assert.equal(evaluateModel(row({ pricingStatus: 'paid', inputPrice: 3, outputPrice: 15, lastVerifiedAt: HOURS(73) }), fallback, kind, clock).allowed, false, `${label}: aged paid`);
      assert.equal(evaluateModel(row({ pricingStatus: 'stale' }), fallback, kind, clock).allowed, false, `${label}: stale status`);
      assert.equal(evaluateModel(row({ lastVerifiedAt: null }), fallback, kind, clock).allowed, false, `${label}: trusted without timestamp`);
      // Unknown and unregistered.
      assert.equal(evaluateModel(row({ pricingStatus: 'unknown', inputPrice: null, outputPrice: null }), fallback, kind, clock).allowed, false, `${label}: unknown`);
      assert.equal(evaluateModel(null, fallback, kind, clock).allowed, false, `${label}: unregistered`);
      // ":free" label with non-zero verified price.
      assert.equal(evaluateModel(row({ outputPrice: 0.5 }), fallback, kind, clock).allowed, false, `${label}: free label, non-zero price`);
      // Paid: only with explicit fallback.
      assert.equal(evaluateModel(row({ pricingStatus: 'paid', inputPrice: 3, outputPrice: 15 }), fallback, kind, clock).allowed, fallback, `${label}: fresh trusted paid`);
    }
  }
  assert.equal(effectivePricingStatus(row({ verificationSource: 'seed' }), clock), 'unknown');
  assert.equal(effectivePricingStatus(row({ lastVerifiedAt: HOURS(73) }), clock), 'stale');
  assert.equal(effectivePricingStatus(row({ lastVerifiedAt: HOURS(71) }), clock), 'verified_free');
});

test('seeded registry rows are rejected at agent creation even with paid fallback enabled', async () => {
  const W = await seedWorkspace(t, 'seeded');
  const base = `/api/v1/tenants/${W.tenantId}`;
  for (const fallback of [false, true]) {
    await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: fallback } });
    for (const modelId of [SEEDED_FREE_MODEL, SEEDED_PAID_MODEL, SEEDED_UNKNOWN_MODEL]) {
      const res = await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'x', providerConnectionId: W.providerConnectionId, modelId } });
      assert.equal(res.statusCode, 409, `${modelId} fallback=${fallback}`);
      assert.equal(res.json().error.code, 'model_not_allowed');
    }
  }
  const seededFree = await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'x', providerConnectionId: W.providerConnectionId, modelId: SEEDED_FREE_MODEL } });
  assert.match(seededFree.json().error.message, /trusted verification/);
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
  assert.equal(audit.filter((e: { action: string }) => e.action === 'model_policy.updated').length, 2, 'every policy flip is audited');
  const tasks = (await call(t, 'GET', `${base}/tasks`, { session: W.owner })).json().data;
  assert.ok(tasks.every((x: { agentId: string }) => x.agentId !== paidAgent.id), 'blocked submissions create no task row');
});

test('a verification that goes stale blocks an existing agent at submit time; re-verification restores it', async () => {
  const W = await seedWorkspace(t, 'stale');
  const pool = getPool();
  await pool.query(`UPDATE models SET last_verified_at = now() - interval '73 hours' WHERE model_id = $1`, [FREE_MODEL]);
  const blocked = await submitTask(t, W.owner, W.tenantId, W.agentId, 'stale-1');
  assert.equal(blocked.statusCode, 409); assert.match(blocked.json().error.message, /stale/);
  const listed = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/models`, { session: W.owner })).json().data.find((m: { modelId: string }) => m.modelId === FREE_MODEL);
  assert.equal(listed.pricingStatus, 'stale'); assert.equal(listed.allowed, false);

  const client = await pool.connect();
  try {
    await recordTrustedVerification(client, { provider: 'openrouter', modelId: FREE_MODEL, displayName: 'Test verified free', pricingStatus: 'verified_free', inputPrice: 0, outputPrice: 0 });
  } finally { client.release(); }
  assert.equal((await submitTask(t, W.owner, W.tenantId, W.agentId, 'stale-2')).statusCode, 202);
});

test('/models reports effective status, hides unverified prices, and never invents usage balances', async () => {
  const W = await seedWorkspace(t, 'models');
  const base = `/api/v1/tenants/${W.tenantId}`;
  const byId = async () => Object.fromEntries((await call(t, 'GET', `${base}/models`, { session: W.owner })).json().data.map((m: { modelId: string }) => [m.modelId, m]));
  const m = await byId();
  assert.deepEqual(
    { s: m[FREE_MODEL].pricingStatus, v: m[FREE_MODEL].verificationSource, a: m[FREE_MODEL].allowed, i: m[FREE_MODEL].inputPricePerMillionTokensUsd },
    { s: 'verified_free', v: 'trusted', a: true, i: 0 },
  );
  assert.equal(m[PAID_MODEL].pricingStatus, 'paid'); assert.equal(m[PAID_MODEL].allowed, false);
  assert.equal(m[UNKNOWN_MODEL].pricingStatus, 'unknown'); assert.equal(m[UNKNOWN_MODEL].allowed, false);
  for (const id of [SEEDED_FREE_MODEL, SEEDED_PAID_MODEL, SEEDED_UNKNOWN_MODEL]) {
    assert.equal(m[id].verificationSource, 'seed', id);
    assert.equal(m[id].pricingStatus, 'unknown', `${id}: a seed row's stored claim is never reported as fact`);
    assert.equal(m[id].allowed, false, id);
    assert.equal(m[id].inputPricePerMillionTokensUsd, null, id);
    assert.equal(m[id].outputPricePerMillionTokensUsd, null, id);
    assert.equal(m[id].lastVerifiedAt, null, id);
  }
  assert.ok(Object.values(m).every((x) => (x as { usage: unknown }).usage === null), 'no usage integration => null, never a made-up number');

  await call(t, 'PUT', `${base}/model-policy`, { session: W.owner, payload: { allowPaidFallback: true } });
  const after = await byId();
  assert.equal(after[PAID_MODEL].allowed, true);
  assert.equal(after[UNKNOWN_MODEL].allowed, false);
  assert.equal(after[SEEDED_PAID_MODEL].allowed, false, 'paid fallback does not unlock an unverified paid row');
  assert.equal(after[SEEDED_FREE_MODEL].allowed, false);
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
