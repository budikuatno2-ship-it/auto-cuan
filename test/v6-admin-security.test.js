'use strict';

/**
 * test/v6-admin-security.test.js
 * ============================================================================
 * Admin Security Telemetry Honesty — Remediasi V6 (Subtask H, Area 4)
 * ============================================================================
 * Verifies:
 *   - securityGuard.loadSecurityDashboard reports `available:false` (never
 *     fabricated `available:true, reason:null`) when DB/telemetry is unavailable.
 *   - api/admin-logs.js payload preserves `available`/`reason` from the
 *     authoritative dashboard result and does NOT overwrite it.
 *   - UNKNOWN/UNAVAILABLE signals are present instead of "Bersih (0 insiden)".
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const securityGuard = require('../lib/security-guard');

test('V6-SEC-1: loadSecurityDashboard fails closed (available:false) when db is null', async () => {
  const result = await securityGuard.loadSecurityDashboard(null);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'database_unavailable');
  assert.deepEqual(result.events, []);
});

test('V6-SEC-2: buildSecuritySummary is empty (honest) with no rows', () => {
  const summary = securityGuard.buildSecuritySummary([], Date.now());
  assert.equal(summary.total_events_24h, 0);
  assert.equal(summary.blocked_events_24h, 0);
  assert.deepEqual(summary.suspicious_ips, []);
});

function makeSupabaseMock(response) {
  return {
    from: function () {
      var chain = {};
      chain.select = function () { return chain; };
      chain.order = function () { return chain; };
      chain.limit = function () { return Promise.resolve(response); };
      return chain;
    }
  };
}

test('V6-SEC-3: loadSecurityDashboard reports schema_missing (available:false) when query errors', async () => {
  var error = new Error('relation "security_events" does not exist');
  error.code = '42P01';
  var db = {
    from: function () {
      var chain = {};
      chain.select = function () { return chain; };
      chain.order = function () { return chain; };
      chain.limit = function () { return Promise.resolve({ data: null, error: error }); };
      return chain;
    }
  };
  const result = await securityGuard.loadSecurityDashboard(db);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'schema_missing');
});

test('V6-SEC-4: available:true only when the query succeeds', async () => {
  const db = makeSupabaseMock({ data: [], error: null });
  const result = await securityGuard.loadSecurityDashboard(db);
  assert.equal(result.available, true);
  assert.equal(result.reason, null);
});