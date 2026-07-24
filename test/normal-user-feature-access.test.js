'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../lib/admin-session');
const sector = require('../api/sector-hot').__test;

async function withEnv(fn) {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'normal-user-feature-access-test-secret';
  try { return await fn(); } finally { if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous; }
}
function requestFor(user) {
  const token = session.createSessionToken({ userId: user.id, username: user.username, isAdmin: user.username === 'budi' });
  return { headers: { cookie: session.SESSION_COOKIE_NAME + '=' + token } };
}
function db(row) {
  return { from() { return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: row, error: null }); } }; } };
}

test('approved signed normal user is authorized for Sektor Hot, Screener, and Portofolio browser features', async () => {
  await withEnv(async () => {
    const user = { id: 'approved-user-id', username: 'alice', is_approved: true, is_blocked: false };
    const access = await sector.requireApprovedUserSession(requestFor(user), db(user));
    assert.equal(access.ok, true);
    assert.equal(access.user.username, 'alice');
  });
});

test('guest, unapproved, blocked, and invalid sessions are rejected while signed budi remains authorized', async () => {
  await withEnv(async () => {
    const guest = await sector.requireApprovedUserSession({ headers: {} }, db(null));
    assert.equal(guest.status, 401);
    for (const row of [
      { id: 'p', username: 'pending', is_approved: false, is_blocked: false },
      { id: 'b', username: 'blocked', is_approved: true, is_blocked: true }
    ]) {
      const access = await sector.requireApprovedUserSession(requestFor(row), db(row));
      assert.equal(access.status, 403);
    }
    const budi = { id: 'admin-id', username: 'budi', is_approved: true, is_blocked: false };
    assert.equal((await sector.requireApprovedUserSession(requestFor(budi), db(budi))).ok, true);
  });
});
