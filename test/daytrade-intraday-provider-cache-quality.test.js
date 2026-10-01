'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-provider-cache-quality');
const cli = require('../tools/report-daytrade-intraday-provider-cache-quality');

function diag(overrides) {
  return Object.assign({ source: 'yahoo', interval: '15m', session_date: '2026-07-08', updated_at: '2026-07-08T08:00:00.000Z', candle_count: 2, valid_ohlc_candles: 2, zero_ohlc_candles: 0, positive_volume_candles: 2, total_volume: 1000 }, overrides || {});
}
function row(ticker, overrides) {
  return Object.assign({ ticker, data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM', intraday_fallback_action: null, intraday_data_diagnostics: diag(), cache: { hit: true, stale: false, source: 'yahoo', interval: '15m' } }, overrides || {});
}
function sample(id, rows, overrides) {
  return Object.assign({ date: '2026-07-08', generated_at: `2026-07-08T0${id}:00:00.000Z`, session_id: `s${id}`, _source_type: 'session_archive', validation_status: 'BLOCK', provider_missing_count: 0, data_quality_counts: { OK: rows.length }, priority_label_counts: {}, confirmation_label_counts: {}, rows }, overrides || {});
}

test('provider/cache quality report quarantines every provider-bad row and emits remediation hints', () => {
  const report = lib.buildProviderCacheQualityReport([
    sample(8, [
      row('TCID', { data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_data_diagnostics: diag({ candle_count: 0, valid_ohlc_candles: 0, positive_volume_candles: 0, total_volume: 0 }) }),
      row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY', cache: { hit: true, stale: true }, intraday_data_diagnostics: diag({ candle_count: 1, valid_ohlc_candles: 0, zero_ohlc_candles: 1, positive_volume_candles: 0, total_volume: 0 }) })
    ], { provider_missing_count: 1, data_quality_counts: { NO_INTRADAY_DATA: 1, INCOMPLETE_INTRADAY: 1 }, priority_label_counts: { INTRADAY_UNKNOWN: 1 } }),
    sample(9, [row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_data_diagnostics: diag({ candle_count: 1, positive_volume_candles: 0, total_volume: 0 }) })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } })
  ], { nowMs: Date.UTC(2026, 6, 9) });

  assert.equal(report.quality_status, 'PASS_WITH_QUARANTINE');
  assert.equal(report.provider_missing_count, 1);
  assert.equal(report.incomplete_intraday_count, 2);
  assert.equal(report.intraday_unknown_count, 1);
  assert.deepEqual(report.daily_score_only_tickers, ['BBSI', 'TCID']);
  assert.deepEqual(report.repeated_blocker_tickers, [{ ticker: 'BBSI', count: 2 }]);
  assert.equal(report.quarantined_provider_missing_count, 1);
  assert.equal(report.non_quarantined_provider_missing_count, 0);
  assert.equal(report.total_provider_missing_count, 1);
  assert.equal(report.visible_provider_missing_count, 1);
  assert.equal(report.non_quarantined_incomplete_intraday_count, 0);
  assert.equal(report.non_quarantined_intraday_unknown_count, 0);
  const bbsi = report.ticker_records.find((r) => r.ticker === 'BBSI');
  assert.ok(bbsi.remediation_hints.includes('stale cache'));
  assert.ok(bbsi.remediation_hints.includes('sparse candles'));
  assert.ok(bbsi.remediation_hints.includes('zero OHLC'));
  assert.ok(bbsi.remediation_hints.includes('zero volume'));
  assert.ok(bbsi.remediation_hints.includes('incomplete intraday cache'));
  for (const rec of report.ticker_records) {
    assert.equal(rec.quarantine_action, 'DAILY_SCORE_ONLY');
    assert.equal(rec.intraday_score_adjustment, 0);
    assert.equal(rec.intraday_score_adjustment_preview, 0);
    assert.equal(rec.intraday_priority_label, 'INTRADAY_UNKNOWN');
    assert.equal(rec.intraday_confirmation_label, 'INTRADAY_UNKNOWN');
  }
});


test('provider missing total risk stays visible but only visible non-quarantined rows block', () => {
  const report = lib.buildProviderCacheQualityReport([
    sample(7, [row('TCID', { data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_score_adjustment_preview: 4 })], { provider_missing_count: 2, data_quality_counts: { NO_INTRADAY_DATA: 1 }, priority_label_counts: { INTRADAY_UNKNOWN: 1 }, confirmation_label_counts: { INTRADAY_UNKNOWN: 1 } }),
    sample(8, [row('TCID', { data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_score_adjustment_preview: -3 })], { provider_missing_count: 1, data_quality_counts: { NO_INTRADAY_DATA: 1 }, priority_label_counts: { INTRADAY_UNKNOWN: 1 }, confirmation_label_counts: { INTRADAY_UNKNOWN: 1 } })
  ], { nowMs: Date.UTC(2026, 6, 9) });

  assert.equal(report.quality_status, 'PASS_WITH_QUARANTINE');
  assert.equal(report.provider_missing_count, 3);
  assert.equal(report.total_provider_missing_count, 3);
  assert.equal(report.visible_provider_missing_count, 2);
  assert.equal(report.quarantined_provider_missing_count, 2);
  assert.equal(report.non_quarantined_provider_missing_count, 0);
  assert.equal(report.non_quarantined_intraday_unknown_count, 0);
  assert.match(report.recommendation, /Do not enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
  assert.ok(report.block_reasons.includes('PASS_WITH_QUARANTINE for dry-run/reporting only; keep DAYTRADE_INTRADAY_SCORE_ENABLED off'));
  for (const rec of report.ticker_records) {
    assert.equal(rec.quarantine_action, 'DAILY_SCORE_ONLY');
    assert.equal(rec.intraday_score_adjustment, 0);
    assert.equal(rec.intraday_score_adjustment_preview, 0);
  }
  const md = lib.markdownReport(report);
  assert.match(md, /provider_missing_count: 3/);
  assert.match(md, /total_provider_missing_count: 3/);
  assert.match(md, /visible_provider_missing_count: 2/);
  assert.match(md, /quarantined_provider_missing_count: 2/);
  assert.match(md, /non_quarantined_provider_missing_count: 0/);
});


test('markdown includes requested diagnostics and read-only guardrails', () => {
  const report = lib.buildProviderCacheQualityReport([sample(8, [row('SDPC', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_data_diagnostics: diag({ source: 'local-cache', interval: '15m' }) })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } })], { nowMs: Date.UTC(2026, 6, 9) });
  const md = lib.markdownReport(report);
  assert.match(md, /provider_missing_count/);
  assert.match(md, /incomplete_intraday_count/);
  assert.match(md, /DAILY_SCORE_ONLY tickers/);
  assert.match(md, /Source \| Interval \| Session Date \| Updated At \| Candles/);
  assert.match(md, /local-cache/);
  assert.match(md, /does not enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
});

test('loadSamples includes session archives by default and CLI can disable them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-cache-quality-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(sample(8, [row('AAA')], { generated_at: '2026-07-08T08:00:00.000Z' })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-session-2026-07-08T09-00-00Z.json'), JSON.stringify(sample(9, [row('BBB')], { report_date: '2026-07-08' })));
  const samples = await lib.loadSamples({ reportsDir: dir, days: 5 });
  assert.equal(samples.length, 2);
  assert.equal(cli.parseArgs(['node', 'script', '--no-session-archives']).includeSessionArchives, false);
});

test('repeated intraday blockers are quarantined as daily-only with zero adjustment', () => {
  const report = lib.buildProviderCacheQualityReport([
    sample(8, [row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_score_adjustment_preview: 7 })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } }),
    sample(9, [row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY', intraday_score_adjustment_preview: -5 })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } })
  ], { nowMs: Date.UTC(2026, 6, 9) });

  assert.deepEqual(report.repeated_blocker_tickers, [{ ticker: 'BBSI', count: 2 }]);
  assert.equal(report.intraday_quarantine_count, 1);
  assert.deepEqual(report.intraday_quarantine_tickers, [{ ticker: 'BBSI', count: 2, quarantine_reason: 'PROVIDER_DATA_QUALITY_INCOMPLETE_INTRADAY DAILY_SCORE_ONLY', quarantine_action: 'DAILY_SCORE_ONLY' }]);
  assert.equal(report.non_quarantined_incomplete_intraday_count, 0);
  const quarantined = report.ticker_records.filter((r) => r.ticker === 'BBSI');
  assert.equal(quarantined.length, 2);
  for (const rec of quarantined) {
    assert.equal(rec.intraday_quarantine, true);
    assert.equal(rec.quarantine_action, 'DAILY_SCORE_ONLY');
    assert.equal(rec.intraday_score_adjustment_preview, 0);
    assert.equal(rec.intraday_score_adjustment, 0);
    assert.ok(rec.intraday_score_adjustment_reasons.includes('PROVIDER_DATA_QUALITY_INCOMPLETE_INTRADAY DAILY_SCORE_ONLY 0'));
  }
  assert.match(lib.markdownReport(report), /quarantined tickers: BBSI \(2\)/);
});

test('a provider-bad row is quarantined even when it appears only once', () => {
  const report = lib.buildProviderCacheQualityReport([
    sample(8, [row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY' }), row('TCID', { data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN', intraday_fallback_action: 'DAILY_SCORE_ONLY' })], { provider_missing_count: 1, data_quality_counts: { INCOMPLETE_INTRADAY: 1, NO_INTRADAY_DATA: 1 }, priority_label_counts: { INTRADAY_UNKNOWN: 1 } }),
    sample(9, [row('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', intraday_fallback_action: 'DAILY_SCORE_ONLY' })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } })
  ], { nowMs: Date.UTC(2026, 6, 9) });

  assert.equal(report.intraday_quarantine_count, 2);
  assert.equal(report.non_quarantined_provider_missing_count, 0);
  assert.equal(report.non_quarantined_intraday_unknown_count, 0);
  assert.equal(report.quality_status, 'PASS_WITH_QUARANTINE');
});

test('provider-bad INTRADAY_UNKNOWN cannot remain a public intraday confirmed pick', () => {
  const report = lib.buildProviderCacheQualityReport([
    sample(8, [row('BAD', { data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_STRONG', intraday_confirmation_label: 'INTRADAY_CONFIRM', intraday_score_adjustment_preview: 9 })], { data_quality_counts: { INCOMPLETE_INTRADAY: 1 } })
  ]);
  const bad = report.ticker_records[0];
  assert.equal(bad.quarantine_action, 'DAILY_SCORE_ONLY');
  assert.equal(bad.intraday_score_adjustment_preview, 0);
  assert.equal(bad.intraday_priority_label, 'INTRADAY_UNKNOWN');
  assert.equal(bad.intraday_confirmation_label, 'INTRADAY_UNKNOWN');
});
