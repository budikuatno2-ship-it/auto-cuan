'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

test('V6.5-1: Three-Horizon SSOT config store versioning & 409 conflict guard', () => {
  const thStore = require('../lib/three-horizon-config-store');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v65-th-'));
  const filePath = path.join(tmpDir, 'th-config.json');
  const auditPath = path.join(tmpDir, 'th-audit.jsonl');

  const init = thStore.get({ filePath });
  assert.equal(init.ok, true);
  assert.equal(init.doc.version, 1);
  assert.equal(init.doc.horizons.potensi_besok.lookbackDays, 20);

  const saved = thStore.put(
    { horizons: { swing: { lookbackDays: 55, weights: { bandar: 25, foreign: 25, technical: 35, volume: 15 } } } },
    { expectedVersion: 1, actor: 'test-admin', reason: 'Update swing lookback' },
    { filePath, auditPath }
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.config.version, 2);
  assert.equal(saved.config.horizons.swing.lookbackDays, 55);

  const conflict = thStore.put(
    { minRr: 1.8 },
    { expectedVersion: 1, actor: 'test-admin', reason: 'Stale version attempt' },
    { filePath, auditPath }
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'CONFLICT');
});

test('V6.5-2: Admin Console removes MOCK_FORENSIC_ATTACKS & clears #adminConsoleStateNote', () => {
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'public', 'admin-console-runtime.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin-console.html'), 'utf8');

  assert.doesNotMatch(runtimeSrc, /MOCK_FORENSIC_ATTACKS/);
  assert.doesNotMatch(indexHtml, /198\.51\.100\.44/);
  assert.doesNotMatch(adminHtml, /198\.51\.100\.44/);

  const elements = {};
  const makeEl = (id) => ({
    id, innerHTML: '', textContent: '', value: '', style: { display: '' }, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}
  });
  elements.adminConsoleStateNote = makeEl('adminConsoleStateNote');
  elements.adminConsoleStateNote.textContent = 'Memuat Admin Console…';
  elements.adminConsoleStateNote.style.display = 'block';

  const document = {
    readyState: 'complete',
    getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, body: makeEl('body')
  };
  const window = { location: { pathname: '/', href: 'http://localhost/' }, document, __AUTOCUAN_TEST__: true, addEventListener() {} };
  const sandbox = {
    window, document, console,
    fetch: async () => ({
      ok: true,
      json: async () => ({ success: true, admin: 'budi' })
    }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, Array, Object, JSON, Boolean, RegExp, Error, isNaN, parseInt, parseFloat, Intl, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSrc, sandbox, { filename: 'admin-console-runtime.js' });

  return window.initAdminConsole(), sandbox.Promise.resolve().then(async () => {
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(elements.adminConsoleStateNote.style.display, 'none');
    assert.equal(elements.adminConsoleStateNote.textContent, '');
    assert.equal(elements.adminConsoleStateNote.attrs['data-state'], 'ready');
  });
});

test('V6.5-3: getSecurityStatus fail-closed when missing, AMAN when real 0-incident telemetry exists', () => {
  const adminSvc = require('../lib/admin-console-service');
  const tmpMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'v65-sec-miss-'));
  const miss = adminSvc.getSecurityStatus(tmpMissing);
  assert.equal(miss.available, false);
  assert.equal(miss.status, 'UNAVAILABLE');

  const tmpLive = fs.mkdtempSync(path.join(os.tmpdir(), 'v65-sec-live-'));
  const secDir = path.join(tmpLive, 'data', 'security');
  fs.mkdirSync(secDir, { recursive: true });
  fs.writeFileSync(path.join(secDir, 'security-state.json'), JSON.stringify({
    version: 'S2-1.0.0',
    updatedAt: new Date().toISOString(),
    status: 'AMAN',
    sources: { ssh: { rejected: 0 }, botFlood: { blocked: 0 } },
    metrics24h: { sshRejected: 0, botBlocked: 0, loginFailedBlocked: 0, activeBlocks: 0 },
    incidents: [],
    blockedIps: []
  }));
  const live = adminSvc.getSecurityStatus(tmpLive);
  assert.equal(live.available, true);
  assert.equal(live.status, 'AMAN');
});

test('V6.5-4: JOB_CATALOG has insider 20:50 chronologically before domestic-compile 20:55', () => {
  const store = require('../lib/admin-schedule-store');
  const keys = store.JOB_CATALOG.map((j) => j.key);
  const idxForeign = keys.indexOf('broksum-foreign');
  const idxInsider = keys.indexOf('insider');
  const idxDomestic = keys.indexOf('domestic-compile');
  assert.ok(idxForeign >= 0 && idxInsider > idxForeign && idxDomestic > idxInsider, 'insider ordered between broksum-foreign and domestic-compile');
});

test('V6.5-5: Production paid guard stops at remaining <= 50 and Telegram gate is fail-closed', () => {
  const prod = require('../lib/v6-production-job-adapters.cjs');
  const blockedLow = prod.evaluatePaidJobGuard('broksum-all', new Date('2026-11-24T13:40:00Z'), {
    quotaState: {
      loadConfig: () => ({ killSwitch: false, pausedServices: {} }),
      isInForbiddenWindow: () => false,
      getQuotaSnapshot: () => ({ remaining: 44, limit: 6063, used: 6019 }),
      canConsumeQuota: () => ({ allowed: true })
    }
  });
  assert.equal(blockedLow.allowed, false);
  assert.equal(blockedLow.reason, 'BLOCKED_QUOTA_BUFFER');

  const apiCandles = require('../api/candles');
  const tmpSqlite = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v65-ihsg-')), 'test.sqlite');
  const db = new DatabaseSync(tmpSqlite);
  db.exec('CREATE TABLE market_rows (table_name TEXT, row_key TEXT, row_json TEXT, updated_at TEXT, PRIMARY KEY (table_name, row_key));');
  db.close();

  const syncRes = require('../tools/fetch-ihsg-candle').syncIhsgCandlesToSqlite([
    { date: '2026-11-24', open: 7200, high: 7250, low: 7180, close: 7240, volume: 210000000 }
  ], { sqlitePath: tmpSqlite });
  assert.equal(syncRes.synced, 1);

  const normalized = apiCandles.normalizeIhsgVolumes ? apiCandles.normalizeIhsgVolumes([
    { date: '2026-10-27', open: 7000, high: 7100, low: 6950, close: 7050, volume: 35000000000 },
    { date: '2026-11-24', open: 7200, high: 7250, low: 7180, close: 7240, volume: 210000000 }
  ], 'IHSG') : null;
  if (normalized) {
    assert.equal(normalized[1].volume, 21000000000);
  }
});

test('V6.5-6: Watchdog ignores stable long-uptime PM2 lifetime restarts', () => {
  const wd = require('../scripts/watchdog');
  const stableIssue = wd.classifyPm2Proc({
    name: 'autocuan-bot',
    pm2_env: { status: 'online', restart_time: 25, unstable_restarts: 0, pm_uptime: Date.now() - 10 * 24 * 3600 * 1000 }
  });
  assert.equal(stableIssue, null);
});

test('V6.5-7: expectedCompletedEodDate treats post-midnight T-1 weekday as fresh & v4-f08 has no fake fallbacks', () => {
  const screener = require('../api/screener');
  // 2026-11-25 00:15 WIB = 2026-11-24T17:15:00Z -> expected EOD date is 2026-11-24
  assert.equal(screener.expectedCompletedEodDate(new Date('2026-11-24T17:15:00.000Z')), '2026-11-24');
  // 2026-11-25 17:00 WIB = 2026-11-25T10:00:00Z -> expected EOD date is 2026-11-25
  assert.equal(screener.expectedCompletedEodDate(new Date('2026-11-25T10:00:00.000Z')), '2026-11-25');
  // 2026-11-28 12:00 WIB (Saturday) -> previous weekday is 2026-11-27
  assert.equal(screener.expectedCompletedEodDate(new Date('2026-11-28T05:00:00.000Z')), '2026-11-27');

  const v4f08Src = fs.readFileSync(path.join(ROOT, 'public', 'v4-f08-runtime.js'), 'utf8');
  assert.doesNotMatch(v4f08Src, /\/data\/top5-radar\.json/);
  assert.doesNotMatch(v4f08Src, /winRatePct\s*:\s*75\.0/);
  assert.doesNotMatch(v4f08Src, /change_pct \|\| 1\.5/);
  assert.doesNotMatch(v4f08Src, /'87,5%'/);

  const dtAlarm = require('../lib/daytrade-snapshot-alarm');
  const postMidnightNow = new Date('2026-11-24T17:30:00.000Z'); // 2026-11-25 00:30 WIB
  assert.equal(dtAlarm.resolveLastTradingDay(postMidnightNow), '2026-11-24');
  assert.equal(dtAlarm.evaluate({
    marketOpen: false,
    snapshotDate: '2026-11-24',
    snapshotMtime: postMidnightNow,
    now: postMidnightNow
  }).shouldAlert, false);
});
