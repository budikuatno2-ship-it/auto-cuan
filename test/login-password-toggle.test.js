'use strict';

// Focused tests: Login password visibility toggle reuses the shared
// togglePasswordVisibility() logic. No auth/registration/device/hash changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.resolve(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Extract a top-level function body by brace matching.
function extractFunction(src, signature) {
  var start = src.indexOf(signature);
  if (start < 0) return null;
  var i = src.indexOf('{', start);
  var depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

// Isolate the login password input markup (the <input id="loginPassword" ...>).
function loginPasswordInputTag() {
  var idx = html.indexOf('id="loginPassword"');
  assert.ok(idx >= 0, 'loginPassword input must exist');
  var start = html.lastIndexOf('<input', idx);
  var end = html.indexOf('>', idx);
  return html.slice(start, end + 1);
}

// Isolate the login toggle button markup.
function loginToggleButtonTag() {
  var idx = html.indexOf('id="loginPasswordToggle"');
  assert.ok(idx >= 0, 'loginPasswordToggle button must exist');
  var start = html.lastIndexOf('<button', idx);
  var end = html.indexOf('>', idx);
  return html.slice(start, end + 1);
}

// ---- Static markup guarantees ----

test('login password is hidden by default (type="password")', () => {
  assert.match(loginPasswordInputTag(), /type="password"/);
});

test('login eye control uses type="button" (never submits the form)', () => {
  var btn = loginToggleButtonTag();
  assert.match(btn, /type="button"/);
  assert.match(btn, /onclick="togglePasswordVisibility\('loginPassword', this\)"/);
  assert.match(btn, /aria-label="Show password"/);
});

test('login toggle reuses the shared togglePasswordVisibility (no duplicate logic)', () => {
  // Only one definition of togglePasswordVisibility should exist.
  var count = (html.match(/function togglePasswordVisibility\(/g) || []).length;
  assert.equal(count, 1, 'togglePasswordVisibility must be defined exactly once');
});

test('login Forgot Password link is unchanged', () => {
  assert.ok(html.indexOf('closeLoginModal();openSelfResetModal()') >= 0, 'Forgot Password handler intact');
  assert.ok(html.indexOf('>Lupa Password?<') >= 0, 'Forgot Password label intact');
});

test('login Enter-to-submit behavior preserved on the password field', () => {
  assert.match(loginPasswordInputTag(), /onkeydown="if\(event\.key==='Enter'\)doLogin\(\)"/);
});

// ---- Behavioral test of the shared toggle against the login field ----

function makeToggle() {
  var fnSrc = extractFunction(html, 'function togglePasswordVisibility');
  assert.ok(fnSrc, 'togglePasswordVisibility must exist');
  var factory = new Function('document', fnSrc + '\nreturn togglePasswordVisibility;');
  return factory;
}

test('login toggle flips password <-> text, preserves value, updates aria-label', () => {
  var input = {
    type: 'password', value: 'MyLoginP@ss1',
    selectionStart: 4, selectionEnd: 4,
    _focused: false, _range: null,
    focus() { this._focused = true; },
    setSelectionRange(s, e) { this._range = [s, e]; }
  };
  var btn = { _attrs: {}, innerHTML: '', setAttribute(k, v) { this._attrs[k] = v; } };
  var fakeDoc = { getElementById: function(id) { return id === 'loginPassword' ? input : null; } };
  var toggle = makeToggle()(fakeDoc);

  // Reveal
  toggle('loginPassword', btn);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'MyLoginP@ss1', 'typed value preserved');
  assert.equal(btn._attrs['aria-pressed'], 'true');
  assert.equal(btn._attrs['aria-label'], 'Hide password');
  assert.deepEqual(input._range, [4, 4], 'cursor position preserved');

  // Hide again -> back to secure default
  toggle('loginPassword', btn);
  assert.equal(input.type, 'password');
  assert.equal(btn._attrs['aria-pressed'], 'false');
  assert.equal(btn._attrs['aria-label'], 'Show password');
});

test('toggle only switches between password and text (no other types)', () => {
  var input = { type: 'password', value: 'x', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} };
  var btn = { _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; } };
  var toggle = makeToggle()({ getElementById: function() { return input; } });
  toggle('loginPassword', btn);
  assert.ok(input.type === 'text', 'first toggle -> text');
  toggle('loginPassword', btn);
  assert.ok(input.type === 'password', 'second toggle -> password');
});

// ---- Registration toggles still intact ----

test('registration password toggles still work (both buttons present, wired to shared fn)', () => {
  assert.ok(html.indexOf('id="regPasswordToggle"') >= 0);
  assert.ok(html.indexOf('id="regPasswordConfirmToggle"') >= 0);
  assert.ok(html.indexOf("togglePasswordVisibility('regPassword', this)") >= 0);
  assert.ok(html.indexOf("togglePasswordVisibility('regPasswordConfirm', this)") >= 0);
  // Both registration password fields still default to hidden.
  assert.match(html, /id="regPassword"[^>]*type="password"|type="password"[^>]*id="regPassword"/);
  assert.match(html, /id="regPasswordConfirm"[^>]*type="password"|type="password"[^>]*id="regPasswordConfirm"/);
});

// ---- Existing login behavior unchanged ----

test('existing login flow unchanged: doLogin still hashes password and sends deviceId', () => {
  var doLoginSrc = extractFunction(html, 'async function doLogin');
  assert.ok(doLoginSrc, 'doLogin must exist');
  assert.ok(doLoginSrc.indexOf('hashPassword(') >= 0, 'still hashes password');
  assert.ok(doLoginSrc.indexOf('getOrCreateDeviceId()') >= 0, 'still resolves device id');
  assert.ok(doLoginSrc.indexOf("'/api/login-user'") >= 0 || doLoginSrc.indexOf('/api/login-user') >= 0, 'still calls login-user API');

  // Server-side auth/device logic in login-user.js must be untouched.
  var loginSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'login-user.js'), 'utf8');
  assert.ok(loginSrc.indexOf('currentDevices.includes(deviceId)') >= 0, 'device validation intact');
  assert.ok(loginSrc.indexOf('passwordHash') >= 0, 'password hash comparison path intact');
});
