import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { call, freshDatabase, SEEDED_FREE_MODEL, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';
import { classifyPricing, fetchOpenRouterModels, parseApprovedModels, syncOpenRouterPricing, type ApprovedModel } from '../../src/policy/pricingSync.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

const ZERO = { prompt: '0', completion: '0', request: '0', image: '0', web_search: '0', internal_reasoning: '0' };
const feedBody = (models: unknown[]) => JSON.stringify({ data: models });
function fakeFetch(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}
async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { return await fn(c); } finally { c.release(); }
}
const registryRow = async (modelId: string) =>
  (await getPool().query('SELECT pricing_status, verification_source, input_price_per_million_tokens_usd::float AS input, output_price_per_million_tokens_usd::float AS output, last_verified_at FROM models WHERE model_id = $1', [modelId])).rows[0];

test('classification: only all-zero pricing is free; any charge is paid; anything malformed fails closed', () => {
  assert.equal(classifyPricing(ZERO).pricingStatus, 'verified_free');
  assert.equal(classifyPricing({ prompt: '0', completion: '0.0' }).pricingStatus, 'verified_free');
  assert.equal(classifyPricing({ prompt: 0, completion: 0 }).pricingStatus, 'verified_free');

  const paid = classifyPricing({ prompt: '0.000003', completion: '0.000015' });
  assert.deepEqual([paid.pricingStatus, paid.inputPrice, paid.outputPrice], ['paid', 3, 15]);
  for (const dim of ['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'audio', 'some_future_dimension']) {
    const c = classifyPricing({ ...ZERO, [dim]: '0.0001' });
    assert.equal(c.pricingStatus, 'paid', `${dim} charged`);
    assert.match(c.reason, new RegExp(dim));
  }

  for (const [label, pricing] of [
    ['missing object', undefined], ['null', null], ['array', []], ['missing completion', { prompt: '0' }],
    ['variable price -1', { prompt: '-1', completion: '-1' }], ['non-numeric', { prompt: 'free', completion: '0' }],
    ['empty string', { prompt: '', completion: '0' }], ['NaN', { prompt: 'NaN', completion: '0' }],
    ['Infinity', { prompt: 0, completion: Infinity }], ['hex', { prompt: '0x0', completion: '0' }],
    ['extra dimension malformed', { ...ZERO, image: 'n/a' }], ['negative number', { prompt: 0, completion: -0.5 }],
  ] as const) {
    assert.equal(classifyPricing(pricing).pricingStatus, 'unknown', label);
  }
});

test('feed fetch: public GET, no credentials, no redirects; bad responses throw', async () => {
  const ok = fakeFetch(feedBody([{ id: 'a/b:free', pricing: ZERO }]));
  const feed = await fetchOpenRouterModels(ok.impl, 'https://example.test/models');
  assert.equal(feed.size, 1);
  assert.equal(ok.calls.length, 1);
  const init = ok.calls[0]!.init!;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), null, 'never sends a key');
  const names: string[] = [];
  headers.forEach((_v, k) => names.push(k));
  assert.deepEqual(names, ['accept'], 'no other headers (no credentials, cookies or keys)');

  for (const [label, body, status] of [
    ['http 500', '{}', 500], ['not json', '<html>', 200], ['no data', '{"models":[]}', 200],
    ['data not array', '{"data":{}}', 200], ['empty', '{"data":[]}', 200], ['no valid ids', '{"data":[{"name":"x"}]}', 200],
  ] as const) {
    await assert.rejects(fetchOpenRouterModels(fakeFetch(body, status).impl), Error, label);
  }
  await assert.rejects(fetchOpenRouterModels(fakeFetch(' '.repeat(20 * 1024 * 1024 + 1)).impl), /size limit/);
});

test('approved list: strict parsing; the shipped config is valid and empty', async () => {
  assert.deepEqual(parseApprovedModels({ openrouter: [{ openRouterId: 'v/m:free', displayName: 'M' }] }), [{ openRouterId: 'v/m:free', displayName: 'M' }]);
  for (const bad of [{}, { openrouter: {} }, { openrouter: [{}] }, { openrouter: [{ openRouterId: 'openrouter/v/m' }] },
    { openrouter: [{ openRouterId: 'v/m' }, { openRouterId: 'v/m' }] }, { openrouter: [{ openRouterId: 'bad id with spaces' }] }]) {
    assert.throws(() => parseApprovedModels(bad), /approved-models\.json/, JSON.stringify(bad));
  }
  const shipped = JSON.parse(await readFile(new URL('../../config/approved-models.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseApprovedModels(shipped), []);
});

test('sync: approved models are verified from the feed; missing, unapproved and feed-only models fail closed', async () => {
  await withClient((c) => c.query(`INSERT INTO models (provider, model_id, display_name, pricing_status, input_price_per_million_tokens_usd, output_price_per_million_tokens_usd, last_verified_at, verification_source)
    VALUES ('openrouter', 'openrouter/old/approved:free', 'Old', 'verified_free', 0, 0, now(), 'trusted') ON CONFLICT DO NOTHING`));
  const approved: ApprovedModel[] = [
    { openRouterId: 'sync/free:free', displayName: 'Sync Free' },
    { openRouterId: 'sync/paid' },
    { openRouterId: 'sync/free-label-but-charges:free' },
    { openRouterId: 'sync/delisted:free' },
    { openRouterId: 'test-verified-free:free' },
    { openRouterId: 'test-verified-paid' },
  ];
  const feed = await fetchOpenRouterModels(fakeFetch(feedBody([
    { id: 'sync/free:free', name: 'Feed Name', pricing: ZERO },
    { id: 'sync/paid', pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'sync/free-label-but-charges:free', pricing: { ...ZERO, request: '0.002' } },
    { id: 'sync/not-approved:free', pricing: ZERO },
    { id: 'test-verified-free:free', pricing: ZERO },
    { id: 'test-verified-paid', pricing: { prompt: '0.000003', completion: '0.000015' } },
  ])).impl);

  const dry = await withClient((c) => syncOpenRouterPricing(c, approved, feed, { dryRun: true }));
  assert.equal(await registryRow('openrouter/sync/free:free'), undefined, 'dry run writes nothing');
  assert.equal((await registryRow('openrouter/old/approved:free')).pricing_status, 'verified_free');

  const results = await withClient((c) => syncOpenRouterPricing(c, approved, feed, { dryRun: false }));
  assert.deepEqual(results.map((r) => [r.modelId, r.pricingStatus, r.action]), dry.map((r) => [r.modelId, r.pricingStatus, r.action]));

  const free = await registryRow('openrouter/sync/free:free');
  assert.deepEqual([free.pricing_status, free.verification_source, free.input, free.output], ['verified_free', 'trusted', 0, 0]);
  assert.ok(Date.now() - new Date(free.last_verified_at).getTime() < 60_000);
  assert.equal((await getPool().query(`SELECT display_name FROM models WHERE model_id = 'openrouter/sync/free:free'`)).rows[0].display_name, 'Sync Free');
  const paid = await registryRow('openrouter/sync/paid');
  assert.deepEqual([paid.pricing_status, paid.input, paid.output], ['paid', 3, 15]);
  assert.equal((await registryRow('openrouter/sync/free-label-but-charges:free')).pricing_status, 'paid', ':free label does not override a charge');
  assert.equal((await registryRow('openrouter/sync/delisted:free')).pricing_status, 'unknown');
  assert.equal((await registryRow('openrouter/old/approved:free')).pricing_status, 'unknown', 'removed from the allowlist => demoted');
  assert.equal(await registryRow('openrouter/sync/not-approved:free'), undefined, 'feed models are never auto-approved');
  assert.equal((await registryRow(SEEDED_FREE_MODEL)).verification_source, 'seed', 'seed rows are untouched');
});

test('sync is all-or-nothing: a failure part-way writes nothing', async () => {
  const approved: ApprovedModel[] = [{ openRouterId: 'atomic/one:free' }, { openRouterId: 'atomic/two:free' }, { openRouterId: 'test-verified-free:free' }, { openRouterId: 'test-verified-paid' }];
  const feed = await fetchOpenRouterModels(fakeFetch(feedBody(approved.map((a) => ({ id: a.openRouterId, pricing: ZERO })))).impl);
  await withClient(async (c) => {
    let inserts = 0;
    const failing = new Proxy(c, {
      get(target, prop) {
        if (prop !== 'query') return Reflect.get(target, prop);
        return (sql: string, params?: unknown[]) => {
          if (/INSERT INTO models/.test(sql) && ++inserts === 2) return Promise.reject(new Error('simulated failure'));
          return target.query(sql, params);
        };
      },
    }) as PoolClient;
    await assert.rejects(syncOpenRouterPricing(failing, approved, feed, { dryRun: false }), /simulated failure/);
  });
  assert.equal(await registryRow('openrouter/atomic/one:free'), undefined);
});

test('end to end: a synced, approved free model can be used; the seeded placeholder still cannot', async () => {
  const approved: ApprovedModel[] = [{ openRouterId: 'e2e/free:free' }, { openRouterId: 'test-verified-free:free' }, { openRouterId: 'test-verified-paid' }];
  const feed = await fetchOpenRouterModels(fakeFetch(feedBody([
    { id: 'e2e/free:free', pricing: ZERO }, { id: 'test-verified-free:free', pricing: ZERO },
    { id: 'test-verified-paid', pricing: { prompt: '0.000003', completion: '0.000015' } },
  ])).impl);
  await withClient((c) => syncOpenRouterPricing(c, approved, feed, { dryRun: false }));

  const W = await seedWorkspace(t, 'sync-e2e');
  const base = `/api/v1/tenants/${W.tenantId}`;
  const models = Object.fromEntries((await call(t, 'GET', `${base}/models`, { session: W.owner })).json().data.map((m: { modelId: string }) => [m.modelId, m]));
  assert.deepEqual([models['openrouter/e2e/free:free'].allowed, models['openrouter/e2e/free:free'].verificationSource], [true, 'trusted']);
  assert.equal(models[SEEDED_FREE_MODEL].allowed, false);

  const agent = await call(t, 'POST', `${base}/agents`, { session: W.owner, payload: { name: 'synced', providerConnectionId: W.providerConnectionId, modelId: 'openrouter/e2e/free:free', requiresApproval: false } });
  assert.equal(agent.statusCode, 201, agent.body);
  const task = await submitTask(t, W.owner, W.tenantId, agent.json().data.id, 'sync-e2e-1');
  assert.equal(task.json().data.status, 'succeeded');
  assert.equal(t.adapter.submissions.at(-1)!.modelId, 'openrouter/e2e/free:free');
});
