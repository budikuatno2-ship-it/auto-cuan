'use strict';

/**
 * test/v6-quota-policy-bridge.test.js
 * ============================================================================
 * V6 (Subtask E) — AUTHORITATIVE POLICY BRIDGE CONTRACT
 * ============================================================================
 * Proves the P0 fix: an admin PUT (reserve=1200) into the durable ops-config
 * store is read back through ONE authoritative bridge by EVERY consumer:
 *   quota-config-store -> quota-policy-bridge -> quota-manager
 *                                            -> quota-state (canConsumeQuota)
 *                                            -> worker policy
 * Also proves: no automatic 20:30 WIB reserve release (obligation-verified or
 * admin waiver only), weekend policy isolation, unknown != zero, and real
 * request gating with the bridged values.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-bridge-')); }

function freshEnv(tmp) {
  const prev = {
    QUOTA_OPS_CONFIG_PATH: process.env.QUOTA_OPS_CONFIG_PATH,
    QUOTA_OPS_AUDIT_PATH: process.env.QUOTA_OPS_AUDIT_PATH,
    QUOTA_RESERVE_WAIVER_PATH: process.env.QUOTA_RESERVE_WAIVER_PATH,
    QUOTA_OBLIGATION_LEDGER_PATH: process.env.QUOTA_OBLIGATION_LEDGER_PATH,
    QUOTA_LIMIT_BLOB_PATH: process.env.QUOTA_LIMIT_BLOB_PATH
  };
  process.env.QUOTA_OPS_CONFIG_PATH = path.join(tmp, 'quota-ops-config.json');
  process.env.QUOTA_OPS_AUDIT_PATH = path.join(tmp, 'quota-ops-audit.jsonl');
  process.env.QUOTA_RESERVE_WAIVER_PATH = path.join(tmp, 'waiver.json');
  process.env.QUOTA_OBLIGATION_LEDGER_PATH = path.join(tmp, 'obligations.json');
  process.env.QUOTA_LIMIT_BLOB_PATH = path.join(tmp, 'quota-limit.json');
  return prev;
}

function restoreEnv(prev) {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function reload(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function reloadAll() {
  const bridge = reload(path.join(ROOT, 'lib', 'quota-policy-bridge.js'));
  const store = reload(path.join(ROOT, 'lib', 'quota-config-store.js'));
  const limit = reload(path.join(ROOT, 'lib', 'quota-limit.js'));
  const manager = reload(path.join(ROOT, 'lib', 'quota-manager.js'));
  return { bridge, store, limit, manager };
}

/**
 * Seed a MOCK provider snapshot (fresh, verified) into the redirected blob
 * path — no live provider. used is the provider-reported usage.
 */
function seedProviderSnapshot(limit, used, verifiedAtIso) {
  const ql = require(path.join(ROOT, 'lib', 'quota-limit.js'));
  const blob = ql.blankBlob();
  const at = verifiedAtIso || '2026-11-06T04:00:00.000Z'; // 11:00 WIB, fresh vs all test clocks
  blob.providerLimit = limit;
  blob.providerLimitVerifiedAt = at;
  blob.providerPeriodUsed = used;
  blob.providerPeriodUsedVerifiedAt = at;
  blob.providerPeriodUsedWibDate = '2026-11-06';
  blob.planExpiresAt = '2026-11-17T23:59:59+07:00';
  fs.mkdirSync(path.dirname(process.env.QUOTA_LIMIT_BLOB_PATH), { recursive: true });
  fs.writeFileSync(process.env.QUOTA_LIMIT_BLOB_PATH, JSON.stringify(blob));
}

// Weekday 12:00 WIB = 2026-11-06T05:00:00Z (Fri). Weekend = 2026-11-07 (Sat).
const WD_NOON = new Date('2026-11-06T05:00:00Z');
const WD_2029 = new Date('2026-11-06T13:30:00Z'); // 20:30 WIB exactly
const WD_2100 = new Date('2026-11-06T14:00:00Z'); // 21:00 WIB
const WK_SAT = new Date('2026-11-07T05:00:00Z');  // Saturday 12:00 WIB

/* ========================================================================== */
/* A. B) Policy bridge: admin save -> store readback -> manager -> worker gate */
/* ========================================================================== */

test('P0 fix: PUT reserveFloorWeekday=1200 -> manager reserved=1200 (not 5000)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { store, manager } = reloadAll();
    seedProviderSnapshot(12000, 100); // mock provider: limit 12000, used 100

    // Admin saves reserve=1200 (canonical authorized path, versioned).
    const put = store.put({ reserveFloorWeekday: 1200 }, { actor: 'budi', reason: 'subtask E bridge proof' });
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.equal(put.doc.reserveFloorWeekday, 1200);
    assert.equal(put.readbackOk, true, 'durable readback');

    // quota-manager MUST now report reserved=1200 (previously stuck at 5000).
    const status = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 100, upstreamDailyLimit: 12000 });
    assert.equal(status.reserved, 1200, 'manager reads the ops store via bridge, got ' + status.reserved);
    assert.equal(status.policy.reserveFloorWeekday, 1200);
    assert.equal(status.policy.sources.reserveFloorWeekday, 'ops-store', 'source provenance = ops-store');
    assert.equal(status.policy.storeVersion, 1);

    // available_for_backfill respects the bridged reserve: 12000-100-1200.
    assert.equal(status.available_for_backfill, 12000 - 100 - 1200);
  } finally { restoreEnv(prev); }
});

test('worker gating uses the SAME bridged value (simulated request gate)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { store, manager } = reloadAll();
    seedProviderSnapshot(12000, 10900); // mock provider: near reserve
    store.put({ reserveFloorWeekday: 1200 }, { actor: 'budi', reason: 'gate' });

    // Provider says limit 12000, used 10900 -> remaining 1100 < reserve 1200.
    const status = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 10900, upstreamDailyLimit: 12000 });
    assert.equal(status.remaining, 1100);
    assert.equal(status.reserved, 1200);
    assert.equal(status.available_for_backfill, 0, 'backfill budget floored to 0 (reserve protected)');
    assert.equal(status.backfillLocked, true);
    assert.equal(status.lockReason, 'RESERVE_FLOOR_OR_EXHAUSTED');

    // A real backfill check FAIL-CLOSES: no execution under the floor.
    const gate = manager.checkBackfillExecution(WD_NOON, { autoExit: false, state: { currentDateWIB: '2026-11-06', upstreamUsedToday: 10900, upstreamDailyLimit: 12000 } });
    assert.equal(gate.ok, false, 'backfill must be blocked at/below reserve floor');
  } finally { restoreEnv(prev); }
});

/* ========================================================================== */
/* C. Weekend policy is separate; workers read new value on next read          */
/* ========================================================================== */

test('weekend reserve set by admin is picked up without restart; weekday default does not leak to weekend', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { store, manager, bridge } = reloadAll();
    seedProviderSnapshot(12000, 0);

    // Default weekend floor is 0 (no weekday leak).
    assert.equal(bridge.reserveFloorFor(WK_SAT), 0);
    const st0 = manager.getQuotaStatus(WK_SAT, { currentDateWIB: '2026-11-07', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st0.reserved, 0);

    // Admin changes weekend reserve to 800 -> workers read the new value at
    // next policy read (no process restart).
    const put = store.put({ reserveFloorWeekend: 800 }, { actor: 'budi', reason: 'weekend policy' });
    assert.equal(put.ok, true);

    assert.equal(bridge.reserveFloorFor(WK_SAT), 800, 'weekend bridge now 800');
    const st1 = manager.getQuotaStatus(WK_SAT, { currentDateWIB: '2026-11-07', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st1.reserved, 800, 'worker/manager read new weekend value on reload');
    assert.equal(st1.policy.sources.reserveFloorWeekend, 'ops-store');

    // Weekday floor remains the default 5000 (untouched field).
    const stWd = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(stWd.reserved, 5000, 'weekday default 5000 intact');
    assert.equal(stWd.policy.sources.reserveFloorWeekday, 'legacy-config');
  } finally { restoreEnv(prev); }
});

/* ========================================================================== */
/* 2. NO automatic 20:30 WIB reserve release (obligation/waiver verified only) */
/* ========================================================================== */

test('reserve is NOT released at 20:29 / 20:30 / 21:00 WIB while Broksum pending', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { bridge, manager } = reloadAll();

    for (const [label, t] of [['20:29 WIB', new Date('2026-11-06T13:29:00Z')], ['20:30 WIB', WD_2029], ['21:00 WIB', WD_2100]]) {
      const release = bridge.canReleaseReserve(t);
      assert.equal(release.ok, false, label + ': reserve must stay held');
      assert.equal(release.reason, 'OBLIGATIONS_PENDING');
      assert.equal(release.evidence.obligations['broksum-ALL'], 'PENDING');

      // Manager mirrors the held floor at all three times.
      const st = manager.getQuotaStatus(t, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
      assert.equal(st.reserved, 5000, label + ': manager still holds 5000 (was auto-released to 0 before)');
    }
  } finally { restoreEnv(prev); }
});

test('reserve releases ONLY when all mandatory obligations are EXECUTED_AND_READBACK_VERIFIED', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { bridge, manager } = reloadAll();
    const t = WD_2029; // 20:30 WIB
    const dateKey = '2026-11-06';

    // Partial verification is NOT enough.
    bridge.markObligation(dateKey, 'broksum-ALL', 'EXECUTED_AND_READBACK_VERIFIED');
    assert.equal(bridge.canReleaseReserve(t).ok, false, 'partial obligations hold the reserve');

    // Full verified completion releases.
    bridge.markObligation(dateKey, 'broksum-Foreign', 'EXECUTED_AND_READBACK_VERIFIED');
    bridge.markObligation(dateKey, 'insider-tiered', 'EXECUTED_AND_READBACK_VERIFIED');
    const rel = bridge.canReleaseReserve(t);
    assert.equal(rel.ok, true);
    assert.equal(rel.reason, 'OBLIGATIONS_VERIFIED');
    assert.equal(bridge.reserveFloorFor(t), 0, 'floor 0 after verified obligations');
    const st = manager.getQuotaStatus(t, { currentDateWIB: dateKey, upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st.reserved, 0);

    // Only RUNNING/FAILED states never release.
    bridge.markObligation(dateKey, 'insider-tiered', 'RUNNING');
    assert.equal(bridge.canReleaseReserve(t).ok, false);
    assert.equal(bridge.reserveFloorFor(t), 5000);
  } finally { restoreEnv(prev); }
});

test('admin waiver releases the reserve explicitly (audited, per WIB date)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { bridge } = reloadAll();
    const t = WD_2029;

    const w = bridge.grantReserveWaiver({ actor: 'budi', reason: 'release for deep backfill', dateWIB: '2026-11-06' });
    assert.equal(w.ok, true);
    const rel = bridge.canReleaseReserve(t);
    assert.equal(rel.ok, true);
    assert.equal(rel.reason, 'ADMIN_WAIVER');
    assert.equal(bridge.reserveFloorFor(t), 0);

    // Waiver is date-scoped: other days still hold the floor.
    assert.equal(bridge.reserveFloorFor(new Date('2026-11-13T13:30:00Z')), 5000);

    // Invalid waiver input is rejected (fail-closed).
    assert.equal(bridge.grantReserveWaiver({ actor: '', reason: 'x' }).ok, false);
    assert.equal(bridge.grantReserveWaiver({ actor: 'budi', reason: '' }).ok, false);
    assert.equal(bridge.grantReserveWaiver({ actor: 'budi', reason: 'x', dateWIB: 'bad' }).ok, false);
  } finally { restoreEnv(prev); }
});

/* ========================================================================== */
/* E. Provider unknown != zero; zero != unknown (policy layer never coerces)   */
/* ========================================================================== */

test('policy/manager: unknown provider value stays UNKNOWN (null), never 0', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { manager } = reloadAll();
    const st = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: null, upstreamDailyLimit: null });
    // usage unknown -> remaining unknown; available_for_backfill null (NOT 0).
    assert.equal(st.usageKnown, false);
    assert.equal(st.used, null, 'unknown usage is null');
    assert.equal(st.available_for_backfill, null, 'backfill budget UNKNOWN != 0');
    assert.equal(st.backfillLocked, false, 'unknown does not fabricate a lock-by-zero state');
    // Policy floor itself is still concrete (it is admin policy, not provider truth).
    assert.equal(st.reserved, 5000);
    assert.ok(st.policy.release.reason === 'OBLIGATIONS_PENDING');
  } finally { restoreEnv(prev); }
});

test('measured zero provider usage is a KNOWN zero, distinct from unknown', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { manager } = reloadAll();
    seedProviderSnapshot(12000, 0); // measured zero usage
    const st = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st.usageKnown, true);
    assert.equal(st.used, 0);
    assert.equal(st.remaining, 12000);
    assert.equal(st.available_for_backfill, 7000, '12000 - 5000 reserve = 7000 (weekday default)');
  } finally { restoreEnv(prev); }
});

/* ========================================================================== */
/* B. quota-state (canConsumeQuota path) reads the SAME bridged policy         */
/* ========================================================================== */

test('quota-state loadConfig overlays ops-store policy (same contract as manager)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    reloadAll(); // ensure store cache is fresh with env redirect
    const store = require(path.join(ROOT, 'lib', 'quota-config-store.js'));
    store.put({ reserveFloorWeekday: 1200 }, { actor: 'budi', reason: 'quota-state overlay' });

    const qs = reload(path.join(ROOT, 'lib', 'quota-state.js'));
    const cfg = qs.loadConfig();
    assert.equal(cfg.reserveFloorWeekday, 1200, 'quota-state sees the admin value via bridge');
    assert.equal(cfg.policySources.reserveFloorWeekday, 'ops-store');

    // reserveFloorFor inside quota-state agrees with the bridge.
    assert.equal(qs.reserveFloorFor(WD_NOON), 1200);
  } finally { restoreEnv(prev); }
});

/* ========================================================================== */
/* F. Near-cap, reset, plan expiry edge behaviors through the manager          */
/* ========================================================================== */

test('near-cap request: remaining 0 -> backfillLocked with reserve reason, budget 0 (not negative)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { manager } = reloadAll();
    seedProviderSnapshot(12000, 12000); // fully consumed
    const st = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 12000, upstreamDailyLimit: 12000 });
    assert.equal(st.remaining, 0);
    assert.equal(st.overage, 0);
    assert.equal(st.available_for_backfill, 0);
    assert.equal(st.backfillLocked, true);
  } finally { restoreEnv(prev); }
});

test('plan expiry surfaces through policy (bridge reads ops-store/legacy)', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { store, manager } = reloadAll();
    store.put({ planExpiresAt: '2026-11-17T23:59:59+07:00', planName: 'Supporter' }, { actor: 'budi', reason: 'plan meta' });
    const st = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st.package_expiry, '2026-11-17T23:59:59+07:00', 'expiry from ops store via bridge');
  } finally { restoreEnv(prev); }
});

test('WIB reset instant is next midnight +07:00 through the bridged manager', () => {
  const tmp = tmpdir();
  const prev = freshEnv(tmp);
  try {
    const { manager } = reloadAll();
    const st = manager.getQuotaStatus(WD_NOON, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 12000 });
    assert.equal(st.reset_at, '2026-11-06T17:00:00.000Z');
    assert.equal(st.usage_date, '2026-11-06');
  } finally { restoreEnv(prev); }
});
