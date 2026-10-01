'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('legacy browser device block is cleared and can no longer deny access', () => {
  assert.match(html, /function clearLegacyDeviceBlock\(\)/);
  assert.match(html, /function isDeviceBlocked\(\) \{ clearLegacyDeviceBlock\(\); return false; \}/);
  assert.doesNotMatch(html, /localStorage\.setItem\('autocuan_blocked_until'/);
  assert.doesNotMatch(html, /if \(!isReview && isDeviceBlocked\(\)\) \{ showBlockedScreen\(\); return; \}/);
});

test('login trusts server authentication and registration errors remain inline', () => {
  assert.doesNotMatch(html, /usernameLower !== 'review'[\s\S]{0,180}blockDeviceForBadName/);
  assert.match(html, /if \(isBadUsername\(usernameInput\)\) \{ errorEl\.textContent = 'Nama yang digunakan tidak sesuai ketentuan\.'/);
});
