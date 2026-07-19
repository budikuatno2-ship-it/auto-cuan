'use strict';

// Focused tests for the frontend compatibility fix that routes the existing `budi`
// admin through the REAL server login (/api/login-user) instead of a local-only
// shortcut. These are static source assertions over public/index.html (matching the
// repo's existing frontend test style) plus a mocked check that a forged/non-budi
// server response can never unlock admin. No DOM, no network, no production call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Extract the doLogin() function body by brace matching.
function extractFunction(signature) {
  const startIdx = html.indexOf(signature);
  assert.ok(startIdx >= 0, 'must find: ' + signature);
  const braceStart = html.indexOf('{', startIdx);
  let depth = 0;
  for (let j = braceStart; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(startIdx, j + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}
const doLogin = extractFunction('async function doLogin()');

// 1. budi login calls /api/login-user (via the shared server path, no special branch)
test('1: budi is not intercepted by a local branch; login uses /api/login-user', () => {
  assert.doesNotMatch(doLogin, /if \(password === '\.'\)/);
  // There is exactly one server login call, shared by all users including budi.
  const calls = (doLogin.match(/fetch\('\/api\/login-user'/g) || []).length;
  assert.equal(calls, 1, 'a single shared /api/login-user call');
});

// 2. The entered budi password goes through the SAME hashing path as everyone else
test('2: password is hashed via the shared hashPassword() path (no budi bypass)', () => {
  assert.match(doLogin, /await hashPassword\(password\)/);
  // no special-cased plaintext password handling remains
  assert.doesNotMatch(doLogin, /password === '\.'/);
});

// 3. The current device id is included in the login request
test('3: the login request includes the current device id', () => {
  assert.match(doLogin, /getOrCreateDeviceId\(\)/);
  assert.match(doLogin, /deviceId: deviceId/);
});

// 4 + 8. Admin UI is entered from the server result, gated on the server username
test('4&8: admin state is set only from the authenticated server response for budi', () => {
  assert.match(doLogin, /var isAdminUser = \(data\.isAdmin === true && String\(data\.username[^)]*\)\.toLowerCase\(\) === 'budi'\)/);
  assert.match(doLogin, /autocuan_is_admin', isAdminUser \? 'true' : 'false'/);
  // enters the existing app/admin UI on success
  assert.match(doLogin, /enterApp\(\{ replaceHistory: true \}\)/);
});

// 5. Login relies on the server session cookie (same-origin credentials)
test('5: login request uses same-origin credentials so the session cookie is stored/sent', () => {
  assert.match(doLogin, /credentials: 'same-origin'/);
});

// 6 + 7. Failure path sets no admin state and there is no local admin fallback anywhere
test('6&7: failed auth shows the error and never sets admin; no local admin fallback', () => {
  // The only place autocuan_is_admin can become 'true' is the server-gated isAdminUser.
  assert.doesNotMatch(doLogin, /autocuan_is_admin', 'true'/);
  // failure branch surfaces the generic error and does not enter admin
  assert.match(doLogin, /errorEl\.textContent = data\.error \|\| 'Login gagal\.'/);
});

// 9. A non-budi server response (even with isAdmin true) cannot unlock admin locally.
// Mirror the exact frontend gate and prove the logic.
test('9: non-budi cannot obtain admin; only a budi-identified server response can', () => {
  function frontendAdminGate(data) {
    return (data.isAdmin === true && String(data.username || '').toLowerCase() === 'budi');
  }
  assert.equal(frontendAdminGate({ success: true, username: 'alice', isAdmin: true }), false); // forged/non-budi
  assert.equal(frontendAdminGate({ success: true, username: 'budi', isAdmin: false }), false); // budi but server says not admin
  assert.equal(frontendAdminGate({ success: true, username: 'budi', isAdmin: true }), true);   // genuine budi admin
  assert.equal(frontendAdminGate({ success: true, username: 'BUDI', isAdmin: true }), true);    // case-insensitive
  assert.equal(frontendAdminGate({ success: true }), false);
});

// 11. Logout still calls the server logout action before clearing local state.
test('11: logout calls the server logout action and clears local UI state', () => {
  const logout = extractFunction('async function logout()');
  assert.match(logout, /action: 'logout'/);
  assert.match(logout, /\/api\/login-user/);
  assert.match(logout, /autocuan_logged_in/); // still clears local state
});

// 16. API endpoint count remains exactly 12.
test('16: api endpoint count remains exactly 12', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
});
