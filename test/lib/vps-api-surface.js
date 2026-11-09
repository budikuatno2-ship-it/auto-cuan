'use strict';

/**
 * test/lib/vps-api-surface.js
 * ============================================================================
 * Shared VPS API-surface regression contract (replaces the historical Vercel
 * "exactly 13 api/*.js functions" assertion).
 * ============================================================================
 * EVIDENCE (see tools/local-dev-server.js:816-940):
 *   Auto-Cuan now deploys on the VPS, whose server auto-routes EVERY top-level
 *   `api/*.js` file (today: 28 top-level handlers). The Vercel-era "13 function"
 *   budget is therefore historical. Removing or adding a top-level handler is a
 *   normal additive change, NOT a regression.
 *
 * ROUTE-REGRESSION PROTECTION (what must never be lost):
 *   1. The 13 historical endpoints must remain present.
 *   2. Every `vercel.json` `/api/*` rewrite alias must still resolve to a real
 *      handler file (a rewrite pointing at a missing file is a dead route).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const HISTORICAL_ENDPOINTS = [
  'admin-logs.js',
  'admin-users.js',
  'analyze.js',
  'bot-register.js',
  'candles.js',
  'log.js',
  'login-user.js',
  'maintenance-settings.js',
  'quote.js',
  'register-user.js',
  'reset-password.js',
  'review-access.js',
  'sector-hot.js'
];

function topLevelApiFiles() {
  return fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).sort();
}

function assertHistoricalEndpointsPresent(assert, files) {
  const list = files || topLevelApiFiles();
  for (const f of HISTORICAL_ENDPOINTS) {
    assert.ok(list.includes(f), 'historical endpoint api/' + f + ' must remain present on VPS routing');
  }
}

function assertVercelAliasesResolve(assert, files) {
  const list = files || topLevelApiFiles();
  let vercel = null;
  try {
    vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  } catch (_) {
    assert.ok(false, 'vercel.json must remain present and parseable');
    return;
  }
  for (const rule of (vercel.rewrites || [])) {
    if (!/^\/api\//.test(rule.destination || '')) continue;
    const dest = rule.destination.split('?')[0].replace(/^\/api\//, '') + '.js';
    assert.ok(list.includes(dest), 'vercel.json rewrite ' + rule.source + ' targets missing api/' + dest);
  }
}

/** Combined route-regression contract used by migrated legacy tests. */
function assertVpsApiSurface(assert) {
  const files = topLevelApiFiles();
  assertHistoricalEndpointsPresent(assert, files);
  assertVercelAliasesResolve(assert, files);
}

module.exports = {
  ROOT,
  HISTORICAL_ENDPOINTS,
  topLevelApiFiles,
  assertHistoricalEndpointsPresent,
  assertVercelAliasesResolve,
  assertVpsApiSurface
};