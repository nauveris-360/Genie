import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createUser, freshDatabase, ORIGIN, startApp, teardown, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, resetConfigForTests } from '../../src/config.js';
import { clientKey } from '../../src/lib/clientKey.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

const GOOD = 'correct-horse-battery-staple';
const PAIR_LIMIT = 5;
const IP_LIMIT = 20;

function attempt(app: FastifyInstance, email: string, password: string, remoteAddress: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, headers: { origin: ORIGIN, ...headers }, payload: { email, password } });
}

test('configured limits are the documented defaults', () => {
  const c = loadConfig();
  assert.equal(c.loginMaxFailuresPerIpAccount, PAIR_LIMIT);
  assert.equal(c.loginMaxFailuresPerIp, IP_LIMIT);
  assert.equal(c.loginRateLimitWindowSeconds, 900);
  assert.deepEqual(c.trustedProxies, [], 'no proxy is trusted unless configured');
});

test('repeated failures for one account from one address are bounded; 429 carries Retry-After and is generic', async () => {
  await createUser('rl-alice@example.com');
  const attacker = '198.51.100.10';
  for (let i = 0; i < PAIR_LIMIT; i++) {
    const r = await attempt(t.app, 'rl-alice@example.com', `wrong-${i}`, attacker);
    assert.equal(r.statusCode, 401, `attempt ${i + 1}`);
  }
  const limited = await attempt(t.app, 'rl-alice@example.com', 'wrong-x', attacker);
  assert.equal(limited.statusCode, 429);
  const retryAfter = Number(limited.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900, `Retry-After=${limited.headers['retry-after']}`);
  const body = limited.json();
  assert.equal(body.error.code, 'rate_limited');
  assert.equal(body.error.message, 'Too many sign-in attempts. Try again later.');
  assert.equal(body.error.retryAfterSeconds, retryAfter);
  assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(limited.cookies.length, 0);

  // Not a password oracle: the correct password is refused too while limited, with the identical response.
  const correctWhileLimited = await attempt(t.app, 'rl-alice@example.com', GOOD, attacker);
  assert.equal(correctWhileLimited.statusCode, 429);
  assert.equal(correctWhileLimited.json().error.message, body.error.message);
  assert.equal(correctWhileLimited.cookies.length, 0, 'no session while limited');

  // Limited attempts do not consume budget: the bucket stays at the limit, not above it.
  const { rows } = await getPool().query(`SELECT count FROM rate_limit_buckets WHERE key LIKE $1`, [`login:pair:${attacker}:%`]);
  assert.equal(rows[0].count, PAIR_LIMIT);
});

test('no lockout DoS: an attacker exhausting one address cannot lock the account for the user elsewhere', async () => {
  await createUser('rl-victim@example.com');
  for (let i = 0; i < PAIR_LIMIT + 3; i++) await attempt(t.app, 'rl-victim@example.com', 'wrong', '198.51.100.20');
  assert.equal((await attempt(t.app, 'rl-victim@example.com', 'wrong', '198.51.100.20')).statusCode, 429);

  const victim = await attempt(t.app, 'rl-victim@example.com', GOOD, '192.0.2.50');
  assert.equal(victim.statusCode, 200, 'the legitimate user at their own address signs in');
  // Many attacker addresses, each within its own budget, still never block the victim's address.
  for (let n = 21; n <= 30; n++) {
    for (let i = 0; i < PAIR_LIMIT; i++) await attempt(t.app, 'rl-victim@example.com', 'wrong', `198.51.100.${n}`);
  }
  assert.equal((await attempt(t.app, 'rl-victim@example.com', GOOD, '192.0.2.50')).statusCode, 200);
});

test('unknown accounts are limited identically (no account enumeration through 429s)', async () => {
  await createUser('rl-real@example.com');
  const src = '198.51.100.40';
  const run = async (email: string) => {
    const codes: number[] = [];
    for (let i = 0; i <= PAIR_LIMIT; i++) codes.push((await attempt(t.app, email, 'wrong', src)).statusCode);
    return codes;
  };
  const real = await run('rl-real@example.com');
  const ghost = await run('rl-nobody@example.com');
  assert.deepEqual(real, [401, 401, 401, 401, 401, 429]);
  assert.deepEqual(ghost, real);
});

test('per-address bound across many accounts stops credential stuffing from one source', async () => {
  const src = '198.51.100.60';
  const codes: number[] = [];
  for (let i = 0; i < IP_LIMIT + 5; i++) codes.push((await attempt(t.app, `stuff-${i}@example.com`, 'wrong', src)).statusCode);
  assert.equal(codes.filter((c) => c === 401).length, IP_LIMIT, 'exactly IP_LIMIT failures are evaluated');
  assert.ok(codes.slice(IP_LIMIT).every((c) => c === 429));
  await createUser('rl-stuffed@example.com');
  assert.equal((await attempt(t.app, 'rl-stuffed@example.com', GOOD, src)).statusCode, 429, 'the exhausted address is limited for every account');
  assert.equal((await attempt(t.app, 'rl-stuffed@example.com', GOOD, '198.51.100.61')).statusCode, 200, 'other addresses are unaffected');
});

test('concurrent failures cannot race past the limit', async () => {
  await createUser('rl-race@example.com');
  const results = await Promise.all(Array.from({ length: 15 }, () => attempt(t.app, 'rl-race@example.com', 'wrong', '198.51.100.70')));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, PAIR_LIMIT, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 15 - PAIR_LIMIT);
});

test('only failures count: success clears the account bucket and does not spend the address budget', async () => {
  await createUser('rl-bob@example.com');
  const src = '198.51.100.80';
  for (let i = 0; i < PAIR_LIMIT - 1; i++) assert.equal((await attempt(t.app, 'rl-bob@example.com', 'wrong', src)).statusCode, 401);
  assert.equal((await attempt(t.app, 'rl-bob@example.com', GOOD, src)).statusCode, 200);
  for (let i = 0; i < PAIR_LIMIT; i++) assert.equal((await attempt(t.app, 'rl-bob@example.com', 'wrong', src)).statusCode, 401, `post-success failure ${i + 1}`);
  assert.equal((await attempt(t.app, 'rl-bob@example.com', 'wrong', src)).statusCode, 429);

  await createUser('rl-office@example.com');
  for (let i = 0; i < IP_LIMIT + 5; i++) {
    assert.equal((await attempt(t.app, 'rl-office@example.com', GOOD, '198.51.100.81')).statusCode, 200, `success ${i + 1}`);
  }
});

test('limits expire with the window', async () => {
  await createUser('rl-later@example.com');
  const src = '198.51.100.90';
  for (let i = 0; i < PAIR_LIMIT; i++) await attempt(t.app, 'rl-later@example.com', 'wrong', src);
  assert.equal((await attempt(t.app, 'rl-later@example.com', GOOD, src)).statusCode, 429);
  await getPool().query(`UPDATE rate_limit_buckets SET window_start = now() - interval '901 seconds' WHERE key LIKE $1`, [`login:%${src}%`]);
  assert.equal((await attempt(t.app, 'rl-later@example.com', GOOD, src)).statusCode, 200);
});

test('without a trusted proxy, X-Forwarded-For is ignored and cannot be rotated to escape the limit', async () => {
  await createUser('rl-spoof@example.com');
  const codes: number[] = [];
  for (let i = 0; i <= PAIR_LIMIT; i++) {
    codes.push((await attempt(t.app, 'rl-spoof@example.com', 'wrong', '198.51.100.100', { 'x-forwarded-for': `203.0.113.${i}` })).statusCode);
  }
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
});

test('behind a trusted proxy, the real client is the right-most untrusted X-Forwarded-For hop', async () => {
  const saved = process.env.TRUSTED_PROXIES;
  process.env.TRUSTED_PROXIES = '10.0.0.0/8';
  resetConfigForTests();
  const proxied = await buildApp({ logger: false });
  try {
    await createUser('rl-proxy@example.com');
    const proxy = '10.1.2.3';
    // Rotating a spoofed left-most entry does not change the identified client (203.0.113.7).
    const codes: number[] = [];
    for (let i = 0; i <= PAIR_LIMIT; i++) {
      codes.push((await attempt(proxied, 'rl-proxy@example.com', 'wrong', proxy, { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.7` })).statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    // A different real client behind the same proxy has its own budget.
    assert.equal((await attempt(proxied, 'rl-proxy@example.com', GOOD, proxy, { 'x-forwarded-for': '203.0.113.8' })).statusCode, 200);
    // A request NOT from the trusted proxy cannot use X-Forwarded-For to claim another identity.
    const direct: number[] = [];
    for (let i = 0; i <= PAIR_LIMIT; i++) {
      direct.push((await attempt(proxied, 'rl-proxy@example.com', 'wrong', '198.51.100.110', { 'x-forwarded-for': `203.0.113.${50 + i}` })).statusCode);
    }
    assert.deepEqual(direct, [401, 401, 401, 401, 401, 429]);
  } finally {
    await proxied.close();
    if (saved === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = saved;
    resetConfigForTests();
  }
});

test('IPv6 clients are grouped by /64 so address rotation inside a subnet does not reset the budget', async () => {
  assert.equal(clientKey('2001:db8::1'), clientKey('2001:db8:0:0:ffff::2'));
  assert.notEqual(clientKey('2001:db8::1'), clientKey('2001:db8:0:1::1'));
  assert.equal(clientKey('::ffff:192.0.2.1'), '192.0.2.1');
  await createUser('rl-v6@example.com');
  const codes: number[] = [];
  for (let i = 1; i <= PAIR_LIMIT + 1; i++) codes.push((await attempt(t.app, 'rl-v6@example.com', 'wrong', `2001:db8::${i}`)).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  assert.equal((await attempt(t.app, 'rl-v6@example.com', GOOD, '2001:db8:0:1::1')).statusCode, 200, 'a different /64 is unaffected');
});

test('bad TRUSTED_PROXIES configuration fails at startup instead of silently trusting everyone', () => {
  const saved = process.env.TRUSTED_PROXIES;
  try {
    for (const bad of ['*', 'true', '10.0.0.0/33', 'proxy.example.com']) {
      process.env.TRUSTED_PROXIES = bad;
      resetConfigForTests();
      assert.throws(() => loadConfig(), /TRUSTED_PROXIES/, bad);
    }
  } finally {
    if (saved === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = saved;
    resetConfigForTests();
  }
});
