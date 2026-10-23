'use strict';

// C2 (22 Oct 2026) — the VPS origin sent no HSTS and no CSP (vercel.json had both
// but the VPS server did not). These tests pin: a short-start HSTS, a Report-Only
// CSP (never enforce by default), a working report collector, and the wiring of
// the headers into the HTML surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sh = require('../lib/security-headers');
const cspHandler = sh.handleCspReport;

function mockRes() {
  return {
    headers: {},
    statusCode: 0,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    end() { return this; }
  };
}

test('C2: HSTS starts with a SHORT max-age and ramps up via SECURITY_HSTS_MAX_AGE', () => {
  assert.equal(sh.hstsMaxAge({}), sh.DEFAULT_HSTS_MAX_AGE);
  assert.ok(sh.DEFAULT_HSTS_MAX_AGE <= 600, 'start short so a mistake is reversible');
  assert.equal(sh.hstsMaxAge({ SECURITY_HSTS_MAX_AGE: '31536000' }), 31536000);
  assert.equal(sh.hstsValue({}), 'max-age=300');
  // includeSubDomains is opt-in only.
  assert.equal(sh.hstsValue({ SECURITY_HSTS_SUBDOMAINS: '1' }), 'max-age=300; includeSubDomains');
});

test('C2: the CSP default is Report-Only, never enforced', () => {
  const res = mockRes();
  sh.applySecurityHeaders(res, { csp: true, env: {} });
  assert.ok(res.headers['strict-transport-security'], 'HSTS must be set');
  assert.ok(res.headers['content-security-policy-report-only'], 'Report-Only CSP must be set');
  assert.equal(res.headers['content-security-policy'], undefined, 'CSP must NOT be enforced yet');
  const policy = res.headers['content-security-policy-report-only'];
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /report-uri \/api\/csp-report/);
});

test('C2: applySecurityHeaders never overwrites a header the caller already set', () => {
  const res = mockRes();
  res.setHeader('Strict-Transport-Security', 'max-age=999');
  sh.applySecurityHeaders(res, { csp: false, env: {} });
  assert.equal(res.headers['strict-transport-security'], 'max-age=999');
  assert.equal(res.headers['content-security-policy-report-only'], undefined);
});

test('C2: the collector records a bounded, non-secret subset of a violation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-'));
  const file = path.join(tmp, 'violations.jsonl');
  const env = { CSP_VIOLATIONS_FILE: file };
  const entry = sh.recordCspViolation({
    'csp-report': {
      'blocked-uri': 'https://evil.example/x',
      'violated-directive': "script-src 'self'",
      'document-uri': 'https://example/page',
      disposition: 'report'
    }
  }, env);
  assert.equal(entry.blocked_uri, 'https://evil.example/x');
  assert.equal(entry.violated_directive, "script-src 'self'");
  const summary = sh.summarizeCspViolations(env);
  assert.equal(summary.count, 1);
  assert.equal(summary.byUri['https://evil.example/x'], 1);
  // The stored record must not carry cookies/headers/tokens.
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /cookie|authorization|token/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C2: the report endpoint answers 204 and never throws on junk input', async () => {
  const req = { method: 'POST', body: { 'csp-report': { 'blocked-uri': 'x', 'violated-directive': 'y' } }, on() {} };
  const res = mockRes();
  await cspHandler(req, res);
  assert.equal(res.statusCode, 204);

  const res2 = mockRes();
  await cspHandler({ method: 'GET', on() {} }, res2);
  assert.equal(res2.statusCode, 405);
});

test('C2: the server wires security headers for HTML and routes /api/csp-report via lib/', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'local-dev-server.js'), 'utf8');
  assert.match(src, /applySecurityHeaders\(res,/);
  assert.match(src, /handleCspReport\(req, res\)/);
  // The collector lives in lib/ so the fixed api/ budget is not exceeded.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'api', 'csp-report.js')));
});

test('C2: no enforcement CSP header is emitted anywhere yet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'security-headers.js'), 'utf8');
  assert.match(src, /Content-Security-Policy-Report-Only/);
  // The enforce constant may be referenced for the "already set" guard, but must
  // never be the header we WRITE.
  assert.doesNotMatch(src, /setHeader\(ENFORCE_HEADER/);
});
