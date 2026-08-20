'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const credential = require('../lib/password-credential');

const CLIENT_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const USERNAME = 'tester';

test('server protects client prehash with a fixed-width account-scoped scrypt credential', () => {
  const stored = credential.protectClientHash(CLIENT_HASH, USERNAME);
  assert.equal(stored.length, 64, 'must fit historical varchar(64) schemas');
  assert.match(stored, /^k1\$[a-f0-9]{61}$/);
  assert.equal(credential.verifyStoredCredential(stored, CLIENT_HASH, USERNAME).ok, true);
  assert.equal(credential.verifyStoredCredential(stored, OTHER_HASH, USERNAME).ok, false);
  assert.equal(credential.verifyStoredCredential(stored, CLIENT_HASH, 'another-user').ok, false);
});

test('legacy raw client hashes remain valid only for transparent migration', () => {
  assert.deepEqual(
    credential.verifyStoredCredential(CLIENT_HASH, CLIENT_HASH, USERNAME),
    { ok: true, needsUpgrade: true }
  );
  assert.deepEqual(
    credential.verifyStoredCredential(CLIENT_HASH, OTHER_HASH, USERNAME),
    { ok: false, needsUpgrade: false }
  );
});

test('stored server credential cannot itself be replayed as a client password hash', () => {
  const stored = credential.protectClientHash(CLIENT_HASH, USERNAME);
  assert.equal(credential.normalizeClientHash(stored), null);
  assert.equal(credential.verifyStoredCredential(stored, stored, USERNAME).ok, false);
});
