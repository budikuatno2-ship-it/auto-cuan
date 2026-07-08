'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bundle = require('../tools/run-daytrade-intraday-validation-bundle');

function intraday(date, rows) {
  return { date, summary: { candidates: rows.length, data_quality: { OK: rows.length }, intraday_priority_label: {}, intraday_confirmation_label: {} }, rows };
}
function compare(date) {
  return { date, comparison: { metrics: { provider_matched_count: 1, provider_missing_count: 0, top5_entering: ['BBB'], top5_leaving: ['AAA'], priority_label_counts: { INTRADAY_OK: 1 }, confirmation_label_counts: { INTRADAY_CONFIRM: 1 }, cautions: [] }, rows: [{ ticker: 'BBB', score_delta: 5 }, { ticker: 'AAA', score_delta: -3 }] } };
}
function readiness(date, status) {
  return { date, readiness_status: status, recommendation: status + ' recommendation', metrics: { candidates: 1, provider_matched_count: 1, provider_missing_count: 0, data_quality: { OK: 1 }, priority_label_counts: { INTRADAY_OK: 1 }, confirmation_label_counts: { INTRADAY_CONFIRM: 1 }, cautions: [] } };
}

test('command construction does not include send_radar', () => {
  const plan = bundle.commandPlan({ limit: 5, reportsDir: 'data/reports', logsFile: 'logs/daytrade-vps-worker/runs.jsonl', tickers: 'AAA,BBB' });
  assert.doesNotMatch(JSON.stringify(plan), /send_radar/);
  assert.deepEqual(plan.find((s) => s.name === 'normal observe').args.slice(0, 4), ['tools/daytrade-vps-worker-observe.js', '--mode', 'observe', '--tickers']);
});

test('TELEGRAM_ENABLED defaults to 0 for child env but explicit override is preserved', () => {
  assert.equal(bundle.childEnv({}).TELEGRAM_ENABLED, '0');
  assert.equal(bundle.childEnv({ TELEGRAM_ENABLED: '1' }).TELEGRAM_ENABLED, '1');
});

test('normal run unsets DAYTRADE_INTRADAY_SCORE_ENABLED', () => {
  const env = bundle.normalObserveEnv({ DAYTRADE_INTRADAY_SCORE_ENABLED: '1' });
  assert.equal(env.DAYTRADE_INTRADAY_SCORE_ENABLED, undefined);
  assert.equal(env.TELEGRAM_ENABLED, '0');
});

test('adjusted run sets DAYTRADE_INTRADAY_SCORE_ENABLED=1 only for child process', () => {
  delete process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  const env = bundle.adjustedObserveEnv({});
  assert.equal(env.DAYTRADE_INTRADAY_SCORE_ENABLED, '1');
  assert.equal(process.env.DAYTRADE_INTRADAY_SCORE_ENABLED, undefined);
});

test('no Supabase writes/API/SQL/UI/cron changes are introduced by the bundle tool', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'tools', 'run-daytrade-intraday-validation-bundle.js'), 'utf8');
  assert.doesNotMatch(source, /send_radar|telegram\.send|supabase\.from\([^)]*\)\.insert|\.upsert\(|\.update\(/i);
  const executableSource = source.replace(/read_only_confirmation: '[^']*'/g, 'read_only_confirmation');
  assert.doesNotMatch(executableSource, /api\/|migrations|CREATE\s+TABLE|ALTER\s+TABLE|dashboard|cron/i);
});


test('bundle score delta summary uses all comparison rows, not truncated top movers', () => {
  const compareReport = compare('2026-07-08');
  compareReport.comparison.rows = Array.from({ length: 12 }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    score_delta: i < 10 ? 10 : 0
  }));
  const report = bundle.buildBundleReport({
    intraday: intraday('2026-07-08', [{ ticker: 'AAA', data_quality: 'OK' }]),
    compare: compareReport,
    readiness: readiness('2026-07-08', 'PASS'),
    paths: {}
  });
  assert.equal(report.top_score_movers.length, 10);
  assert.equal(report.score_delta_count, 12);
  assert.equal(report.avg_absolute_score_delta, 8.33);
  assert.equal(report.max_absolute_score_delta, 10);
});

test('bundle report includes readiness BLOCK/PASS status', () => {
  for (const status of ['BLOCK', 'PASS']) {
    const report = bundle.buildBundleReport({ intraday: intraday('2026-07-08', [{ ticker: 'AAA', data_quality: 'OK' }]), compare: compare('2026-07-08'), readiness: readiness('2026-07-08', status), paths: {} });
    assert.equal(report.validation_status, status);
    assert.match(bundle.markdownReport(Object.assign(report, { paths: { intraday: 'i', compare: 'c', readiness: 'r', markdown: 'm' } })), new RegExp(`validation_status: ${status}`));
  }
});

test('data quality tickers extracted from intraday rows', () => {
  const report = bundle.buildBundleReport({ intraday: intraday('2026-07-08', [{ ticker: 'AAA', data_quality: 'NO_INTRADAY_DATA' }, { ticker: 'BBB', intraday_priority_label: 'INTRADAY_UNKNOWN' }, { ticker: 'CCC', data_quality: 'INCOMPLETE_INTRADAY' }]), compare: compare('2026-07-08'), readiness: readiness('2026-07-08', 'BLOCK'), paths: {} });
  assert.deepEqual(report.no_intraday_data_tickers, ['AAA']);
  assert.deepEqual(report.incomplete_intraday_tickers, ['CCC']);
  assert.deepEqual(report.intraday_unknown_tickers, ['BBB']);
  const md = bundle.markdownReport(Object.assign(report, { paths: { intraday: 'i', compare: 'c', readiness: 'r', markdown: 'm' } }));
  assert.match(md, /incomplete_intraday tickers: CCC/);
});

test('graceful error when latest intraday report has zero candidates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-zero-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-observe-2026-07-08.json'), JSON.stringify(intraday('2026-07-08', [])));
  await assert.rejects(() => bundle.prepare({ reportsDir: dir, logsFile: 'x', skipIntradayObserve: true, tickers: '' }, () => {}), /zero candidates/);
});

test('graceful error when generated report dates mismatch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-mismatch-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-observe-2026-07-08.json'), JSON.stringify(intraday('2026-07-08', [{ ticker: 'AAA' }])));
  await fs.writeFile(path.join(dir, 'daytrade-adjusted-vs-normal-2026-07-09.json'), JSON.stringify(compare('2026-07-09')));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-readiness-2026-07-08.json'), JSON.stringify(readiness('2026-07-08', 'BLOCK')));
  await assert.rejects(() => bundle.prepare({ reportsDir: dir, logsFile: 'x', skipIntradayObserve: true, tickers: '' }, () => {}), /dates mismatch/);
});

test('bundle JSON rows include full candidate coverage including OK and blockers without truncation', () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    data_quality: i < 12 ? 'OK' : i < 14 ? 'INCOMPLETE_INTRADAY' : 'NO_INTRADAY_DATA',
    intraday_priority_label: i >= 14 ? 'INTRADAY_UNKNOWN' : 'INTRADAY_OK',
    intraday_confirmation_label: i >= 14 ? 'INTRADAY_UNKNOWN' : 'INTRADAY_CONFIRM',
    intraday_score_adjustment_preview: 0,
    intraday_labels: ['x']
  }));
  const r = readiness('2026-07-08', 'BLOCK');
  r.metrics.candidates = 16;
  const report = bundle.buildBundleReport({ intraday: intraday('2026-07-08', rows), compare: compare('2026-07-08'), readiness: r, paths: {} });
  assert.equal(report.rows.length, 16);
  assert.equal(report.rows.filter((row) => row.data_quality === 'OK').length, 12);
  assert.ok(report.rows.some((row) => row.data_quality === 'NO_INTRADAY_DATA'));
  assert.ok(report.rows.some((row) => row.data_quality === 'INCOMPLETE_INTRADAY'));
});

test('writeBundle --archive-session writes timestamped archive JSON and markdown with full rows and session_id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-archive-'));
  const rows = [{ ticker: 'AAA', data_quality: 'OK' }, { ticker: 'BBB', data_quality: 'INCOMPLETE_INTRADAY' }];
  const report = bundle.buildBundleReport({
    intraday: intraday('2026-07-08', rows),
    compare: compare('2026-07-08'),
    readiness: readiness('2026-07-08', 'BLOCK'),
    paths: { intraday: 'i', compare: 'c', readiness: 'r' }
  });
  report.generated_at = '2026-07-08T10:11:12.000Z';
  const paths = await bundle.writeBundle(report, { reportsDir: dir, writeJson: true, archiveSession: true });
  assert.equal(path.basename(paths.session_archive_json), 'daytrade-intraday-validation-bundle-session-2026-07-08T10-11-12Z.json');
  assert.equal(path.basename(paths.session_archive_markdown), 'daytrade-intraday-validation-bundle-session-2026-07-08T10-11-12Z.md');
  const archive = JSON.parse(await fs.readFile(paths.session_archive_json, 'utf8'));
  assert.equal(archive.session_id, 'daytrade-intraday-validation-bundle-session-2026-07-08T10-11-12Z');
  assert.equal(archive.session_started_at, '2026-07-08T10:11:12.000Z');
  assert.equal(archive.report_date, '2026-07-08');
  assert.equal(archive.source_daily_bundle_path, paths.json);
  assert.equal(archive.rows.length, 2);
  assert.match(archive.read_only_confirmation, /observe-only/);
  const md = await fs.readFile(paths.session_archive_markdown, 'utf8');
  assert.match(md, /Session Archive/);
});
