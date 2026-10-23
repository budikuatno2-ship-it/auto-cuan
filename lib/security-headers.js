'use strict';

// C2 (22 Oct 2026) — HSTS + CSP on the VPS origin.
//
// The VPS origin (tools/local-dev-server.js, reverse-proxied by nginx and
// published via Cloudflare) sent NO Content-Security-Policy and NO
// Strict-Transport-Security, unlike the paused Vercel deployment (vercel.json).
//
// Posture chosen deliberately:
//  * CSP starts as Report-Only. Enforcement on a large legacy HTML bundle with
//    inline scripts would break pages, so violations are COLLECTED first and the
//    policy is tightened before it is ever enforced.
//  * HSTS starts with a SHORT max-age and ramps up. A wrong HSTS value is hard
//    to undo (browsers cache it), so we begin at 300s and raise it gradually via
//    SECURITY_HSTS_MAX_AGE once the header is confirmed harmless.

const fs = require('fs');
const path = require('path');

const DEFAULT_HSTS_MAX_AGE = 300; // short start; ramp up after verification
const REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';
const ENFORCE_HEADER = 'Content-Security-Policy';

// Report-Only baseline. `unsafe-inline`/`unsafe-eval` and the third-party
// origins are listed so legitimate pages do NOT spam the report while the policy
// is being measured; they can be removed once the reports are clean.
const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://s3.tradingview.com https://www.googletagmanager.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https:",
  "frame-src 'self' https://s.tradingview.com https://www.tradingview.com",
  "report-uri /api/csp-report"
].join('; ');

function hstsMaxAge(env) {
  const e = env || process.env;
  const configured = Number(e.SECURITY_HSTS_MAX_AGE);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return DEFAULT_HSTS_MAX_AGE;
}

function hstsValue(env) {
  const e = env || process.env;
  // Include subdomains only once the operator opts in (default off: safest).
  const includeSub = e.SECURITY_HSTS_SUBDOMAINS === '1';
  return `max-age=${hstsMaxAge(e)}${includeSub ? '; includeSubDomains' : ''}`;
}

function cspReportOnlyValue(env) {
  const e = env || process.env;
  return e.SECURITY_CSP_REPORT_ONLY || REPORT_ONLY_CSP;
}

// Apply security headers. Safe to call multiple times; a header the caller has
// already set is not overwritten. Never throws.
function applySecurityHeaders(res, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  try {
    if (typeof res.setHeader !== 'function') return;
    if (opts.hsts !== false && !res.getHeader('Strict-Transport-Security')) {
      res.setHeader('Strict-Transport-Security', hstsValue(env));
    }
    if (opts.csp && !res.getHeader(REPORT_ONLY_HEADER) && !res.getHeader(ENFORCE_HEADER)) {
      res.setHeader(REPORT_ONLY_HEADER, cspReportOnlyValue(env));
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Violation recorder. Bounded append-only JSONL; the "write recorded violations
// after 24h" step reads this file. A hostile client could spam it, so the store
// is size-capped and only a small, non-secret subset of each report is kept.
// ---------------------------------------------------------------------------
const MAX_VIOLATION_BYTES = 2 * 1024 * 1024;

function violationsPath(env) {
  const e = env || process.env;
  return e.CSP_VIOLATIONS_FILE || path.join(__dirname, '..', 'data', 'csp-violations.jsonl');
}

function sanitizeViolation(input) {
  const raw = input && (input['csp-report'] || input[' CSP-Report'] || input) || {};
  const pick = (v, n) => String(v == null ? '' : v).replace(/[\r\n]/g, ' ').slice(0, n || 300);
  return {
    at: new Date().toISOString(),
    blocked_uri: pick(raw['blocked-uri'] || raw.blockedURI, 300),
    violated_directive: pick(raw['violated-directive'] || raw.effectiveDirective, 200),
    document_uri: pick(raw['document-uri'] || raw.documentURL, 300),
    disposition: pick(raw.disposition, 40)
  };
}

function recordCspViolation(report, env) {
  const entry = sanitizeViolation(report);
  try {
    const file = violationsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_VIOLATION_BYTES) fs.writeFileSync(file, '');
    } catch (_) { /* file does not exist yet */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (_) {}
  return entry;
}

function readCspViolations(env, limit) {
  try {
    const lines = fs.readFileSync(violationsPath(env), 'utf8').split('\n').filter(Boolean);
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const max = Number.isFinite(Number(limit)) ? Number(limit) : rows.length;
    return rows.slice(-max);
  } catch (_) { return []; }
}

function summarizeCspViolations(env) {
  const rows = readCspViolations(env);
  const byDirective = {};
  const byUri = {};
  for (const r of rows) {
    byDirective[r.violated_directive] = (byDirective[r.violated_directive] || 0) + 1;
    byUri[r.blocked_uri] = (byUri[r.blocked_uri] || 0) + 1;
  }
  return { count: rows.length, byDirective, byUri, first: rows[0] ? rows[0].at : null, last: rows[rows.length - 1] ? rows[rows.length - 1].at : null };
}

module.exports = {
  DEFAULT_HSTS_MAX_AGE,
  REPORT_ONLY_HEADER,
  ENFORCE_HEADER,
  REPORT_ONLY_CSP,
  hstsMaxAge,
  hstsValue,
  cspReportOnlyValue,
  applySecurityHeaders,
  sanitizeViolation,
  recordCspViolation,
  readCspViolations,
  summarizeCspViolations,
  violationsPath
};
