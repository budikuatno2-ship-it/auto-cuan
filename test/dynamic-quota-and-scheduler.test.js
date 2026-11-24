'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configStore = require('../lib/quota-config-store');
const policyBridge = require('../lib/quota-policy-bridge');
const quotaManager = require('../lib/quota-manager');
const quotaLimit = require('../lib/quota-limit');
const quotaState = require('../lib/quota-state');
const ledgerV3 = require('../lib/ledger-v3-classifier');
const quotaStatusHandler = require('../api/admin/quota-status');

function withIsolatedEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-quota-test-'));
  const prevEnv = {
    QUOTA_OPS_CONFIG_PATH: process.env.QUOTA_OPS_CONFIG_PATH,
    QUOTA_OPS_AUDIT_PATH: process.env.QUOTA_OPS_AUDIT_PATH,
    QUOTA_LIMIT_BLOB_PATH: process.env.QUOTA_LIMIT_BLOB_PATH
  };

  process.env.QUOTA_OPS_CONFIG_PATH = path.join(tmp, 'quota-ops-config.json');
  process.env.QUOTA_OPS_AUDIT_PATH = path.join(tmp, 'quota-ops-audit.log.jsonl');
  process.env.QUOTA_LIMIT_BLOB_PATH = path.join(tmp, 'quota-limit.json');

  policyBridge.reloadConfig();

  try {
    return fn(tmp);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    policyBridge.reloadConfig();
  }
}

test('Dynamic Quota: Pseudo-ticker exclusion is consistently 5,208 rows', () => {
  const metrics = ledgerV3.getPseudoTickerMetrics();
  assert.equal(metrics.pseudoTickerCount, 8, '8 pseudo tickers');
  assert.equal(metrics.tradingDaysCount, 217, '217 trading days');
  assert.equal(metrics.flowTypesCount, 3, '3 flow types (ALL, Foreign, Domestic)');
  assert.equal(metrics.totalExcludedRows, 5208, '8 x 217 x 3 must strictly equal 5,208');

  // Verify all 8 pseudo tickers are recognized
  const tickers = ['CURR1', 'GUARD1', 'GUARD2', 'GUARD3', 'GUARD4', 'GUARD5', 'GUARD6', 'HIST1'];
  for (const t of tickers) {
    assert.equal(ledgerV3.isPseudoTicker(t), true, `${t} must be recognized as pseudo ticker`);
    const cls = ledgerV3.classifyLedgerV3({ ticker: t });
    assert.equal(cls.status, 'FIXTURE_EXCLUDED', `${t} must be FIXTURE_EXCLUDED`);
  }
  assert.equal(ledgerV3.isPseudoTicker('BBRI'), false, 'BBRI is real ticker, not pseudo');
});

test('Dynamic Quota: configStore and policyBridge hot-reload knobs without PM2 restart', () => {
  withIsolatedEnv(() => {
    // Save a custom policy from admin console
    const putRes = configStore.put({
      configuredOperatingCap: 6000,
      reserveFloorWeekday: 4500,
      weekdayBackfillLimit: 1200,
      concurrency: 4,
      rateLimit: 8.5,
      retryCount: 5,
      backoffBaseMs: 1500,
      priorityOrder: ['broksum-ALL', 'insider-tiered', 'candles'],
      killSwitch: false,
      pausedServices: { backfill: false, broksum: false }
    }, {
      actor: 'owner-test',
      reason: 'Pusat kendali dinamis: ubah cap dan concurrency'
    });

    assert.equal(putRes.ok, true, 'Config store put succeeds');
    assert.equal(putRes.doc.concurrency, 4);
    assert.equal(putRes.doc.rateLimit, 8.5);

    // Read back through policy bridge
    policyBridge.reloadConfig();
    const effective = policyBridge.getEffectivePolicy();
    assert.equal(effective.configuredOperatingCap, 6000, 'Effective operating cap updated to 6000');
    assert.equal(effective.reserveFloorWeekday, 4500, 'Effective reserve floor updated to 4500');
    assert.equal(effective.concurrency, 4, 'Effective concurrency updated to 4');
    assert.equal(effective.rateLimit, 8.5, 'Effective rateLimit updated to 8.5');
    assert.equal(effective.retryCount, 5, 'Effective retryCount updated to 5');
    assert.equal(effective.backoffBaseMs, 1500, 'Effective backoffBaseMs updated to 1500');
    assert.deepEqual(effective.priorityOrder, ['broksum-ALL', 'insider-tiered', 'candles']);

    // Check audit history
    const auditRes = configStore.getAuditHistory(10);
    assert.equal(auditRes.ok, true);
    assert.equal(auditRes.logs.length, 1);
    assert.equal(auditRes.logs[0].actor, 'owner-test');
    assert.ok(auditRes.logs[0].timestampWIB.includes('WIB'), 'Audit record includes timestampWIB');
  });
});

test('Dynamic Quota: Backfill eligibility formula adheres to owner mandate', () => {
  withIsolatedEnv(() => {
    const fakeDate = new Date('2026-11-18T10:00:00+07:00'); // Wednesday daytime (weekday)

    // Case 1: Ample quota
    const eligible1 = policyBridge.calculateEligibleBackfill({
      now: fakeDate,
      remaining: 10000,
      mandatoryQueued: 300,
      overhead: 10
    });
    assert.ok(eligible1 > 0, 'Eligible backfill is positive when ample quota available');

    // Case 2: Remaining quota equal or below reserve floor -> backfill MUST be 0
    const eligible2 = policyBridge.calculateEligibleBackfill({
      now: fakeDate,
      remaining: 4500, // below default 5000 reserve floor
      mandatoryQueued: 0,
      overhead: 10
    });
    assert.equal(eligible2, 0, 'Backfill eligibility must be 0 when remaining < reserve floor');

    // Case 3: Unknown remaining -> returns null (fail-closed)
    const eligible3 = policyBridge.calculateEligibleBackfill({
      now: fakeDate,
      remaining: null
    });
    assert.equal(eligible3, null, 'Unknown remaining yields null (fail-closed, not 0)');
  });
});

test('Dynamic Quota: Global Emergency Kill-Switch immediately blocks requests', () => {
  withIsolatedEnv(() => {
    // Activate killSwitch
    configStore.put({
      killSwitch: true
    }, { actor: 'owner', reason: 'Emergency stop test' });

    policyBridge.reloadConfig();

    // 1. isServiceAllowed check
    const allowed = policyBridge.isServiceAllowed('broksum');
    assert.equal(allowed.allowed, false);
    assert.equal(allowed.reason, 'KILL_SWITCH_ACTIVE');

    // 2. quotaState.canConsumeQuota
    const consumeRes = quotaState.canConsumeQuota(10, 'broksum');
    assert.equal(consumeRes.ok, false);
    assert.equal(consumeRes.reason, 'KILL_SWITCH_ACTIVE');

    // 3. quotaLimit.resolveTruth
    const truth = quotaLimit.resolveTruth();
    assert.equal(truth.ok, false);
    assert.equal(truth.reason, 'KILL_SWITCH_ACTIVE');

    // 4. quotaManager.checkBackfillExecution
    const bfRes = quotaManager.checkBackfillExecution(Date.now(), { autoExit: false });
    assert.equal(bfRes.ok, false);
    assert.equal(bfRes.reason, 'KILL_SWITCH_ACTIVE');

    // 5. Backfill eligibility formula returns 0
    const bfEligible = policyBridge.calculateEligibleBackfill({ remaining: 15000 });
    assert.equal(bfEligible, 0, 'Kill-switch forces backfill eligibility to 0');
  });
});

test('Dynamic Quota: Service-specific pause flag blocks only that service', () => {
  withIsolatedEnv(() => {
    // Pause backfill only
    configStore.put({
      killSwitch: false,
      pausedServices: { backfill: true, broksum: false }
    }, { actor: 'owner', reason: 'Pause backfill only' });

    policyBridge.reloadConfig();

    const bfCheck = policyBridge.isServiceAllowed('backfill');
    assert.equal(bfCheck.allowed, false);
    assert.equal(bfCheck.reason, 'PAUSED_BY_ADMIN');

    const broksumCheck = policyBridge.isServiceAllowed('broksum');
    assert.equal(broksumCheck.allowed, true);

    const bfExec = quotaManager.checkBackfillExecution(Date.now(), { autoExit: false });
    assert.equal(bfExec.ok, false);
    assert.equal(bfExec.reason, 'PAUSED_BY_ADMIN');
  });
});

test('Dynamic Quota: quotaManager provides reloadConfig, getPolicyConfig, updatePolicyConfig', () => {
  assert.equal(typeof quotaManager.reloadConfig, 'function');
  assert.equal(typeof quotaManager.getPolicyConfig, 'function');
  assert.equal(typeof quotaManager.updatePolicyConfig, 'function');

  const policy = quotaManager.getPolicyConfig();
  assert.ok(policy != null && typeof policy === 'object');
  assert.ok('concurrency' in policy);
  assert.ok('rateLimit' in policy);
  assert.ok('priorityOrder' in policy);
  assert.ok('killSwitch' in policy);
});

test('API Endpoints: quota-status returns full provider state and dynamic policy knobs', async () => {
  let statusCode = 200;
  let responseData = null;
  const mockRes = {
    statusCode: 200,
    setHeader: () => {},
    writeHead: (code) => { statusCode = code; },
    end: (data) => { responseData = JSON.parse(data); },
    status: function (code) { statusCode = code; return this; },
    json: function (data) { responseData = data; }
  };

  await quotaStatusHandler({}, mockRes);
  assert.ok(responseData != null, 'Response received');
  assert.ok('concurrency' in responseData);
  assert.ok('rateLimit' in responseData);
  assert.ok('retryCount' in responseData);
  assert.ok('backoffBaseMs' in responseData);
  assert.ok('priorityOrder' in responseData);
  assert.ok('killSwitch' in responseData);
  assert.ok('pausedServices' in responseData);
  assert.ok('dailyReserveFloor' in responseData);
});
