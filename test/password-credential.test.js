'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const credential = require('../lib/password-credential');

const CLIENT_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

test('server protects client prehash with randomized scrypt credential', () => {
  const first = credential.protectClientHash(CLIENT_HASH);
  const second = credential.protectClientHash(CLIENT_HASH);
  assert.match(first, /^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.match(second, /^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(first, second, 'per-account/random salt must change stored credential');
  assert.equal(credential.verifyStoredCredential(first, CLIENT_HASH).ok, true);
  assert.equal(credential.verifyStoredCredential(first, OTHER_HASH).ok, false);
});

test('legacy raw client hashes remain valid only for migration and request upgrade', () => {
  assert.deepEqual(credential.verifyStoredCredential(CLIENT_HASH, CLIENT_HASH), { ok: true, needsUpgrade: true });
  assert.deepEqual(credential.verifyStoredCredential(CLIENT_HASH, OTHER_HASH), { ok: false, needsUpgrade: false });
});

test('stored scrypt credential cannot itself be replayed as a client password hash', () => {
  const stored = credential.protectClientHash(CLIENT_HASH);
  assert.equal(credential.normalizeClientHash(stored), null);
  assert.equal(credential.verifyStoredCredential(stored, stored).ok, false);
});
