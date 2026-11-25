'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('FIX 1A: Analisis & Chart defaults to combined view with Chart above Analisis AI', () => {
  const partial = read('public/partials/analisis-saham.partial.html');
  const legacyPartial = read('partials/analisis-saham.partial.html');
  assert.equal(partial, legacyPartial, 'both analisis partials must remain identical');

  const chartPos = partial.indexOf('id="panel-tab-chart"');
  const aiPos = partial.indexOf('id="panel-tab-analisis"');
  assert.ok(chartPos > 0 && aiPos > 0 && chartPos < aiPos, '#panel-tab-chart must be placed ABOVE #panel-tab-analisis');
  assert.ok(partial.includes('id="tabAnalisisCombined"'), '#tabAnalisisCombined button must exist');

  const rt = read('public/analisis-saham-runtime.js');
  assert.match(rt, /var currentAnalisisSubTab = 'combined';/, 'default subtab must be combined');
});

test('FIX 1B: Zero fabricated MA multipliers, docked drawing toolbar, clean Fib/ZigZag defaults', () => {
  const appJs = read('public/app.js');
  assert.doesNotMatch(appJs, /d\.last \* 0\.9[258]/, 'fabricated MA20/50/200 multipliers must not exist');

  const drawJs = read('public/chart-drawing-tools.js');
  assert.match(drawJs, /insertBefore\(toolbar,\s*container\)/, 'drawing toolbar docks outside canvas container');

  const mfrJs = read('public/market-feature-runtime.js');
  assert.match(mfrJs, /showFib && !_isIndexChart && !isSimplePreset/, 'Fibonacci overlay disabled in Simpel and Index modes');

  const chartApi = read('api/chart.js');
  assert.match(chartApi, /readForeignFlowSeries/, '/api/chart must include canonical SQLite foreignFlow');
});

test('FIX 2: Screener resets right detail selection on Three-Horizon switch and enriches fields', () => {
  const html = read('public/index.html');
  assert.match(html, /async function switchThreeHorizon[\s\S]{0,1400}selectedTicker = null/, 'switchThreeHorizon clears stale detail pane ticker');
  assert.doesNotMatch(html, /Swing 3-7 hari/, 'hardcoded old Swing 3-7 hari subtitle removed');

  const regen = read('tools/regenerate-local-snapshots.js');
  assert.match(regen, /group_code:/, 'snapshot generator populates group_code');
  assert.match(regen, /swing_tier:/, 'snapshot generator populates swing_tier');
  assert.match(regen, /confidence:/, 'snapshot generator populates confidence');
});

test('FIX 3: /api/admin/security-audit exists, fail-closed auth, no test-net mocks, SQLite health', async () => {
  const secAudit = require('../api/admin/security-audit');
  let status = null;
  let payload = null;
  await secAudit({ method: 'GET', headers: {} }, {
    setHeader() {},
    status(c) { status = c; return this; },
    json(b) { payload = b; }
  });
  assert.equal(status, 401, 'unauthenticated caller rejected with 401');
  assert.equal(payload.success, false);

  const devServer = read('tools/local-dev-server.js');
  assert.doesNotMatch(devServer, /endpointName === 'admin\/security-audit'/, 'preview mock stub removed from dev server');

  const adminSvc = read('lib/admin-console-service.js');
  assert.match(adminSvc, /summarizeTableFromSqlite/, 'admin health reads canonical SQLite');
  assert.match(adminSvc, /Math\.max\(0, TOTAL_UNIVERSE/, 'pending counts clamped non-negative');
});

test('FIX 4: lib/ksei-ownership-store validates, creates backup, writes active dataset, rejects garbage', () => {
  const store = require('../lib/ksei-ownership-store');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ksei-test-'));
  try {
    assert.throws(() => store.saveUploadedOwnership('not-json', {}, tmpDir), /JSON/);

    const samplePayload = [
      {
        ticker: 'BBCA',
        name: 'Bank Central Asia Tbk',
        freeFloat: '42,50%',
        investors: [
          { investorName: 'PT Dwimuria Investama Andalan', investorType: 'CORPORATE', localForeign: 'L', totalHoldingShare: '67.729.950.000', percentage: '54,94%' }
        ]
      }
    ];
    const meta1 = store.saveUploadedOwnership(samplePayload, { filename: 'oktober.json', asOf: '2026-10-30', uploadedBy: 'budi' }, tmpDir);
    assert.equal(meta1.ticker_count, 1);
    assert.equal(meta1.as_of, '2026-10-30');
    assert.equal(meta1.shareholder_rows, 1);

    const loaded = store.loadActiveOwnership(tmpDir);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].freeFloat, 42.5);
    assert.equal(loaded.items[0].investors[0].totalHoldingShare, 67729950000);

    // Second upload must archive backup of previous active file
    store.saveUploadedOwnership(samplePayload, { filename: 'november.json', asOf: '2026-11-24' }, tmpDir);
    const backups = fs.readdirSync(path.join(tmpDir, 'data', 'insider-network', 'backups'));
    assert.ok(backups.length >= 1, 'backup must be created on overwrite');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FIX 5-10: Cron catchup-0015 removed, JOB_USES_QUOTA=0 fail-closed, Watchlist & Command Palette clean', async () => {
  const cronText = read('deploy/vps/v65-live-crontab.cron');
  assert.doesNotMatch(cronText, /catchup-0015/, 'catchup-0015 must be removed from production crontab');

  const catchup = require('../tools/catchup-missing-dates');
  const stopRes = await catchup.run(['--dates', '2026-10-19'], { env: { JOB_USES_QUOTA: '0' } });
  assert.equal(stopRes.stopped, 'QUOTA_DISABLED_ENV');
  assert.equal(stopRes.spent, 0);

  const wl = read('public/watchlist-runtime.js');
  assert.match(wl, /TP_HIT:\s*'Target Profit '/, 'TP_HIT formatted in Indonesian');
  assert.match(wl, /ENTRY_ZONE:\s*'Area Beli '/, 'ENTRY_ZONE formatted in Indonesian');

  const cp = read('public/command-palette.js');
  assert.doesNotMatch(cp, /lastPrice:\s*5950/, 'hardcoded fake BELLWETHER prices removed');

  const pat = read('public/pattern-stable-runtime.js');
  assert.match(pat, /safety:\s*\{\s*actionable:\s*isAct/, 'Pattern Radar attaches real actionable flag');

  // Visual-truth V6.5.1 hotfix checks
  const idxHtml = read('public/index.html');
  const admHtml = read('public/admin-console.html');
  for (const [fname, doc] of [['public/index.html', idxHtml], ['public/admin-console.html', admHtml]]) {
    const t7 = doc.indexOf('id="panelTab7"');
    const t8 = doc.indexOf('id="panelTab8"');
    assert.ok(t7 > 0 && t8 > t7, `${fname}: panelTab7 precedes panelTab8`);
    const between = doc.slice(t7, t8);
    assert.match(between, /<\/div>\s*<!-- TAB 8: KEAMANAN/, `${fname}: panelTab7 must close before panelTab8`);
  }
  assert.doesNotMatch(idxHtml, /Swing 3&ndash;7 hari/, 'en-dash Swing 3–7 hari removed from Screener scope');

  const anaRt = read('public/analisis-saham-runtime.js');
  assert.match(anaRt, /hasServerFinancialData/, 'Financial UI uses live server snapshot even when static FINANCIAL_META is null');
  assert.match(anaRt, /root\.selectFinancialTicker[\s\S]{0,400}loadFinancialStructureTab\('financial',\s*t\)/, 'selectFinancialTicker triggers live server snapshot fetch');

  const admRt = read('public/admin-console-runtime.js');
  assert.match(admRt, /liveProviderCap/, 'Admin quota panel caps inputs to live provider telemetry');
});
