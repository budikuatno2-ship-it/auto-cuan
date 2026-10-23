'use strict';

// C2 (22 Oct 2026) — CSP report collector.
//
// While the policy runs as Report-Only, browsers POST violations here. Nothing
// is written to market data; only a small, non-secret subset of each report is
// appended to data/csp-violations.jsonl (bounded). Always answers 204 so the
// reporter never retries, and never throws.

const securityHeaders = require('../lib/security-headers');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 64 * 1024) { req.destroy(); done(null); }
      });
      req.on('end', () => { try { done(JSON.parse(data || '{}')); } catch (_) { done(null); } });
      req.on('error', () => done(null));
    } catch (_) { done(null); }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end();
  }
  try {
    const body = await readBody(req);
    if (body) securityHeaders.recordCspViolation(body);
  } catch (_) { /* never fail the reporter */ }
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
};

module.exports._readBody = readBody;
