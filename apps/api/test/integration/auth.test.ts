import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, createUser, createTenant, freshDatabase, login, ORIGIN, startApp, teardown, type TestApp } from './helpers.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

test('login sets HttpOnly session cookie + readable CSRF cookie, me/logout round-trip', async () => {
  const userId = await createUser('alice@example.com');
  await createTenant('Alice Co', userId);
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'alice@example.com', password: 'correct-horse-battery-staple' } });
  assert.equal(res.statusCode, 200);
  const sid = res.cookies.find((c) => c.name === 'genie_sid')!;
  const csrf = res.cookies.find((c) => c.name === 'genie_csrf')!;
  assert.equal(sid.httpOnly, true);
  assert.equal(csrf.httpOnly, undefined);
  assert.equal(sid.sameSite, 'Lax');
  assert.equal(res.json().data.user.email, 'alice@example.com');
  assert.equal(res.json().data.memberships[0].role, 'owner');
  // no token material is in the body
  assert.doesNotMatch(res.body, new RegExp(sid.value));

  const session = await login(t, 'alice@example.com');
  const me = await call(t, 'GET', '/api/v1/auth/me', { session });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().data.user.id, userId);

  const out = await call(t, 'POST', '/api/v1/auth/logout', { session });
  assert.equal(out.statusCode, 200);
  const after = await call(t, 'GET', '/api/v1/auth/me', { session });
  assert.equal(after.statusCode, 401);
});

test('wrong password and unknown user return the same generic 401', async () => {
  await createUser('bob@example.com');
  const a = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'bob@example.com', password: 'nope-nope-nope' } });
  const b = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'nobody@example.com', password: 'nope-nope-nope' } });
  assert.equal(a.statusCode, 401); assert.equal(b.statusCode, 401);
  assert.equal(a.json().error.code, 'invalid_credentials');
  assert.equal(a.json().error.message, b.json().error.message);
});

test('login-CSRF: missing, untrusted, malformed Origin are rejected; Referer fallback is honoured', async () => {
  await createUser('carol@example.com');
  const body = { email: 'carol@example.com', password: 'correct-horse-battery-staple' };
  const missing = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body });
  assert.equal(missing.statusCode, 403); assert.equal(missing.json().error.code, 'forbidden');
  const evil = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://evil.example' }, payload: body });
  assert.equal(evil.statusCode, 403);
  const nullOrigin = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'null' }, payload: body });
  assert.equal(nullOrigin.statusCode, 403);
  const malformed = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'not a url' }, payload: body });
  assert.equal(malformed.statusCode, 403);
  const refererOk = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { referer: `${ORIGIN}/login` }, payload: body });
  assert.equal(refererOk.statusCode, 200);
  const refererBad = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { referer: 'https://evil.example/x' }, payload: body });
  assert.equal(refererBad.statusCode, 403);
  // no session is created on a rejected attempt
  const { rows } = await (await import('../../src/db/index.js')).getPool().query('SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1', ['carol@example.com']);
  assert.equal(rows[0].n, 1);
});

test('authenticated writes require a CSRF header that matches the session', async () => {
  const uid = await createUser('dave@example.com');
  await createTenant('Dave Co', uid);
  const session = await login(t, 'dave@example.com');
  const noHeader = await call(t, 'POST', '/api/v1/tenants', { session, csrf: false, payload: { name: 'X' } });
  assert.equal(noHeader.statusCode, 403); assert.equal(noHeader.json().error.code, 'csrf_mismatch');
  const wrong = await call(t, 'POST', '/api/v1/tenants', { session: { ...session, csrf: 'deadbeef' }, payload: { name: 'X' } });
  assert.equal(wrong.statusCode, 403);
  const other = await login(t, 'dave@example.com');
  const foreign = await call(t, 'POST', '/api/v1/tenants', { session: { ...session, csrf: other.csrf }, payload: { name: 'X' } });
  assert.equal(foreign.statusCode, 403, 'a valid CSRF token from a different session must not work');
  const badOrigin = await call(t, 'POST', '/api/v1/tenants', { session, origin: 'https://evil.example', payload: { name: 'X' } });
  assert.equal(badOrigin.statusCode, 403);
  const ok = await call(t, 'POST', '/api/v1/tenants', { session, payload: { name: 'X' } });
  assert.equal(ok.statusCode, 201);
  const get = await call(t, 'GET', '/api/v1/tenants', { session, csrf: false });
  assert.equal(get.statusCode, 200, 'GET never needs CSRF');
});

test('expired and tampered session cookies are rejected', async () => {
  const uid = await createUser('erin@example.com');
  await createTenant('Erin Co', uid);
  const session = await login(t, 'erin@example.com');
  await (await import('../../src/db/index.js')).getPool().query('UPDATE sessions SET expires_at = now() - interval \'1 minute\'');
  assert.equal((await call(t, 'GET', '/api/v1/auth/me', { session })).statusCode, 401);
  const tampered = { ...session, cookie: 'genie_sid=0000; genie_csrf=' + session.csrf };
  assert.equal((await call(t, 'GET', '/api/v1/auth/me', { session: tampered })).statusCode, 401);
});

test('validation errors use the error envelope and never leak internals', async () => {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'not-an-email', password: 'x' } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.code, 'validation_error');
  assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(res.body, /stack|node_modules/);
});
