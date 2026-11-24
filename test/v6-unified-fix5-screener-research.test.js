'use strict';

/**
 * FIX 5 regression: canonical Screener freshness + honest 9-tab research audit.
 * No network, no DB writes, no paid provider calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const screener = require('../api/screener.js');
const canonical = require('../lib/canonical-screener-source.js');
const tick = require('../lib/idx-tick.js');

const payload = screener.buildScreenerPayload();

test('Screener is bound to the canonical 20 Nov regeneration, not the 3 Nov snapshot', () => {
  assert.equal(payload.success, true);
  assert.equal(payload.trade_date, '2026-11-20');
  assert.equal(payload.canonical_screener.status, 'OK');
  assert.equal(payload.canonical_screener.trade_date, '2026-11-20');
  assert.equal(payload.canonical_screener.verified, true);
  assert.match(payload.canonical_screener.sha256, /^4ec75c3b/);
  assert.ok(payload.results.length > 900);
  assert.equal(payload.categories_meta.konglo.canonical_source, payload.canonical_screener.data_source);
  const source = read('api/screener.js');
  assert.match(source, /canonical-screener-source/);
  assert.match(source, /useCanonical/);
});

test('no published row carries the stale 3 Nov / 4 Nov snapshot or BBCA 9860', () => {
  for (const row of payload.results) {
    assert.notEqual(row.trade_date, '2026-11-03', `${row.ticker} trade_date`);
    assert.notEqual(row.trade_date, '2026-11-04', `${row.ticker} trade_date`);
    assert.notEqual(row.source_file, 'data/screener-v3f04-konglo.json', row.ticker);
    assert.notEqual(row.source_file, 'data/screener-v3f04-nonkonglo.json', row.ticker);
    assert.notEqual(row.last_price, 9860, `${row.ticker} price`);
  }
  const bbca = payload.results.find((r) => r.ticker === 'BBCA');
  assert.ok(bbca, 'BBCA must be published');
  assert.equal(bbca.last_price, 5550);
  assert.equal(bbca.trade_date, '2026-11-20');
  assert.equal(tick.isIdxTickValid(bbca.last_price), true);
});

test('the local regeneration is hash-pinned, measured, and wrote no DB', () => {
  const meta = canonical.getCanonicalScreenerMeta();
  assert.equal(meta.status, 'OK');
  assert.equal(meta.verified, true);
  assert.equal(meta.rows, 921);
  assert.equal(meta.trade_date, '2026-11-20');
  const regen = JSON.parse(read('audit-evidence/v6_recovery_17nov/unified_final_20261122_v1/fix4_5/local_regeneration_metadata.json'));
  assert.equal(regen.paid_api_calls, 0);
  assert.equal(regen.db_writes, 0);
  assert.equal(regen.trade_date, '2026-11-20');
  assert.ok(regen.elapsed_ms > 0 && regen.elapsed_ms < 60000);
  const backup = JSON.parse(read('audit-evidence/v6_recovery_17nov/unified_final_20261122_v1/fix4_5/local_snapshot_metadata.json'));
  assert.equal(backup.source_sha256, 'c2128eb862200c795d7e17f1aa882c738d7e94ca29edc3b8ee17e726b78ce07c');
  assert.match(backup.backup_sha256, /^[0-9a-f]{64}$/);
  const source = read('lib/canonical-screener-source.js');
  assert.doesNotMatch(source, /writeFileSync|fetch\(|\.exec\(/);
});

test('the 9-tab research audit records source, freshness and stale/failed states honestly', () => {
  const report = read('audit-evidence/v6_recovery_17nov/unified_final_20261122_v1/fix4_5/RESEARCH_TAB_AUDIT.json');
  const audit = JSON.parse(report);
  const expected = ['Dashboard', 'Screener', 'Catatan Admin', 'Bandarmologi', 'Sinyal Intelijen',
    'Broker Hunter', 'Ranking', 'Financial', 'Struktur Pasar'];
  assert.deepEqual(audit.tabs.map((t) => t.tab), expected);
  for (const tab of audit.tabs) {
    assert.ok(tab.source && tab.source.length > 0, `${tab.tab} source`);
    assert.ok(tab.freshness && tab.freshness.length > 0, `${tab.tab} freshness`);
    assert.ok(typeof tab.stale_or_failed === 'string', `${tab.tab} stale_or_failed`);
  }
  const screenerTab = audit.tabs.find((t) => t.tab === 'Screener');
  assert.equal(screenerTab.freshness, '2026-11-20');
  assert.match(screenerTab.stale_or_failed, /^NONE:/);
});
