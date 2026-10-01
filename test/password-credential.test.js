'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const credential = require('../lib/password-credential');

const CLIENT_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

test('server protects client prehash with randomized fixed-width scrypt credential', () => {
  const first = credential.protectClientHash(CLIENT_HASH);
  const second = credential.protectClientHash(CLIENT_HASH);
  assert.equal(first.length, 64, 'must fit historical varchar(64) schemas');
  assert.equal(second.length, 64, 'must fit historical varchar(64) schemas');
  assert.match(first, /^k1[a-f0-9]{62}$/);
  assert.match(second, /^k1[a-f0-9]{62}$/);
  assert.equal(credential.isProtectedCredential(first), true);
  assert.equal(credential.isProtectedCredential(second), true);
  assert.notEqual(first, second, 'random salt must change the stored credential');
  assert.equal(credential.verifyStoredCredential(first, CLIENT_HASH).ok, true);
  assert.equal(credential.verifyStoredCredential(first, OTHER_HASH).ok, false);
});

test('legacy raw client hashes remain valid only for transparent migration', () => {
  assert.deepEqual(
    credential.verifyStoredCredential(CLIENT_HASH, CLIENT_HASH),
    { ok: true, needsUpgrade: true }
  );
  assert.deepEqual(
    credential.verifyStoredCredential(CLIENT_HASH, OTHER_HASH),
    { ok: false, needsUpgrade: false }
  );
});

test('stored server credential cannot itself be replayed as a client password hash', () => {
  const stored = credential.protectClientHash(CLIENT_HASH);
  assert.equal(credential.normalizeClientHash(stored), null);
  assert.equal(credential.verifyStoredCredential(stored, stored).ok, false);
});
