import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { call, freshDatabase, seedWorkspace, startApp, submitTask, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';
import { decryptSecret, encryptSecret } from '../../src/crypto/secretBox.js';
import { loadConfig } from '../../src/config.js';
import { scrubObject } from '../../src/lib/redaction.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

test('provider credential never appears in any response, audit row, or task result', async () => {
  const W = await seedWorkspace(t, 'sec');
  const secret = W.credential;
  const base = `/api/v1/tenants/${W.tenantId}`;

  for (const url of [`${base}/providers`, `${base}/agents`, `${base}/audit-events`, `${base}/models`, `${base}/tasks`]) {
    const res = await call(t, 'GET', url, { session: W.owner });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, new RegExp(secret), `${url} leaked the credential`);
    assert.doesNotMatch(res.body, /encrypted_credential|encryptedCredential/, `${url} exposed ciphertext column`);
  }
  const providers = (await call(t, 'GET', `${base}/providers`, { session: W.owner })).json().data;
  assert.deepEqual(Object.keys(providers[0]).sort(), ['createdAt', 'credentialStatus', 'id', 'label', 'provider', 'tenantId', 'updatedAt']);
  assert.equal(providers[0].credentialStatus, 'present');

  const task = (await submitTask(t, W.owner, W.tenantId, W.agentId, 'sec-1', { prompt: 'hi', apiKey: 'should-be-scrubbed-in-result' })).json().data;
  assert.equal(task.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(task.result), new RegExp(secret));
  // the adapter did receive the real decrypted credential for this tenant and nothing else
  assert.equal(t.adapter.submissions.length, 1);
  assert.equal(t.adapter.submissions[0]!.credential, secret);
  assert.equal(t.adapter.submissions[0]!.tenantId, W.tenantId);

  const audit = (await call(t, 'GET', `${base}/audit-events`, { session: W.owner })).json().data;
  assert.ok(audit.some((e: { action: string }) => e.action === 'provider.credential_saved'));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(secret));
});

test('credential is encrypted at rest with the external key; wrong key cannot decrypt', async () => {
  const W = await seedWorkspace(t, 'sec2');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [W.tenantId]);
    const { rows } = await client.query<{ encrypted_credential: Buffer }>('SELECT encrypted_credential FROM provider_connections WHERE tenant_id = $1', [W.tenantId]);
    await client.query('ROLLBACK');
    const blob = rows[0]!.encrypted_credential;
    assert.ok(Buffer.isBuffer(blob));
    assert.ok(!blob.toString('utf8').includes(W.credential), 'plaintext must not be stored');
    assert.equal(decryptSecret(blob, loadConfig().credentialEncryptionKey), W.credential);
    assert.throws(() => decryptSecret(blob, randomBytes(32).toString('base64')));
    // GCM is authenticated: a flipped byte fails rather than returning garbage
    const tampered = Buffer.from(blob); tampered[tampered.length - 1]! ^= 0x01;
    assert.throws(() => decryptSecret(tampered, loadConfig().credentialEncryptionKey));
    // distinct IVs per encryption
    assert.notDeepEqual(encryptSecret('x', loadConfig().credentialEncryptionKey), encryptSecret('x', loadConfig().credentialEncryptionKey));
  } finally { client.release(); }
});

test('redaction helper scrubs sensitive keys at any depth', () => {
  const out = scrubObject({ ok: 1, password: 'p', nested: { apiKey: 'k', list: [{ token: 't', fine: 'f' }], Authorization: 'Bearer x' } }) as Record<string, unknown>;
  assert.equal(out.password, '[redacted]');
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, '[redacted]');
  assert.equal(nested.Authorization, '[redacted]');
  assert.deepEqual(nested.list, [{ token: '[redacted]', fine: 'f' }]);
  assert.equal(out.ok, 1);
});

test('readiness never reports synthetic success for the unconfigured Hermes adapter', async () => {
  // Build a second app with the default (production-path) adapter selection.
  const { buildApp } = await import('../../src/app.js');
  const prod = await buildApp({ logger: false });
  const res = await prod.inject({ method: 'GET', url: '/api/v1/health/ready' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().data.status, 'degraded');
  assert.equal(res.json().data.checks.database.status, 'ok');
  assert.equal(res.json().data.checks.agentAdapter.status, 'unavailable');
  assert.match(res.json().data.checks.agentAdapter.detail, /Hermes/);
  const live = await prod.inject({ method: 'GET', url: '/api/v1/health/live' });
  assert.equal(live.statusCode, 200);
  await prod.close();
});
