import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, createUser, freshDatabase, login, memberSession, ORIGIN, seedWorkspace, startApp, teardown, type Session, type TestApp } from './helpers.js';
import { getPool } from '../../src/db/index.js';

let t: TestApp;
before(async () => { await freshDatabase(); t = await startApp(); });
after(async () => { await teardown(t); });

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;
const base = (W: { tenantId: string }) => `/api/v1/tenants/${W.tenantId}`;
const members = async (W: Workspace, s: Session = W.owner) => (await call(t, 'GET', `${base(W)}/members?limit=100`, { session: s })).json().data as Array<{ id: string; userId: string; email: string; role: string }>;
const membershipOf = async (W: Workspace, userId: string) => (await members(W)).find((m) => m.userId === userId)!;
const invite = (W: Workspace, s: Session, email: string, role: string) => call(t, 'POST', `${base(W)}/invitations`, { session: s, payload: { email, role } });
function accept(body: Record<string, unknown>, opts: { session?: Session; csrf?: boolean; origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    if (opts.csrf !== false) headers['x-csrf-token'] = opts.session.csrf;
  }
  return t.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers, payload: body, remoteAddress: opts.ip ?? '192.0.2.200' });
}

test('any member can list members; outsiders get 404', async () => {
  const W = await seedWorkspace(t, 'mem-list');
  const viewer = await memberSession(t, W.tenantId, 'viewer', 'mem-list');
  const list = await members(W, viewer);
  assert.deepEqual(list.map((m) => m.role).sort(), ['owner', 'viewer']);
  assert.ok(list.every((m) => m.email && m.id && m.userId));
  const other = await seedWorkspace(t, 'mem-list-other');
  assert.equal((await call(t, 'GET', `${base(W)}/members`, { session: other.owner })).statusCode, 404);
});

test('role changes follow the manageable-roles rules', async () => {
  const W = await seedWorkspace(t, 'mem-roles');
  const admin = await memberSession(t, W.tenantId, 'admin', 'mem-roles');
  const admin2 = await memberSession(t, W.tenantId, 'admin', 'mem-roles2');
  const operator = await memberSession(t, W.tenantId, 'operator', 'mem-roles');
  const viewer = await memberSession(t, W.tenantId, 'viewer', 'mem-roles');
  const id = async (s: Session) => (await membershipOf(W, s.userId)).id;
  const patch = (s: Session, membershipId: string, role: string) => call(t, 'PATCH', `${base(W)}/members/${membershipId}`, { session: s, payload: { role } });

  // admin: operator<->viewer only
  assert.equal((await patch(admin, await id(viewer), 'operator')).statusCode, 200);
  assert.equal((await patch(admin, await id(viewer), 'viewer')).statusCode, 200);
  assert.equal((await patch(admin, await id(viewer), 'admin')).statusCode, 403, 'admin cannot grant admin');
  assert.equal((await patch(admin, await id(viewer), 'owner')).statusCode, 403, 'admin cannot grant owner');
  assert.equal((await patch(admin, await id(admin2), 'viewer')).statusCode, 403, 'admin cannot demote another admin');
  assert.equal((await patch(admin, await id(W.owner), 'viewer')).statusCode, 403, 'admin cannot demote an owner');
  assert.equal((await patch(admin, await id(admin), 'owner')).statusCode, 403, 'admin cannot self-promote');
  // operator / viewer: nothing
  assert.equal((await patch(operator, await id(viewer), 'operator')).statusCode, 403);
  assert.equal((await patch(viewer, await id(viewer), 'admin')).statusCode, 403);
  // owner: anything
  assert.equal((await patch(W.owner, await id(operator), 'admin')).statusCode, 200);
  assert.equal((await patch(W.owner, await id(admin2), 'owner')).statusCode, 200);
  assert.equal((await membershipOf(W, admin2.userId)).role, 'owner');
  // validation + unknown id
  assert.equal((await patch(W.owner, await id(viewer), 'superuser')).statusCode, 400);
  assert.equal((await patch(W.owner, '00000000-0000-4000-8000-000000000000', 'viewer')).statusCode, 404);
  // the new role takes effect immediately: viewer promoted to operator can now write
  await patch(W.owner, await id(viewer), 'operator');
  assert.equal((await call(t, 'POST', `${base(W)}/websites`, { session: viewer, payload: { label: 'x', url: 'https://x.example' } })).statusCode, 201);
  const audit = (await call(t, 'GET', `${base(W)}/audit-events?limit=100`, { session: W.owner })).json().data;
  assert.ok(audit.some((e: { action: string }) => e.action === 'member.role_changed'));
});

test('a tenant can never lose its last owner, even under concurrent changes', async () => {
  const W = await seedWorkspace(t, 'mem-owner');
  const ownerId = (await membershipOf(W, W.ownerId)).id;
  const r1 = await call(t, 'PATCH', `${base(W)}/members/${ownerId}`, { session: W.owner, payload: { role: 'admin' } });
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().error.code, 'last_owner');
  const r2 = await call(t, 'DELETE', `${base(W)}/members/${ownerId}`, { session: W.owner });
  assert.equal(r2.statusCode, 409); assert.equal(r2.json().error.code, 'last_owner');

  const second = await memberSession(t, W.tenantId, 'owner', 'mem-owner-second');
  const secondId = (await membershipOf(W, second.userId)).id;
  const [a, b] = await Promise.all([
    call(t, 'PATCH', `${base(W)}/members/${secondId}`, { session: W.owner, payload: { role: 'viewer' } }),
    call(t, 'PATCH', `${base(W)}/members/${ownerId}`, { session: second, payload: { role: 'viewer' } }),
  ]);
  // Exactly one wins. The loser gets 409 last_owner, or 403 if it was re-authorized after
  // the winner had already demoted it (its role is re-read under the lock).
  const codes = [a.statusCode, b.statusCode].sort();
  assert.equal(codes[0], 200, `${a.statusCode} ${b.statusCode}`);
  assert.ok(codes[1] === 403 || codes[1] === 409, `${a.statusCode} ${b.statusCode}`);
  const owners = (await getPool().query(`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [W.tenantId])).rows[0].n;
  assert.equal(owners, 1);
});

test('removing a member revokes their access on the next request', async () => {
  const W = await seedWorkspace(t, 'mem-remove');
  const operator = await memberSession(t, W.tenantId, 'operator', 'mem-remove');
  assert.equal((await call(t, 'GET', `${base(W)}/tasks`, { session: operator })).statusCode, 200);
  const del = await call(t, 'DELETE', `${base(W)}/members/${(await membershipOf(W, operator.userId)).id}`, { session: W.owner });
  assert.equal(del.statusCode, 200);
  assert.equal((await call(t, 'GET', `${base(W)}/tasks`, { session: operator })).statusCode, 404);
  assert.equal((await call(t, 'GET', '/api/v1/auth/me', { session: operator })).json().data.memberships.length, 0);
  const noCsrf = await call(t, 'DELETE', `${base(W)}/members/${(await membershipOf(W, W.ownerId)).id}`, { session: W.owner, csrf: false });
  assert.equal(noCsrf.statusCode, 403, 'DELETE requires CSRF');
});

test('invitations: token shown once and stored only as a hash; role rules; existing members; re-invite replaces', async () => {
  const W = await seedWorkspace(t, 'inv-create');
  const admin = await memberSession(t, W.tenantId, 'admin', 'inv-create');
  const operator = await memberSession(t, W.tenantId, 'operator', 'inv-create');

  const res = await invite(W, W.owner, 'new.person@example.com', 'operator');
  assert.equal(res.statusCode, 201, res.body);
  const { invitation, inviteToken } = res.json().data;
  assert.match(inviteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invitation.status, 'pending'); assert.equal(invitation.role, 'operator');
  assert.ok(Date.parse(invitation.expiresAt) - Date.now() > 6.9 * 86_400_000);
  const listed = await call(t, 'GET', `${base(W)}/invitations`, { session: W.owner });
  assert.doesNotMatch(listed.body, new RegExp(inviteToken), 'never shown again');
  const stored = (await getPool().query('SELECT token_hash FROM invitations WHERE id = $1', [invitation.id])).rows[0].token_hash;
  assert.notEqual(stored, inviteToken); assert.match(stored, /^[0-9a-f]{64}$/);

  assert.equal((await invite(W, admin, 'a@example.com', 'admin')).statusCode, 403, 'admin cannot invite admins');
  assert.equal((await invite(W, admin, 'b@example.com', 'owner')).statusCode, 403);
  assert.equal((await invite(W, admin, 'c@example.com', 'viewer')).statusCode, 201);
  assert.equal((await invite(W, operator, 'd@example.com', 'viewer')).statusCode, 403);
  assert.equal((await call(t, 'GET', `${base(W)}/invitations`, { session: operator })).statusCode, 403);
  const existing = await invite(W, W.owner, W.ownerEmail.toUpperCase(), 'viewer');
  assert.equal(existing.statusCode, 409); assert.equal(existing.json().error.code, 'already_member');

  const again = await invite(W, W.owner, 'New.Person@example.com', 'viewer');
  assert.equal(again.statusCode, 201);
  const old = await accept({ token: inviteToken, password: 'a-long-password-123' });
  assert.equal(old.statusCode, 400); assert.equal(old.json().error.code, 'invitation_invalid', 're-invite revoked the old link');
});

test('accept as a new person: creates the account, signs in, joins with the invited role; single use', async () => {
  const W = await seedWorkspace(t, 'inv-new');
  const { inviteToken } = (await invite(W, W.owner, 'fresh@example.com', 'viewer')).json().data;

  assert.equal((await accept({ token: inviteToken, password: 'a-long-password-123' }, { origin: null })).statusCode, 403, 'Origin is required');
  assert.equal((await accept({ token: inviteToken, password: 'a-long-password-123' }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await accept({ token: inviteToken })).statusCode, 400, 'password required for a new account');
  assert.equal((await accept({ token: inviteToken, password: 'short' })).statusCode, 400);

  const ok = await accept({ token: inviteToken, password: 'a-long-password-123', displayName: 'Fresh' });
  assert.equal(ok.statusCode, 200, ok.body);
  const me = ok.json().data;
  assert.equal(me.user.email, 'fresh@example.com'); assert.equal(me.user.displayName, 'Fresh');
  assert.deepEqual(me.memberships.map((m: { tenantId: string; role: string }) => [m.tenantId, m.role]), [[W.tenantId, 'viewer']]);
  assert.ok(ok.cookies.find((c) => c.name === 'genie_sid')?.httpOnly, 'signed in with a session cookie');

  const session = await login(t, 'fresh@example.com', 'a-long-password-123');
  assert.equal((await call(t, 'GET', `${base(W)}/tasks`, { session })).statusCode, 200);
  assert.equal((await call(t, 'POST', `${base(W)}/websites`, { session, payload: { label: 'x', url: 'https://x.example' } })).statusCode, 403, 'joined as viewer');

  const reuse = await accept({ token: inviteToken, password: 'another-long-password' });
  assert.equal(reuse.statusCode, 400); assert.equal(reuse.json().error.code, 'invitation_invalid');
  const audit = (await call(t, 'GET', `${base(W)}/audit-events?limit=100`, { session: W.owner })).json().data.map((e: { action: string }) => e.action);
  for (const a of ['invitation.created', 'invitation.accepted', 'member.joined']) assert.ok(audit.includes(a), a);
});

test('accept: concurrent use of one token succeeds exactly once', async () => {
  const W = await seedWorkspace(t, 'inv-race');
  const { inviteToken } = (await invite(W, W.owner, 'race@example.com', 'operator')).json().data;
  const results = await Promise.all([1, 2, 3, 4].map((i) => accept({ token: inviteToken, password: `a-long-password-${i}xx` }, { ip: `192.0.2.${210 + i}` })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.statusCode).join());
  const n = (await getPool().query(`SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email_normalized = 'race@example.com'`)).rows[0].n;
  assert.equal(n, 1);
});

test('accept as an existing account requires being signed in as exactly that account (with CSRF)', async () => {
  const W = await seedWorkspace(t, 'inv-existing');
  await createUser('existing@example.com');
  const other = await createUser('someone-else@example.com');
  assert.ok(other);
  const { inviteToken } = (await invite(W, W.owner, 'existing@example.com', 'operator')).json().data;

  const anon = await accept({ token: inviteToken, password: 'correct-horse-battery-staple' });
  assert.equal(anon.statusCode, 401, 'no password path for existing accounts: must sign in');
  const wrongUser = await login(t, 'someone-else@example.com');
  assert.equal((await accept({ token: inviteToken }, { session: wrongUser })).statusCode, 403);
  const right = await login(t, 'existing@example.com');
  const noCsrf = await accept({ token: inviteToken }, { session: right, csrf: false });
  assert.equal(noCsrf.statusCode, 403); assert.equal(noCsrf.json().error.code, 'csrf_mismatch');
  const ok = await accept({ token: inviteToken }, { session: right });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().data.memberships.some((m: { tenantId: string; role: string }) => m.tenantId === W.tenantId && m.role === 'operator'));
  assert.equal(ok.cookies.length, 0, 'no new session for an already signed-in user');

  // A signed-in user cannot use a link meant for a brand-new email to spawn a second account.
  const { inviteToken: t2 } = (await invite(W, W.owner, 'brand-new@example.com', 'viewer')).json().data;
  assert.equal((await accept({ token: t2, password: 'a-long-password-123' }, { session: right })).statusCode, 403);
});

test('accept: expired, revoked and unknown tokens all get the same generic error', async () => {
  const W = await seedWorkspace(t, 'inv-invalid');
  const exp = (await invite(W, W.owner, 'exp@example.com', 'viewer')).json().data;
  await getPool().query(`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp.invitation.id]);
  const rev = (await invite(W, W.owner, 'rev@example.com', 'viewer')).json().data;
  assert.equal((await call(t, 'POST', `${base(W)}/invitations/${rev.invitation.id}/revoke`, { session: W.owner })).json().data.status, 'revoked');
  const bodies = [];
  for (const token of [exp.inviteToken, rev.inviteToken, 'A'.repeat(43)]) {
    const r = await accept({ token, password: 'a-long-password-123' }, { ip: '192.0.2.230' });
    assert.equal(r.statusCode, 400);
    bodies.push(r.json().error.message);
  }
  assert.equal(new Set(bodies).size, 1);
  const listed = (await call(t, 'GET', `${base(W)}/invitations`, { session: W.owner })).json().data;
  assert.equal(listed.find((i: { id: string }) => i.id === exp.invitation.id).status, 'expired');
  const other = await seedWorkspace(t, 'inv-invalid-other');
  assert.equal((await call(t, 'POST', `${base(other)}/invitations/${rev.invitation.id}/revoke`, { session: other.owner })).statusCode, 404, 'cross-tenant revoke');
});

test('accept is rate limited per address; a limited address cannot redeem even a valid token', async () => {
  const W = await seedWorkspace(t, 'inv-rate');
  const { inviteToken } = (await invite(W, W.owner, 'rate@example.com', 'viewer')).json().data;
  const ip = '198.51.100.250';
  for (let i = 0; i < 20; i++) assert.equal((await accept({ token: `bad${'x'.repeat(40)}${i}` }, { ip })).statusCode, 400);
  const limited = await accept({ token: inviteToken, password: 'a-long-password-123' }, { ip });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await accept({ token: inviteToken, password: 'a-long-password-123' }, { ip: '198.51.100.251' })).statusCode, 200, 'other addresses unaffected');
});
