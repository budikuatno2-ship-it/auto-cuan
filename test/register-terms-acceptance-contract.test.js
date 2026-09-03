'use strict';

// Bug fix regression test: the register modal (public/index.html) never sent
// termsAccepted/termsVersion, so every /api/register-user call was rejected
// with 400 TERMS_ACCEPTANCE_REQUIRED (see lib/account-terms.js +
// api/register-user.js). This test locks the frontend payload contract to
// the server's requirement, using a mocked fetch — no live network/Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const accountTerms = require('../lib/account-terms');

const HTML_PATH = path.resolve(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

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

function extractVarStatement(src, signature) {
  var start = src.indexOf(signature);
  if (start < 0) return null;
  var end = src.indexOf(';', start);
  return src.slice(start, end + 1);
}

// ---- Static markup: the terms checkbox must exist in the register modal ----

test('register modal renders a terms-acceptance checkbox', () => {
  var modalStart = html.indexOf('id="registerModal"');
  var modalEnd = html.indexOf('<!-- ADMIN AI DETAIL MODAL', modalStart);
  var modalHtml = html.slice(modalStart, modalEnd);
  assert.ok(modalHtml.indexOf('id="regTermsAccepted"') >= 0, 'terms checkbox must exist in the register modal');
  assert.match(modalHtml, /type="checkbox"[^>]*id="regTermsAccepted"|id="regTermsAccepted"[^>]*type="checkbox"/);
});

// ---- Behavioral: doRegister() must validate + send termsAccepted/termsVersion ----

function makeDoRegister(overrides) {
  var versionSrc = extractVarStatement(html, 'var REGISTRATION_TERMS_VERSION');
  assert.ok(versionSrc, 'REGISTRATION_TERMS_VERSION constant must exist');
  var fnSrc = extractFunction(html, 'async function doRegister');
  assert.ok(fnSrc, 'doRegister must exist');

  var fields = Object.assign({
    regUsername: { value: 'newtrader' },
    regPassword: { value: 'Abcdef12' },
    regPasswordConfirm: { value: 'Abcdef12' },
    regTermsAccepted: { checked: true },
    registerError: { classList: { add() {}, remove() {} }, textContent: '' },
    registerSuccess: { classList: { add() {}, remove() {} } },
    registerBtn: { disabled: false, innerHTML: '' }
  }, overrides || {});

  var fakeDocument = { getElementById: function (id) { return fields[id]; } };
  var calls = [];
  var fakeFetch = function (url, opts) {
    calls.push({ url: url, opts: opts });
    return Promise.resolve({ json: () => Promise.resolve({ success: true, approval_status: 'pending', approval_code: 'AC-ABC123' }) });
  };

  var sandboxSrc = versionSrc + '\n' + fnSrc + '\nreturn doRegister;';
  var factory = new Function(
    'document', 'fetch', 'navigator', 'hashPassword', 'getOrCreateDeviceId',
    'isBadUsername', 'isValidPassword', 'clearLegacyDeviceBlock', 'showRegistrationApproval',
    sandboxSrc
  );
  var doRegister = factory(
    fakeDocument,
    fakeFetch,
    { userAgent: 'test-agent' },
    (pw) => Promise.resolve('a1b2c3d4'.repeat(8)),
    () => 'dev_test',
    () => false,
    () => true,
    () => {},
    () => {}
  );

  return { doRegister: doRegister, calls: calls, fields: fields };
}

test('doRegister sends termsAccepted:true and the server-matching termsVersion', async () => {
  var ctx = makeDoRegister();
  await ctx.doRegister();
  assert.equal(ctx.calls.length, 1, 'register-user must be called once');
  assert.equal(ctx.calls[0].url, '/api/register-user');
  var body = JSON.parse(ctx.calls[0].opts.body);
  assert.equal(body.termsAccepted, true);
  assert.equal(body.termsVersion, accountTerms.CURRENT_TERMS_VERSION,
    'frontend termsVersion must equal lib/account-terms.js CURRENT_TERMS_VERSION');
});

test('doRegister blocks submission when the terms checkbox is unchecked (no network call)', async () => {
  var ctx = makeDoRegister({ regTermsAccepted: { checked: false } });
  await ctx.doRegister();
  assert.equal(ctx.calls.length, 0, 'must not call /api/register-user without terms acceptance');
  assert.match(ctx.fields.registerError.textContent, /Peraturan.*Ketentuan/);
});

// ---- End-to-end contract: the exact payload doRegister sends must be
// accepted by the real api/register-user.js handler (mocked Supabase only).

test('the payload doRegister() sends is accepted by api/register-user.js (mocked Supabase, no live network)', async () => {
  var registerHandler = require('../api/register-user');
  var ctx = makeDoRegister();
  await ctx.doRegister();
  var sentBody = JSON.parse(ctx.calls[0].opts.body);

  var origUrl = process.env.SUPABASE_URL;
  var origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  var statusCode = null; var payload = null;
  var res = { status(code) { statusCode = code; return res; }, json(p) { payload = p; return res; } };

  try {
    await registerHandler({ method: 'POST', body: sentBody }, res);
  } finally {
    if (origUrl !== undefined) process.env.SUPABASE_URL = origUrl;
    if (origKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }

  // Must fail for the (unrelated, expected-in-this-test) missing-Supabase
  // reason, never for TERMS_ACCEPTANCE_REQUIRED — proving the frontend
  // payload now satisfies the server's terms-acceptance contract.
  assert.notEqual(payload && payload.code, 'TERMS_ACCEPTANCE_REQUIRED');
  assert.equal(statusCode, 500);
  assert.equal(payload.error, 'Database belum dikonfigurasi.');
});
