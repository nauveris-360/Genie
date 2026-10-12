import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, freshDatabase, ORIGIN, seedWorkspace, startApp, teardown, type TestApp } from './helpers.js';
import { canonicalJson, payloadDigest } from '../../src/lib/digest.js';
import { scrubObject } from '../../src/lib/redaction.js';
import { getPool } from '../../src/db/index.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import { AppError } from '../../src/lib/errors.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

/** Keys that object-rebuilding canonicalizers mishandle: prototype-ish names and integer-like keys. */
const SPECIAL_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '10', '9', '0', '-1', '1.5', ''];
const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
const withKey = (key: string, value: unknown) => parse(`{"prompt":"p",${JSON.stringify(key)}:${JSON.stringify(value)}}`);

test('reviewer reproduction: inputs differing only under "__proto__" canonicalize and hash differently', () => {
  const a = parse('{"input":{"__proto__":{"scope":"original"}}}');
  const b = parse('{"input":{"__proto__":{"scope":"changed"}}}');
  assert.equal(canonicalJson(a), '{"input":{"__proto__":{"scope":"original"}}}');
  assert.equal(canonicalJson(b), '{"input":{"__proto__":{"scope":"changed"}}}');
  assert.notEqual(payloadDigest(a), payloadDigest(b));
});

test('every own JSON key is preserved and bound into the digest, at the top level, nested and inside arrays', () => {
  for (const key of SPECIAL_KEYS) {
    const a = withKey(key, { scope: 'original' });
    const b = withKey(key, { scope: 'changed' });
    assert.ok(canonicalJson(a).includes(`${JSON.stringify(key)}:{"scope":"original"}`), `key ${JSON.stringify(key)} missing: ${canonicalJson(a)}`);
    assert.notEqual(payloadDigest(a), payloadDigest(b), `top-level ${JSON.stringify(key)}`);
    assert.notEqual(payloadDigest({ input: { nested: a } }), payloadDigest({ input: { nested: b } }), `nested ${JSON.stringify(key)}`);
    assert.notEqual(payloadDigest({ list: [1, a] }), payloadDigest({ list: [1, b] }), `in array ${JSON.stringify(key)}`);
    // adding the key at all must change the digest
    assert.notEqual(payloadDigest(parse('{"prompt":"p"}')), payloadDigest(a), `presence of ${JSON.stringify(key)}`);
    // canonical output is valid JSON that parses back to the same own keys
    assert.deepEqual(JSON.parse(canonicalJson(a)), a);
  }
});

/** Frozen copy of the feb1351 algorithm, the v1 digest format. Only differs from the fix on "__proto__" keys, which it dropped. */
function legacyCanonical(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = sortKeys((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

test('integer-key compatibility: v1 ordering (array-index keys numerically first, then code-unit order) is preserved', () => {
  const text1 = '{"b":1,"10":2,"9":3,"a":4,"__proto__":5,"Z":6,"é":7,"-1":8,"1.5":9,"01":10,"4294967294":11,"4294967295":12,"constructor":{"y":1,"x":2,"2":3,"10":4}}';
  const text2 = '{"constructor":{"10":4,"2":3,"x":2,"y":1},"4294967295":12,"4294967294":11,"01":10,"1.5":9,"-1":8,"é":7,"Z":6,"__proto__":5,"a":4,"9":3,"10":2,"b":1}';
  const expected = '{"9":3,"10":2,"4294967294":11,"-1":8,"01":10,"1.5":9,"4294967295":12,"Z":6,"__proto__":5,"a":4,"b":1,"constructor":{"2":3,"10":4,"x":2,"y":1},"é":7}';
  assert.equal(canonicalJson(parse(text1)), expected);
  assert.equal(canonicalJson(parse(text2)), expected, 'input key order is irrelevant');
  assert.equal(payloadDigest(parse(text1)), payloadDigest(parse(text2)));
});

test('integer-key compatibility: hashes computed by the feb1351 implementation are reproduced exactly', () => {
  // Reference values produced by running the feb1351 digest.ts unmodified.
  const numeric = parse('{"agentId":"77777777-7777-4777-8777-777777777771","input":{"10":"ten","9":"nine","prompt":"p","b":[{"2":"x","1":"y"}],"a":1},"tenantId":"44444444-4444-4444-8444-444444444444","type":"chat","websiteId":null}');
  assert.equal(canonicalJson(numeric), '{"agentId":"77777777-7777-4777-8777-777777777771","input":{"9":"nine","10":"ten","a":1,"b":[{"1":"y","2":"x"}],"prompt":"p"},"tenantId":"44444444-4444-4444-8444-444444444444","type":"chat","websiteId":null}');
  assert.equal(payloadDigest(numeric), 'fc6a6b8127eff2f4542fd0ecf38298b170b28aef81fa5e95d031c714a31065e3');
  const mixed = parse('{"b":1,"10":2,"9":3,"a":4,"Z":6,"é":7,"-1":8,"1.5":9,"01":10,"4294967294":11,"4294967295":12,"constructor":{"y":1,"x":2,"2":3,"10":4}}');
  assert.equal(payloadDigest(mixed), 'ebc1c7005a905ca3c1c0246d2274da96f61e64ac8165dfbd8657027ff0838ee9');
});

test('the fix is byte-identical to the v1 algorithm for every payload without a "__proto__" key', () => {
  const corpus = [
    '{}', '[]', 'null', '"s"', '0', '{"a":{"b":{"c":[1,{"z":1,"y":[{"x":0}]}]}}}',
    '{"10":1,"9":2,"0":3,"-0":4,"00":5,"1e2":6,"4294967294":7,"4294967295":8,"":9}',
    '{"constructor":{"prototype":{"x":1}},"toString":1,"hasOwnProperty":2,"valueOf":3,"__defineGetter__":4}',
    '{"s":"quote \\" backslash \\\\ nl \\n \\u2028 \\ud83d\\ude00","n":[0,-0,0.1,1e21,-1.5e-7],"b":[true,false,null]}',
    '{"é":1,"e":2,"E":3,"😀":4,"￿":5}',
  ];
  for (const text of corpus) {
    assert.equal(canonicalJson(JSON.parse(text)), legacyCanonical(JSON.parse(text)), text);
  }
  assert.equal(canonicalJson({ a: undefined, b: [undefined, () => 1, 1], c: Symbol('s') }), legacyCanonical({ a: undefined, b: [undefined, () => 1, 1], c: Symbol('s') }));
  // ...and the only divergence is the defect itself:
  const poisoned = parse('{"input":{"__proto__":{"scope":"original"}}}');
  assert.equal(legacyCanonical(poisoned), '{"input":{}}');
  assert.equal(canonicalJson(poisoned), '{"input":{"__proto__":{"scope":"original"}}}');
});

test('digests of ordinary payloads are unchanged by the fix (existing approvals stay valid)', () => {
  const payload = {
    agentId: '77777777-7777-4777-8777-777777777771',
    input: { prompt: 'Post this reply to the live ticket.', options: { b: 2, a: 1 } },
    tenantId: '44444444-4444-4444-8444-444444444444',
    type: 'chat',
    websiteId: null,
  };
  assert.equal(payloadDigest(payload), '13a3614698b7a3f721234f372b8ee6a0d59afb6b5a7d59053b7fa4e6151dfffd');
});

test('redaction keeps a "__proto__" key as data (scrubbed), never as the result prototype', () => {
  const out = scrubObject(parse('{"__proto__":{"password":"hunter2","x":1},"ok":2}'));
  assert.equal(JSON.stringify(out), '{"__proto__":{"password":"[redacted]","x":1},"ok":2}');
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, '__proto__'));
});

async function setStoredInput(tenantId: string, taskId: string, jsonText: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query('UPDATE tasks SET input = $2::jsonb WHERE id = $1', [taskId, jsonText]);
    await client.query('COMMIT');
  } finally { client.release(); }
}

const MUTATIONS: Array<{ name: string; before: string; after: string }> = [
  { name: '__proto__ value changed', before: '{"prompt":"p","__proto__":{"scope":"original"}}', after: '{"prompt":"p","__proto__":{"scope":"changed"}}' },
  { name: '__proto__ key added', before: '{"prompt":"p"}', after: '{"prompt":"p","__proto__":{"scope":"admin"}}' },
  { name: 'constructor.prototype changed', before: '{"prompt":"p","constructor":{"prototype":{"role":"viewer"}}}', after: '{"prompt":"p","constructor":{"prototype":{"role":"owner"}}}' },
  { name: 'integer-like key changed', before: '{"prompt":"p","10":"ten","9":"nine"}', after: '{"prompt":"p","10":"TEN","9":"nine"}' },
  { name: 'nested __proto__ in array changed', before: '{"steps":[{"__proto__":{"to":"a@example.com"}}]}', after: '{"steps":[{"__proto__":{"to":"evil@example.com"}}]}' },
];

test('approvals: tampering with __proto__/constructor/integer-like keys in the stored payload is detected', async () => {
  const W = await seedWorkspace(t, 'canon-appr', true);
  const service = new TaskService(t.adapter);
  for (const [i, m] of MUTATIONS.entries()) {
    const { task } = await service.submit({ tenantId: W.tenantId, userId: W.ownerId, idempotencyKey: `mut-${i}`, agentId: W.agentId, type: 'chat', input: parse(m.before) });
    assert.equal(task.status, 'awaiting_approval', m.name);
    await setStoredInput(W.tenantId, task.id, m.after);
    const res = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
    assert.equal(res.statusCode, 409, `${m.name}: ${res.body}`);
    assert.equal(res.json().error.code, 'approval_payload_mismatch', m.name);
    const after = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks/${task.id}`, { session: W.owner })).json().data;
    assert.equal(after.status, 'awaiting_approval', m.name);
    assert.equal(t.adapter.submissions.filter((s) => s.taskId === task.id).length, 0, `${m.name}: must not execute`);
  }
});

test('approvals: unmodified payloads with these keys round-trip through jsonb and approve normally', async () => {
  const W = await seedWorkspace(t, 'canon-ok', true);
  const service = new TaskService(t.adapter);
  for (const [i, m] of MUTATIONS.entries()) {
    const input = parse(m.before);
    const { task } = await service.submit({ tenantId: W.tenantId, userId: W.ownerId, idempotencyKey: `ok-${i}`, agentId: W.agentId, type: 'chat', input });
    const res = await call(t, 'POST', `/api/v1/tenants/${W.tenantId}/approvals/${task.approvalId}/decision`, { session: W.owner, payload: { decision: 'approve' } });
    assert.equal(res.statusCode, 200, `${m.name}: ${res.body}`);
    const sent = t.adapter.submissions.find((s) => s.taskId === task.id);
    assert.ok(sent, `${m.name}: executed after approval`);
    assert.equal(canonicalJson(sent.input), canonicalJson(input), `${m.name}: adapter received the exact approved payload`);
  }
  const stored = await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks?limit=100`, { session: W.owner });
  assert.match(stored.body, /"__proto__":\{"scope":"original"\}/, 'API returns the __proto__ key as data');
});

test('idempotency: a reused key with a payload differing only in these keys is a conflict, not a replay', async () => {
  const W = await seedWorkspace(t, 'canon-idem', true);
  const service = new TaskService(t.adapter);
  const isConflict = (e: unknown) => e instanceof AppError && e.code === 'idempotency_key_conflict';
  for (const [i, m] of MUTATIONS.entries()) {
    const key = `idem-${i}`;
    const first = await service.submit({ tenantId: W.tenantId, userId: W.ownerId, idempotencyKey: key, agentId: W.agentId, type: 'chat', input: parse(m.before) });
    assert.equal(first.created, true, m.name);
    await assert.rejects(service.submit({ tenantId: W.tenantId, userId: W.ownerId, idempotencyKey: key, agentId: W.agentId, type: 'chat', input: parse(m.after) }), isConflict, m.name);
    const replay = await service.submit({ tenantId: W.tenantId, userId: W.ownerId, idempotencyKey: key, agentId: W.agentId, type: 'chat', input: parse(m.before) });
    assert.equal(replay.created, false, m.name);
    assert.equal(replay.task.id, first.task.id, m.name);
  }
});

test('idempotency over HTTP: constructor and integer-like keys are bound; key order is not', async () => {
  const W = await seedWorkspace(t, 'canon-http', true);
  const url = `/api/v1/tenants/${W.tenantId}/tasks`;
  const post = (key: string, inputText: string) => t.app.inject({
    method: 'POST', url,
    headers: { origin: ORIGIN, cookie: W.owner.cookie, 'x-csrf-token': W.owner.csrf, 'idempotency-key': key, 'content-type': 'application/json' },
    payload: `{"agentId":"${W.agentId}","type":"chat","input":${inputText}}`,
  });

  const c1 = await post('http-ctor', '{"prompt":"p","constructor":{"name":"a"}}');
  assert.equal(c1.statusCode, 202, c1.body);
  const c2 = await post('http-ctor', '{"prompt":"p","constructor":{"name":"b"}}');
  assert.equal(c2.statusCode, 409); assert.equal(c2.json().error.code, 'idempotency_key_conflict');

  const n1 = await post('http-num', '{"10":"ten","9":"nine","prompt":"p"}');
  assert.equal(n1.statusCode, 202, n1.body);
  const reordered = await post('http-num', '{"prompt":"p","9":"nine","10":"ten"}');
  assert.equal(reordered.statusCode, 202); assert.equal(reordered.json().data.id, n1.json().data.id, 'same content, different key order = same request');
  const n2 = await post('http-num', '{"10":"TEN","9":"nine","prompt":"p"}');
  assert.equal(n2.statusCode, 409); assert.equal(n2.json().error.code, 'idempotency_key_conflict');
});

test('HTTP bodies carrying __proto__ or constructor.prototype are rejected outright, never silently stripped', async () => {
  const W = await seedWorkspace(t, 'canon-poison', true);
  const before = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks`, { session: W.owner })).json().data.length;
  for (const inputText of ['{"prompt":"p","__proto__":{"scope":"x"}}', '{"prompt":"p","constructor":{"prototype":{"scope":"x"}}}', '{"prompt":"p","deep":[{"__proto__":{}}]}']) {
    const res = await t.app.inject({
      method: 'POST', url: `/api/v1/tenants/${W.tenantId}/tasks`,
      headers: { origin: ORIGIN, cookie: W.owner.cookie, 'x-csrf-token': W.owner.csrf, 'idempotency-key': `poison-${inputText.length}`, 'content-type': 'application/json' },
      payload: `{"agentId":"${W.agentId}","type":"chat","input":${inputText}}`,
    });
    assert.equal(res.statusCode, 400, inputText);
    assert.equal(res.json().error.code, 'validation_error', inputText);
  }
  const afterCount = (await call(t, 'GET', `/api/v1/tenants/${W.tenantId}/tasks`, { session: W.owner })).json().data.length;
  assert.equal(afterCount, before, 'no task row created');
});
