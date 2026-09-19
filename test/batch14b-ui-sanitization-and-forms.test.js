'use strict';

// Batch 14B — LOW UI sanitization, absent-value display, and registration form
// guards regression.
//
// Every assertion locks the POST-fix state so the fixed latent bugs cannot
// silently come back:
//   F-003  bandarmologi roster renders a missing percentage as "—", not "0.00%"
//   F-079  insider-network-service roster keeps a missing percentage null/"—"
//   F-081  silent-foreign-accumulation note never fabricates a "3 days" streak
//   F-082  track-record-runtime escapes server/fetch error text before innerHTML
//   F-086  analisis-saham-runtime sanitizes AI HTML before the bold transform
//   F-089  doLogin no longer references the undeclared regEmailVal
//   F-090  doRegister resolves errorEl before the email validation branch
//   F-091  openNewsFromAnalisis escapes news fields; href is scheme-guarded

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// F-003 — bandarmologi-runtime roster table
// ---------------------------------------------------------------------------

function createBandarmologiDom() {
  const elements = {};
  function makeEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        className: '',
        style: {},
        innerHTML: '',
        textContent: '',
        value: '',
        attributes: {},
        classList: {
          add: function () {},
          remove: function () {},
          contains: function () { return false; }
        },
        setAttribute: function (k, v) { elements[id].attributes[k] = String(v); },
        getAttribute: function (k) { return elements[id].attributes[k] || null; },
        addEventListener: function () {},
        appendChild: function () {},
        remove: function () {}
      };
    }
    return elements[id];
  }
  makeEl('bandarmologiContent');
  makeEl('insiderRosterTbody');

  const document = {
    getElementById: function (id) { return makeEl(id); },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    head: { appendChild: function () {} },
    body: { appendChild: function () {} },
    createElement: function (tag) { return makeEl('elem_' + tag + '_' + Math.random().toString(36).slice(2)); }
  };

  const sandbox = {
    window: {
      document,
      location: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
      history: { replaceState: function () {} },
      addEventListener: function () {},
      fetch: async function () { return { json: async () => ({ success: true }) }; }
    },
    document,
    console,
    Intl,
    Date,
    URL,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    RegExp,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {}
  };
  sandbox.global = sandbox.window;
  sandbox.globalThis = sandbox.window;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  return { sandbox, elements };
}

test('F-003: roster renders a missing percentage as "—", never a synthetic 0.00%', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createBandarmologiDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  runtime.renderInsiderNetworkUI(elements.bandarmologiContent, 'BBCA');

  runtime.renderRosterTableRows([
    { no: 1, name: 'Tanpa Persentase', category: 'Direksi', position: 'Direktur', shares: 1000, percentage: null, last_change: 'Tetap', last_date: null },
    { no: 2, name: 'Punya Persentase', category: 'Pengendali', position: 'Pengendali', shares: 2000, percentage: 12.5, percentage_formatted: '12.50%', last_change: 'Tetap', last_date: null }
  ]);

  const html = elements.insiderRosterTbody.innerHTML;
  assert.ok(html.includes('Tanpa Persentase'), 'row with missing percentage is rendered');
  assert.ok(html.includes('—'), 'missing percentage renders the explicit dash marker');
  assert.ok(!html.includes('0.00%'), 'missing percentage must NOT be shown as 0.00%');
  assert.ok(html.includes('12.50%'), 'a real percentage still renders normally');
});

test('F-003: source no longer coerces a null percentage to 0', () => {
  const src = read('public/bandarmologi-runtime.js');
  assert.doesNotMatch(src, /\?\s*0\s*\n\s*:\s*\(typeof r\.percentage === 'number'/, 'the null->0 coercion must be gone');
  assert.match(src, /pct == null \? '—' : pct\.toFixed\(2\) \+ '%'/, 'the dash fallback must be present');
});

// ---------------------------------------------------------------------------
// F-079 — insider-network-service roster
// ---------------------------------------------------------------------------

test('F-079: getRosterForTicker keeps a missing percentage null and formats it as "—"', () => {
  const svc = require('../lib/insider-network-service.js');
  svc.setCustomUniverse([
    { ticker: 'ZZZZ', insider_name: 'No Pct Holder', position: 'Direksi', shares_after: 1000, date: '2026-09-01' },
    { ticker: 'ZZZZ', insider_name: 'Has Pct Holder', position: 'Pengendali', shares_after: 2000, current_percentage: 7.25, date: '2026-09-01' }
  ]);

  const roster = svc.getRosterForTicker('ZZZZ');
  assert.equal(roster.length, 2);

  const missing = roster.find((r) => r.name === 'No Pct Holder');
  assert.equal(missing.percentage, null, 'missing percentage must stay null, not 0');
  assert.equal(missing.percentage_formatted, '—', 'missing percentage must format as the dash marker');

  const present = roster.find((r) => r.name === 'Has Pct Holder');
  assert.equal(present.percentage, 7.25);
  assert.equal(present.percentage_formatted, '7.25%');

  svc.setCustomUniverse(null);
});

test('F-079: source no longer uses `r.percentage || 0`', () => {
  const src = read('lib/insider-network-service.js');
  assert.doesNotMatch(src, /percentage:\s*r\.percentage \|\| 0/);
  assert.doesNotMatch(src, /\(r\.percentage \|\| 0\)\.toFixed/);
});

// ---------------------------------------------------------------------------
// F-081 — silent foreign accumulation note
// ---------------------------------------------------------------------------

test('F-081: silent-foreign-accumulation note never fabricates a "3 days" streak', () => {
  const src = read('public/bandarmologi-runtime.js');
  assert.doesNotMatch(src, /var days = item\.consecutive_days \|\| 3;/, 'the `|| 3` fabrication must be gone');
  assert.match(src, /jumlah hari berturut-turut belum tersedia/, 'an explicit "not available" note must exist');
});

// ---------------------------------------------------------------------------
// F-082 — track-record-runtime error escaping
// ---------------------------------------------------------------------------

test('F-082: track-record-runtime escapes error text before writing to innerHTML', () => {
  const src = read('public/track-record-runtime.js');
  assert.match(src, /function escapeHtml\(value\)/, 'an escapeHtml helper must exist');
  assert.match(src, /escapeHtml\(\(data && data\.error\) \|\| 'Terjadi kesalahan\.'\)/, 'server error text must be escaped');
  assert.match(src, /escapeHtml\(err\.message \|\| String\(err\)\)/, 'fetch error text must be escaped');
  assert.doesNotMatch(src, /'Gagal memuat track record: ' \+ \(\(data && data\.error\)/, 'raw interpolation must be gone');
});

// ---------------------------------------------------------------------------
// F-086 — analisis-saham-runtime AI HTML sanitization
// ---------------------------------------------------------------------------

test('F-086: analisis-saham-runtime sanitizes AI HTML before the bold transform', () => {
  const src = read('public/analisis-saham-runtime.js');
  assert.match(src, /if \(typeof sanitizeAIHtml === 'function'\) html = sanitizeAIHtml\(html\);/, 'sanitizeAIHtml must be invoked');
  const sanitizeIdx = src.indexOf("if (typeof sanitizeAIHtml === 'function') html = sanitizeAIHtml(html);");
  const boldIdx = src.indexOf('html = convertStrayMarkdownBold(html);');
  assert.ok(sanitizeIdx !== -1 && boldIdx !== -1, 'both steps must be present');
  assert.ok(sanitizeIdx < boldIdx, 'sanitize must run BEFORE the bold transform (index.html order)');
});

// ---------------------------------------------------------------------------
// F-089 / F-090 / F-091 — index.html form + news panel
// ---------------------------------------------------------------------------

test('F-089: doLogin no longer references the undeclared regEmailVal', () => {
  const src = read('public/index.html');
  const start = src.indexOf('async function doLogin()');
  assert.notEqual(start, -1, 'doLogin must still exist');
  const end = src.indexOf('\n// ===== PASSWORD VISIBILITY TOGGLE', start);
  const body = src.slice(start, end === -1 ? src.length : end);
  assert.doesNotMatch(body, /regEmailVal/, 'doLogin must not reference regEmailVal');
  assert.match(body, /body: JSON\.stringify\(\{ username: usernameLower, passwordHash: passwordHash/, 'login body must not carry email');
});

test('F-090: doRegister resolves errorEl before the email validation branch', () => {
  const src = read('public/index.html');
  const start = src.indexOf('async function doRegister()');
  assert.notEqual(start, -1, 'doRegister must still exist');
  const end = src.indexOf('\n// ===== LOGOUT', start);
  const body = src.slice(start, end === -1 ? src.length : end);

  const assignIdx = body.indexOf("var errorEl = document.getElementById('registerError')");
  const useIdx = body.indexOf('errorEl.textContent = "Format email tidak valid."');
  assert.notEqual(assignIdx, -1, 'errorEl must be assigned');
  assert.notEqual(useIdx, -1, 'the email validation branch must still exist');
  assert.ok(assignIdx < useIdx, 'errorEl must be assigned BEFORE the email branch uses it');
  assert.match(body, /if \(errorEl\) \{ errorEl\.textContent = "Format email tidak valid\."/, 'the email branch must null-guard errorEl');
});

test('F-091: openNewsFromAnalisis escapes news fields and guards the href scheme', () => {
  const src = read('public/index.html');
  const start = src.indexOf('async function openNewsFromAnalisis(ticker)');
  assert.notEqual(start, -1, 'openNewsFromAnalisis must still exist');
  const end = src.indexOf('\n// ===== NEWS PAGE LOADER', start);
  const body = src.slice(start, end === -1 ? src.length : end);

  assert.match(body, /escapeHtml\(item\.date \|\| ''\)/, 'date must be escaped');
  assert.match(body, /escapeHtml\(item\.title \|\| ''\)/, 'title must be escaped');
  assert.match(body, /escapeHtml\(item\.summary\)/, 'summary must be escaped');
  assert.doesNotMatch(body, /\+ \(item\.title \|\| ''\) \+/, 'raw title interpolation must be gone');

  // The shared news page renderer must scheme-guard the outbound link.
  assert.match(src, /var safeUrl = \/\^https\?:\\\/\\\/\/i\.test\(String\(item\.url \|\| ''\)\) \? item\.url : '';/, 'href must be scheme-guarded');
});