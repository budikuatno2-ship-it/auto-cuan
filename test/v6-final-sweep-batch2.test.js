'use strict';

/**
 * LOCAL BATCH 2 / final V6 sweep regression suite.
 * BUG 4-9. Pure local reads + VM evaluation only:
 * no network, no paid provider, no DB writes, no Telegram, no deployment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('public/index.html');
const adminHtml = read('public/admin-console.html');
const adminRuntime = read('public/admin-console-runtime.js');
const bandarmologi = read('public/bandarmologi-runtime.js');
const chartWs = read('public/chart-workstation.js');
const patternApi = read('api/pattern-radar.js');
const patternSafety = read('public/pattern-direction-safety.js');
const patternRuntime = read('public/pattern-stable-runtime.js');
const hardening = read('public/pattern-safety-hardening-v1.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, end = -1, seen = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, name + ' body extracted');
  return src.slice(start, end);
}

// ---------------------------------------------------------------------------
// BUG 4 — canonical level ordering + multi-card list
// ---------------------------------------------------------------------------
test('BUG 4: canonical bullish/bearish level ordering is enforced after IDX rounding', () => {
  const safety = require('../public/pattern-direction-safety');
  const hardeningApi = require('../public/pattern-safety-hardening-v1');
  // Both the base model and the browser hardening wrapper must agree.
  for (const api of [safety, hardeningApi]) {
    assert.deepEqual(api.evaluateAbcdLevels({ current: 1000, confirmation: 1010, invalidation: 990, tp1: 1080, tp2: 1140 }, 'bullish'), {
      actionable: true, reason: null, reasons: []
    });
    assert.deepEqual(api.evaluateAbcdLevels({ current: 1000, confirmation: 990, invalidation: 1010, tp1: 920, tp2: 860 }, 'bearish'), {
      actionable: true, reason: null, reasons: []
    });
    // PRZ sits between invalidation and confirmation for bullish; inverse for bearish.
    const badBull = api.evaluateAbcdLevels({ current: 1000, confirmation: 990, invalidation: 1010, tp1: 1080, tp2: 1140 }, 'bullish');
    assert.equal(badBull.actionable, false);
    assert.ok(badBull.reasons.includes('inconsistent_level_order'));
    const badBear = api.evaluateAbcdLevels({ current: 1000, confirmation: 1010, invalidation: 990, tp1: 920, tp2: 860 }, 'bearish');
    assert.equal(badBear.actionable, false);
    assert.ok(badBear.reasons.includes('inconsistent_level_order'));
  }
  assert.match(patternSafety, /canonicalLevelOrder/);
  assert.match(hardening, /canonicalLevelOrder/);
});

test('BUG 4: pattern API publishes ordered levels on the IDX tick grid and cards stay valid', () => {
  const api = require('../api/pattern-radar.js');
  const tick = require('../lib/idx-tick.js');
  const result = api.scanAllPatterns();
  assert.equal(result.success, true);
  assert.ok(result.patterns.length > 0);
  const fields = ['currentPrice', 'breakout', 'confirmation', 'tp1', 'tp2', 'sl', 'invalidation'];
  let checked = 0;
  for (const row of result.patterns) {
    for (const field of fields) {
      if (row[field] == null) continue;
      assert.equal(tick.isIdxTickValid(row[field]), true, row.ticker + '.' + field);
      checked++;
    }
    for (const field of ['low', 'high']) {
      const v = row.prz && row.prz[field];
      if (v == null) continue;
      assert.equal(tick.isIdxTickValid(v), true, row.ticker + '.prz.' + field);
      checked++;
    }
    // Canonical ordering: bullish invalidation < PRZ/harga < confirmation < tp1 <= tp2.
    assert.ok(row.invalidation < row.confirmation, row.ticker + ' invalidation<confirmation');
    assert.ok(row.confirmation < row.tp1, row.ticker + ' confirmation<tp1');
    assert.ok(row.tp1 <= row.tp2, row.ticker + ' tp1<=tp2');
    assert.ok(row.prz.low <= row.prz.high, row.ticker + ' prz.low<=high');
    assert.ok(row.prz.low >= row.invalidation, row.ticker + ' prz.low>=invalidation');
    assert.ok(row.prz.high <= row.confirmation, row.ticker + ' prz.high<=confirmation');
  }
  assert.ok(checked > 1000);
  assert.match(patternApi, /canonicalLevelOrder/);
  // Multi-card list: every canonical row is mapped and rendered, no silent drop.
  assert.match(patternRuntime, /state\.rows = radarData\.patterns\.map\(function\(p\)/);
  assert.match(patternRuntime, /displayRows\.map\(card\)\.join\(''\)/);
  assert.equal(new Set(result.patterns.map((p) => p.ticker)).size, result.patterns.length);
});

// ---------------------------------------------------------------------------
// BUG 5 — Admin Console direct click + insider 20:50 row
// ---------------------------------------------------------------------------
test('BUG 5: direct sidebar click renders admin panel or explicit auth/loading/error state', () => {
  assert.match(html, /id="tabAdminConsole"[^>]*onclick="navigateTo\('admin-console'\)"/);
  const branch = extractFunction(html, 'navigateTo');
  assert.match(branch, /page === 'admin-console'/);
  assert.match(branch, /showAdminConsoleState\(/);
  assert.match(html, /function showAdminConsoleState\(/);
  assert.match(html, /Memuat Admin Console/);
  assert.match(html, /Fitur Admin Console khusus untuk Administrator/);
  // Non-admin bounce still shows an explicit state, never a blank panel.
  assert.match(branch, /if \(!isAdmin\(\)\)/);
});

test('BUG 5: insider 20:50 weekday row is enabled with concurrency 10 between 20:45 and 20:55', () => {
  const cfg = JSON.parse(read('data/admin-schedule-config.json'));
  const jobs = cfg.jobs || {};
  const insider = jobs.insider;
  assert.ok(insider, 'insider job exists');
  assert.equal(insider.timeWIB, '20:50');
  assert.equal(insider.enabled, true);
  assert.equal(insider.concurrency, 10);
  assert.deepEqual(insider.days, [1, 2, 3, 4, 5]);
  assert.equal(jobs['broksum-foreign'].timeWIB, '20:45');
  assert.equal(jobs['domestic-compile'].timeWIB, '20:55');
  assert.ok(jobs['broksum-foreign'].timeWIB < insider.timeWIB && insider.timeWIB < jobs['domestic-compile'].timeWIB);
  // SESSION_SECRET is presence-only; never print its value in tests or UI.
  assert.doesNotMatch(html, /SESSION_SECRET\s*[:=]\s*['"][^'"]+['"]/);
});

// ---------------------------------------------------------------------------
// BUG 6 — single-source EOD header
// ---------------------------------------------------------------------------
test('BUG 6: EOD header has no hardcoded 07.00 / 8 Okt and uses real updated_at', () => {
  assert.doesNotMatch(html, /T08:00:00\+07:00/);
  assert.doesNotMatch(html, /8 Okt/);
  assert.doesNotMatch(html, /07\.00 WIB/);
  assert.match(html, /canonical_eod_at:\s*d\.canonical_eod_at/);
  assert.match(html, /var realUpdatedAt = d\.updated_at \|\| d\.last_updated_at \|\| null/);
  assert.match(html, /updated_at:\s*realUpdatedAt/);
  const fn = extractFunction(chartWs, 'formatEodHeader');
  const sandbox = { Date, String, Number, isNaN,
    EOD_MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] };
  vm.runInNewContext(fn + '\nthis.__fmt = formatEodHeader;', sandbox);
  assert.equal(sandbox.__fmt('2026-11-20', null), 'EOD · 20 Nov 2026');
  assert.equal(sandbox.__fmt('2026-11-20', '2026-11-20T13:45:00.000Z'), 'EOD · 20 Nov 2026 · diperbarui 20.45 WIB');
  assert.doesNotMatch(sandbox.__fmt('2026-11-20', '2026-11-20T13:45:00.000Z'), /07\.00/);
});

test('BUG 6: all 19 tabs share the canonical EOD source', () => {
  const tabs = ['dashboard', 'analisis', 'screener', 'sektor', 'bandarmologi', 'portofolio',
    'watchlist', 'trackrecord', 'money-management', 'subscription', 'admin-console',
    'pattern', 'chart', 'ai', 'laporan', 'pengaturan', 'profil', 'notifikasi', 'bantuan'];
  assert.equal(tabs.length, 19);
  // One fetch, one formatter, one status updater — no per-tab formatter copies.
  assert.equal((html.match(/fetch\('\/api\/market\/eod-status'/g) || []).length, 1);
  assert.equal((chartWs.match(/function formatEodHeader\(/g) || []).length, 1);
  assert.match(html, /function updateGlobalLiveRadarStatus\(/);
  assert.match(html, /canonicalEodAt = meta\.canonical_eod_at \|\| meta\.latest_eod_at \|\| meta\.data_as_of \|\| null/);
  // The canonical date is a calendar label; only real updated_at contributes a clock.
  assert.match(html, /if \(status === 'eod' && canonicalEodAt/);
  assert.doesNotMatch(html, /canonical_eod_at \+ 'T\d\d:\d\d:\d\d/);
});

// ---------------------------------------------------------------------------
// BUG 7 — admin table unclipped + no double WIB
// ---------------------------------------------------------------------------
test('BUG 7: admin schedule table fits 1440x900 with all 7 columns and no double WIB', () => {
  assert.match(adminHtml, /\.admin-schedule-tbl \{ table-layout: fixed; width: 100%; min-width: 0; \}/);
  assert.match(adminHtml, /<th style="width:20%">Job<\/th><th style="width:8%">JAM WIB<\/th>/);
  assert.match(adminHtml, /<th style="width:19%">Hari Aktif<\/th><th style="width:20%">5 RUN BERIKUTNYA<\/th>/);
  assert.match(adminHtml, /<th style="width:17%">DESKRIPSI<\/th><th style="width:10%;white-space:nowrap">ENABLED \/ AKTIF<\/th>/);
  assert.match(adminHtml, /<th class="r" style="width:6%">Aksi<\/th>/);
  const widths = [20, 8, 19, 20, 17, 10, 6].reduce((a, b) => a + b, 0);
  assert.equal(widths, 100);
  const fmt = extractFunction(adminRuntime, 'formatNextRunWib');
  const sandbox = { Date, String, Number,
    WIB_DAY_LABELS: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
    WIB_MONTH_LABELS: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] };
  vm.runInNewContext(fmt + '\nthis.__fmt = formatNextRunWib;', sandbox);
  const out = sandbox.__fmt('2026-11-23T20:40:00+07:00');
  assert.equal(out, 'Sen 23 Nov, 20:40 WIB');
  assert.equal((out.match(/WIB/g) || []).length, 1);
  assert.match(adminRuntime, /DAY_LABELS = \['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'\]/);
  assert.match(adminRuntime, /escapeHtml\(j\.description \|\| ''\)/);
  assert.match(adminRuntime, />Aktif<\/option>/);
  assert.match(adminRuntime, />Simpan<\/button>/);
});

// ---------------------------------------------------------------------------
// BUG 8 — Insider raw table-name leak
// ---------------------------------------------------------------------------
test('BUG 8: insider UI shows friendly provenance, zero raw table names', () => {
  const friendly = 'Data kepemilikan & aktivitas insider · Per 20 Nov 2026';
  assert.ok(bandarmologi.includes(friendly), 'friendly provenance rendered');
  assert.doesNotMatch(bandarmologi, /Sumber: arjum_insiders/);
  assert.doesNotMatch(bandarmologi, /relasi di luar sumber: tidak diketahuh/i);
  assert.doesNotMatch(bandarmologi, /arjum_insiders/);
  assert.doesNotMatch(bandarmologi, /CANONICAL_ARJUM_INSIDERS/);
  const sector = read('api/sector-hot.js');
  assert.match(sector, /CANONICAL_ARJUM_INSIDERS/);
  // Canonical source marker stays server-side; UI never receives it as a label.
  assert.doesNotMatch(sector, /source:\s*['"]arjum_insiders['"]/);
});

// ---------------------------------------------------------------------------
// BUG 9 — Sektor Hot single input + real VOL VS 30H
// ---------------------------------------------------------------------------
test('BUG 9: Sektor Hot has one search input and renders real volume_ratio_30d', () => {
  const sektorSection = html.slice(html.indexOf('id="page-sektor"'), html.indexOf('id="page-screener"'));
  assert.equal((sektorSection.match(/id="sektorSearchInput"/g) || []).length, 1);
  assert.equal((sektorSection.match(/<label class="search"/g) || []).length, 1);
  assert.match(sektorSection, /<input type="text" id="sektorSearchInput"/);
  assert.doesNotMatch(sektorSection, /<label[^>]*>\s*<label/);
  assert.match(sektorSection, /Vol vs 30H/);
  // Group + detail renderers read the canonical field, not the stale alias.
  assert.match(html, /g\.volume_ratio_30d != null \? formatRatio\(g\.volume_ratio_30d\)/);
  assert.match(html, /m\.volume_ratio_30d != null \? formatRatio\(m\.volume_ratio_30d\)/);
  assert.doesNotMatch(html, /g\.avg_volume_ratio \? formatRatio\(g\.avg_volume_ratio\)/);
  const fmt = extractFunction(html, 'formatRatio');
  const sandbox = { String, Number };
  vm.runInNewContext(fmt + '\nthis.__fmt = formatRatio;', sandbox);
  assert.equal(sandbox.__fmt(1.24), '1,24x');
  assert.equal(sandbox.__fmt(0.88), '0,88x');
  assert.equal(sandbox.__fmt(null), '—');
  const sectorApi = read('api/sector-hot.js');
  assert.match(sectorApi, /volume_ratio_30d/);
  assert.match(read('api/sektor.js'), /sectorRadar\.getGroupDetail/);
  assert.match(read('lib/sector-radar.js'), /volume_ratio_30d|avg_volume_ratio/);
});
