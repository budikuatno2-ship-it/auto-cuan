'use strict';

/**
 * api/manual-screener.js
 * ============================================================================
 * V6 (W2b / Feature 13E) — Manual Screener endpoint.
 *
 *   POST /api/manual-screener
 *     body: { rules, limit, sort, universeCap }
 *     -> { matched:[{ticker, values, matched_rules_explanation}], total_universe,
 *          excluded_null, excluded_stale, source_as_of, query_version, ... }
 *
 * AUTH / CSRF (matches api/whats-new.js and api/admin/schedule-settings.js):
 *   - Reads require a signed session (requireAuthenticatedSession).
 *   - POST requires same-origin (isSameOrigin) in addition to the session.
 *   - The actor is always the server-signed session identity; a client-supplied
 *     user id is never trusted.
 *
 * The engine (lib/manual-screener.js) is pure JS over on-disk data — no SQL is
 * ever built from user input, so injection is structurally impossible. Input is
 * still strictly validated (field/op whitelist, numeric coercion, caps).
 * ============================================================================
 */

const { requireAuthenticatedSession, isSameOrigin } = require('../lib/admin-session');
const engine = require('../lib/manual-screener');

function json(res, code, body) {
  try {
    res.statusCode = code;
    if (res && typeof res === 'object') res.body = body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(body));
  } catch (_) {}
}

function readJsonBody(req) {
  return new Promise(function (resolve) {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let raw = '';
      req.on('data', function (c) {
        raw += String(c);
        if (raw.length > 65536) { try { req.destroy(); } catch (_) {} }
      });
      req.on('end', function () { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();

  if (method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed. Gunakan POST.' });
  }

  // CSRF: same-origin only.
  if (!isSameOrigin(req)) {
    return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
  }

  // Auth: signed session required.
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    return json(res, auth.status || 401, { success: false, error: auth.error || 'Autentikasi diperlukan.' });
  }

  let body = req.body;
  // The native router may already have consumed the request stream. Never
  // re-read a parsed null/string/array body: its end event has already fired.
  if (body === undefined && req._parsedBody === undefined) body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { success: false, error: 'JSON body harus berupa object.' });
  }

  const result = engine.runScreen({
    rules: body.rules,
    limit: body.limit,
    sort: body.sort,
    universeCap: body.universeCap,
    strictAsOf: body.strictAsOf,
    asOf: body.asOf
    // Historical reference records are server inputs, never trusted from HTTP.
  });

  if (!result.ok) {
    return json(res, 400, {
      success: false,
      error: 'Aturan tidak valid.',
      code: result.error,
      details: result.details,
      query_version: result.query_version
    });
  }

  // M-P1a: expose honest coverage + exclusion counts and the 3-valued
  // UNKNOWN bucket (excluded_unknown) so the UI can show real coverage.
  return json(res, 200, {
    success: true,
    matched: result.matched,
    total_universe: result.total_universe,
    scanned: result.scanned,
    excluded_null: result.excluded_null,
    excluded_stale: result.excluded_stale,
    excluded_synthetic: result.excluded_synthetic,
    excluded_unknown: result.excluded_unknown,
    source_as_of: result.source_as_of,
    eligibility: result.eligibility,
    eligibility_status: result.eligibility_status,
    historical_status: result.historical_status,
    historical_reason: result.historical_reason,
    historical_denominator: result.historical_denominator,
    query_version: result.query_version,
    matched_count: result.matched_count,
    returned_count: result.returned_count,
    limit: result.limit,
    universe_cap: result.universe_cap,
    universe_truncated: result.universe_truncated,
    rules_applied: result.rules_applied
  });
}

module.exports = handler;
module.exports.__test = { readJsonBody };
