'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const aggregate = require('./daytrade-intraday-validation-aggregate');

const DEFAULT_REPORTS_DIR = aggregate.DEFAULT_REPORTS_DIR;
const QUALITY_PREFIX = 'daytrade-intraday-provider-cache-quality-';

function asArray(v) { return Array.isArray(v) ? v : []; }
function numberOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function inc(map, key) { if (!key) return; map[key] = (map[key] || 0) + 1; }
function sortedCounts(map) { return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ticker, count]) => ({ ticker, count })); }
function repeated(map, threshold) { return sortedCounts(map).filter((r) => r.count >= (threshold || 2)); }
function tickerSet(rows) { return new Set(asArray(rows).map((r) => String(r && (r.ticker || r)).trim().toUpperCase()).filter(Boolean)); }
function normalizeTicker(t) { return String(t || '').trim().toUpperCase(); }
function fmtList(v) { return asArray(v).length ? asArray(v).join(', ') : 'none'; }
function fmtCounts(v) { return asArray(v).length ? asArray(v).map((r) => `${r.ticker} (${r.count})`).join(', ') : 'none'; }
function fmtObj(v) { return '`' + JSON.stringify(v || {}) + '`'; }
function todayIso(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 10); }

function rowDiagnostics(row) {
  const d = row && row.intraday_data_diagnostics || {};
  return {
    source: d.source || (row && row.cache && row.cache.source) || null,
    interval: d.interval || (row && row.cache && row.cache.interval) || null,
    session_date: d.session_date || null,
    updated_at: d.updated_at || null,
    candle_count: numberOrZero(d.candle_count),
    valid_ohlc_candles: numberOrZero(d.valid_ohlc_candles),
    zero_ohlc_candles: numberOrZero(d.zero_ohlc_candles),
    positive_volume_candles: numberOrZero(d.positive_volume_candles),
    total_volume: numberOrZero(d.total_volume)
  };
}

function remediationHints(row, sample) {
  const hints = [];
  const quality = row && row.data_quality;
  const fallback = row && row.intraday_fallback_action;
  const d = rowDiagnostics(row);
  const cache = row && row.cache || {};
  if (quality === 'NO_INTRADAY_DATA' || (sample && numberOrZero(sample.provider_missing_count) > 0 && quality !== 'OK')) hints.push('provider missing');
  if (cache.stale || quality === 'STALE_CACHE') hints.push('stale cache');
  if (d.candle_count > 0 && d.candle_count < 2) hints.push('sparse candles');
  if (d.zero_ohlc_candles > 0 || (d.candle_count > 0 && d.valid_ohlc_candles < d.candle_count)) hints.push('zero OHLC');
  if (d.candle_count > 0 && (d.positive_volume_candles === 0 || d.total_volume <= 0)) hints.push('zero volume');
  if (quality === 'INCOMPLETE_INTRADAY' || fallback === 'DAILY_SCORE_ONLY') hints.push('incomplete intraday cache');
  return Array.from(new Set(hints));
}

function buildProviderCacheQualityReport(samples, opts) {
  samples = asArray(samples).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.generated_at || '').localeCompare(String(b.generated_at || '')));
  const providerMissingCounts = [], incompleteCounts = [], unknownCounts = [];
  const dailyScoreOnly = new Set();
  const blockerCounts = {};
  const tickerRecords = [];
  const sampleSummaries = [];

  for (const s of samples) {
    const rows = asArray(s.rows);
    const dq = s.data_quality_counts || {};
    const providerMissing = numberOrZero(s.provider_missing_count);
    const incomplete = numberOrZero(dq.INCOMPLETE_INTRADAY);
    const unknown = numberOrZero(s.priority_label_counts && s.priority_label_counts.INTRADAY_UNKNOWN) + numberOrZero(s.confirmation_label_counts && s.confirmation_label_counts.INTRADAY_UNKNOWN) || asArray(s.intraday_unknown_tickers).length;
    providerMissingCounts.push(providerMissing);
    incompleteCounts.push(incomplete);
    unknownCounts.push(unknown);
    sampleSummaries.push({ sample_id: s._sample_id || s.session_id || s.generated_at || s.date, source_type: s._source_type || 'daily', date: s.date, generated_at: s.generated_at, provider_missing_count: providerMissing, incomplete_intraday_count: incomplete, intraday_unknown_count: unknown });
    for (const row of rows) {
      if (!row || !row.ticker) continue;
      const hints = remediationHints(row, s);
      const isDaily = row.intraday_fallback_action === 'DAILY_SCORE_ONLY';
      const isUnknown = row.intraday_priority_label === 'INTRADAY_UNKNOWN' || row.intraday_confirmation_label === 'INTRADAY_UNKNOWN';
      if (isDaily) dailyScoreOnly.add(row.ticker);
      if (row.data_quality === 'NO_INTRADAY_DATA' || row.data_quality === 'INCOMPLETE_INTRADAY' || isUnknown || isDaily || hints.length) inc(blockerCounts, normalizeTicker(row.ticker));
      if (row.data_quality !== 'OK' || isUnknown || isDaily || hints.length) tickerRecords.push(Object.assign({ ticker: row.ticker, data_quality: row.data_quality || null, intraday_fallback_action: row.intraday_fallback_action || null, intraday_priority_label: row.intraday_priority_label || null, intraday_confirmation_label: row.intraday_confirmation_label || null, remediation_hints: hints, sample_id: s._sample_id || s.session_id || null, sample_source_type: s._source_type || 'daily', sample_generated_at: s.generated_at || null }, rowDiagnostics(row)));
    }
  }

  const totalProviderMissing = providerMissingCounts.reduce((a, b) => a + b, 0);
  const totalIncomplete = incompleteCounts.reduce((a, b) => a + b, 0);
  const totalUnknown = unknownCounts.reduce((a, b) => a + b, 0);
  const quarantineThreshold = Number((opts && opts.repeatedBlockerThreshold) || 2);
  const repeatedBlockers = repeated(blockerCounts, quarantineThreshold);
  const quarantineTickers = tickerSet(repeatedBlockers);
  let quarantinedProviderMissing = 0, quarantinedIncomplete = 0, quarantinedUnknown = 0;
  for (const rec of tickerRecords) {
    const ticker = normalizeTicker(rec.ticker);
    if (!quarantineTickers.has(ticker)) continue;
    rec.intraday_quarantine = true;
    rec.quarantine_reason = `REPEATED_INTRADAY_BLOCKER count=${blockerCounts[ticker] || 0} threshold=${quarantineThreshold}`;
    rec.quarantine_action = 'DAILY_SCORE_ONLY';
    rec.intraday_score_adjustment = 0;
    rec.intraday_score_adjustment_preview = 0;
    rec.intraday_priority_label = rec.intraday_priority_label === 'INTRADAY_UNKNOWN' ? 'INTRADAY_UNKNOWN' : (rec.intraday_priority_label || 'INTRADAY_QUARANTINED');
    rec.intraday_score_adjustment_reasons = Array.from(new Set(asArray(rec.intraday_score_adjustment_reasons).concat(['REPEATED_INTRADAY_BLOCKER DAILY_SCORE_ONLY 0'])));
    if (rec.data_quality === 'NO_INTRADAY_DATA') quarantinedProviderMissing++;
    if (rec.data_quality === 'INCOMPLETE_INTRADAY') quarantinedIncomplete++;
    if (rec.intraday_priority_label === 'INTRADAY_UNKNOWN' || rec.intraday_confirmation_label === 'INTRADAY_UNKNOWN') quarantinedUnknown++;
  }
  const nonQProviderMissing = Math.max(0, totalProviderMissing - quarantinedProviderMissing);
  const nonQIncomplete = Math.max(0, totalIncomplete - quarantinedIncomplete);
  const nonQUnknown = Math.max(0, totalUnknown - quarantinedUnknown);
  const quarantineRows = Array.from(quarantineTickers).sort().map((ticker) => ({ ticker, count: blockerCounts[ticker] || 0, quarantine_reason: `REPEATED_INTRADAY_BLOCKER count=${blockerCounts[ticker] || 0} threshold=${quarantineThreshold}`, quarantine_action: 'DAILY_SCORE_ONLY' }));
  const blockReasons = [];
  if (nonQProviderMissing > 0) { blockReasons.push('non_quarantined_provider_missing_count > 0'); blockReasons.push('provider_missing_count > 0'); }
  if (nonQIncomplete > 0) { blockReasons.push('non_quarantined_INCOMPLETE_INTRADAY > 0'); blockReasons.push('INCOMPLETE_INTRADAY > 0'); }
  if (nonQUnknown > 0) { blockReasons.push('non_quarantined_INTRADAY_UNKNOWN > 0'); blockReasons.push('INTRADAY_UNKNOWN > 0'); }
  if (dailyScoreOnly.size > quarantineTickers.size) { blockReasons.push('non_quarantined DAILY_SCORE_ONLY fallback exists'); blockReasons.push('DAILY_SCORE_ONLY fallback exists'); }
  if (quarantineRows.length) blockReasons.push('PASS_WITH_QUARANTINE for dry-run/reporting only; keep production intraday scoring disabled');
  const status = blockReasons.length ? 'BLOCK' : 'PASS';
  return { date: todayIso(opts && opts.nowMs), generated_at: new Date(opts && opts.nowMs || Date.now()).toISOString(), quality_status: status, recommendation: status === 'PASS' ? 'Provider/cache quality diagnostics are clean; keep production intraday scoring disabled until separately approved.' : 'Do not enable production intraday scoring; quarantined tickers are daily-only and any non-quarantined provider/cache blockers must be remediated.', sample_count: samples.length, provider_missing_count: totalProviderMissing, incomplete_intraday_count: totalIncomplete, intraday_unknown_count: totalUnknown, non_quarantined_provider_missing_count: nonQProviderMissing, non_quarantined_incomplete_intraday_count: nonQIncomplete, non_quarantined_intraday_unknown_count: nonQUnknown, intraday_quarantine_count: quarantineRows.length, intraday_quarantine_tickers: quarantineRows, daily_score_only_tickers: Array.from(dailyScoreOnly).sort(), repeated_blocker_tickers: repeatedBlockers, top_blocker_tickers: sortedCounts(blockerCounts).slice(0, 20), sample_summaries: sampleSummaries, ticker_records: tickerRecords, block_reasons: blockReasons, read_only_confirmation: 'This provider/cache quality report only reads local validation bundle/session archive JSON and writes local report artifacts. It does not enable DAYTRADE_INTRADAY_SCORE_ENABLED, add API endpoints, add SQL or migrations, change cron, send Telegram, change PDF/share-link, add orderbook/broksum, use paid services, or use AI.' };
}

async function loadSamples(opts) { return aggregate.loadBundles(Object.assign({ includeSessionArchives: true }, opts || {})); }

function markdownReport(r) {
  const rows = r.ticker_records.slice(0, 50).map((x) => `| ${x.ticker} | ${x.data_quality || '-'} | ${x.intraday_fallback_action || '-'} | ${x.sample_source_type} | ${x.source || '-'} | ${x.interval || '-'} | ${x.session_date || '-'} | ${x.updated_at || '-'} | ${x.candle_count} | ${x.valid_ohlc_candles} | ${x.zero_ohlc_candles} | ${x.positive_volume_candles} | ${x.total_volume} | ${fmtList(x.remediation_hints)} |`).join('\n');
  return `# Day Trade Intraday Provider/Cache Quality — ${r.date}\n\nGenerated at: ${r.generated_at}\n\n## Status\n\n- quality_status: ${r.quality_status}\n- recommendation: ${r.recommendation}\n- sample_count: ${r.sample_count}\n- provider_missing_count: ${r.provider_missing_count}\n- incomplete_intraday_count: ${r.incomplete_intraday_count}\n- intraday_unknown_count: ${r.intraday_unknown_count}\n- non_quarantined_provider_missing_count: ${r.non_quarantined_provider_missing_count ?? r.provider_missing_count}\n- non_quarantined_incomplete_intraday_count: ${r.non_quarantined_incomplete_intraday_count ?? r.incomplete_intraday_count}\n- non_quarantined_intraday_unknown_count: ${r.non_quarantined_intraday_unknown_count ?? r.intraday_unknown_count}\n- intraday_quarantine_count: ${r.intraday_quarantine_count || 0}\n- quarantined tickers: ${fmtCounts(r.intraday_quarantine_tickers)}\n- DAILY_SCORE_ONLY tickers: ${fmtList(r.daily_score_only_tickers)}\n- repeated blocker tickers: ${fmtCounts(r.repeated_blocker_tickers)}\n- block reasons: ${r.block_reasons.length ? r.block_reasons.join('; ') : 'none'}\n\n## Sample Summaries\n\n${r.sample_summaries.map((s) => `- ${s.date} [${s.source_type}] ${s.sample_id || ''}: provider_missing_count=${s.provider_missing_count}, incomplete_intraday_count=${s.incomplete_intraday_count}, intraday_unknown_count=${s.intraday_unknown_count}`).join('\n') || '- none'}\n\n## Ticker Diagnostics\n\n| Ticker | Quality | Fallback | Sample Source | Source | Interval | Session Date | Updated At | Candles | Valid OHLC | Zero OHLC | Positive Volume | Total Volume | Remediation Hints |\n| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows || '| - | - | - | - | - | - | - | - | 0 | 0 | 0 | 0 | 0 | - |'}\n\n## Read-only Confirmation\n\n${r.read_only_confirmation}\n`;
}

async function writeReports(report, opts) {
  const dir = opts && opts.reportsDir || DEFAULT_REPORTS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, QUALITY_PREFIX + report.date);
  const paths = { markdown: base + '.md' };
  await fs.writeFile(paths.markdown, markdownReport(report));
  if (opts && opts.writeJson) { paths.json = base + '.json'; await fs.writeFile(paths.json, JSON.stringify(report, null, 2) + '\n'); }
  return paths;
}

module.exports = { DEFAULT_REPORTS_DIR, QUALITY_PREFIX, loadSamples, buildProviderCacheQualityReport, rowDiagnostics, remediationHints, markdownReport, writeReports };
