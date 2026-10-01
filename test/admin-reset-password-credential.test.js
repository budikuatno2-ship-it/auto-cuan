'use strict';

/**
 * How the admin "reset password" action stores a credential.
 *
 * Every other write path in this codebase stores the PROTECTED credential —
 * a random salt plus a scrypt digest, prefixed `k1`:
 *
 *   api/register-user.js:147                    protectClientHash(passwordHash)
 *   api/login-user.js:428                       protectClientHash(passwordHash)  (upgrade)
 *   lib/reset-password-legacy-handler.js:252    protectClientHash(newPasswordHash)
 *
 * lib/password-credential.js states why: "The leading 'k' makes the stored
 * value fail the public 64-hex client-hash validator, so a database value
 * cannot be replayed directly as a login hash."
 *
 * The admin reset wrote `req.body.newPasswordHash` verbatim, so the row it
 * produced was a bare SHA-256 — exactly the replayable legacy shape — and it
 * validated nothing at all, so a malformed value could be stored and leave the
 * account unable to log in with no error anywhere.
 */

const test = require('node:test');
const assert = require('node:assert');

// Patch the Supabase factory before the handler is required: the handler
// destructures createClient at module load.
const supa = require('@supabase/supabase-js');
let currentDb = null;
supa.createClient = function () { return currentDb; };

const passwordCredential = require('../lib/password-credential');
const { createSessionToken, SESSION_COOKIE_NAME } = require('../lib/admin-session');
const handler = require('../lib/admin-users-handler');

const TARGET_ID = 'user-target-1';
const CLIENT_HASH = 'a'.repeat(64);

function fakeDb() {
  const state = { updates: [] };
  const db = {
    state,
    from(table) {
      assert.strictEqual(table, 'app_users');
      return {
        select() {
          return {
            eq() {
              return { maybeSingle() { return Promise.resolve({ data: { id: TARGET_ID }, error: null }); } };
            }
          };
        },
        update(patch) {
          return {
            eq(col, val) {
              state.updates.push({ patch, col, val });
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    }
  };
  return db;
}

function fakeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; },
    setHeader() { return this; }
  };
}

function withEnv(t) {
  const saved = {
    secret: process.env.SESSION_SECRET,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SESSION_SECRET = 'test-session-secret-not-a-real-value';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  t.after(() => {
    if (saved.secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved.secret;
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  });
}

async function resetPassword(t, newPasswordHash, username) {
  withEnv(t);
  currentDb = fakeDb();
  const token = createSessionToken({ userId: 'admin-1', username: 'budi', isAdmin: true });
  assert.ok(token, 'the test needs a signed admin session');
  const req = {
    method: 'POST',
    headers: { cookie: SESSION_COOKIE_NAME + '=' + token },
    body: { action: 'reset_password', username: username || 'someuser', newPasswordHash: newPasswordHash }
  };
  const res = fakeRes();
  await handler(req, res);
  return { res: res.state, db: currentDb.state };
}

test('1. the stored credential is protected, not the raw client hash', async (t) => {
  const { res, db } = await resetPassword(t, CLIENT_HASH);
  assert.strictEqual(res.statusCode, 200, 'a valid reset must still succeed');
  assert.strictEqual(db.updates.length, 1);
  const stored = db.updates[0].patch.password_hash;
  assert.notStrictEqual(
    stored, CLIENT_HASH,
    'the raw client hash must never be what lands in the row — a database value must not be replayable as a login hash'
  );
  assert.strictEqual(
    passwordCredential.isProtectedCredential(stored), true,
    'the stored value must be a k1 salted scrypt credential, like every other write path'
  );
});

test('2. the stored credential still verifies the same password', async (t) => {
  const { db } = await resetPassword(t, CLIENT_HASH);
  const stored = db.updates[0].patch.password_hash;
  const check = passwordCredential.verifyStoredCredential(stored, CLIENT_HASH);
  assert.strictEqual(check.ok, true, 'the user must be able to log in with the password the admin set');
  assert.strictEqual(check.needsUpgrade, false, 'and the row must already be in the upgraded form');
});

test('3. a different password does not verify', async (t) => {
  const { db } = await resetPassword(t, CLIENT_HASH);
  const stored = db.updates[0].patch.password_hash;
  assert.strictEqual(passwordCredential.verifyStoredCredential(stored, 'b'.repeat(64)).ok, false);
});

test('4. two resets of the same password produce different rows (the salt is random)', async (t) => {
  const first = await resetPassword(t, CLIENT_HASH);
  const second = await resetPassword(t, CLIENT_HASH);
  assert.notStrictEqual(
    first.db.updates[0].patch.password_hash,
    second.db.updates[0].patch.password_hash,
    'a fresh salt per write is what makes the stored value non-replayable'
  );
});

test('5. a malformed hash is rejected and nothing is written', async (t) => {
  for (const bad of ['not-a-hash', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    const { res, db } = await resetPassword(t, bad);
    assert.strictEqual(res.statusCode, 400, 'rejected: ' + bad);
    assert.strictEqual(
      db.updates.length, 0,
      'a value that can never verify must not be written — it would lock the account out silently: ' + bad
    );
  }
});

test('6. an already-protected value from the body is rejected too', async (t) => {
  // `k1...` is a STORED shape, not a client hash. Accepting one would let a
  // caller install a credential whose salt and digest they chose.
  const { res, db } = await resetPassword(t, 'k1' + 'a'.repeat(62));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.updates.length, 0);
});

test('7. an empty hash is still rejected (unchanged)', async (t) => {
  const { res, db } = await resetPassword(t, '');
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.updates.length, 0);
});

test('8. resetting the budi account is still refused (unchanged)', async (t) => {
  const { res, db } = await resetPassword(t, CLIENT_HASH, 'budi');
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.updates.length, 0);
});
