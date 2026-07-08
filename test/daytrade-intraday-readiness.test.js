'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-readiness');

function intraday(overrides) {
  return Object.assign({
    date: '2026-07-08',
    summary: {
      candidates: 20,
      data_quality: { OK: 20 },
      intraday_priority_label: { INTRADAY_STRONG: 10, INTRADAY_OK: 10 },
      intraday_confirmation_label: { INTRADAY_CONFIRM: 12, INTRADAY_NEUTRAL: 8 }
    },
    rows: Array.from({ length: 20 }, (_, i) => ({ ticker: 'T' + i, data_quality: 'OK' }))
  }, overrides || {});
}

function compare(overrides) {
  return Object.assign({
    date: '2026-07-08',
    comparison: {
      metrics: {
        provider_matched_count: 20,
        provider_missing_count: 0,
        avg_score_delta: 1,
        max_score_delta: 5,
        priority_label_counts: { INTRADAY_STRONG: 10, INTRADAY_OK: 10 },
        confirmation_label_counts: { INTRADAY_CONFIRM: 12, INTRADAY_NEUTRAL: 8 },
        cautions: []
      }
    }
  }, overrides || {});
}

function report(input) { return lib.buildIntradayReadinessReport(Object.assign({ intraday: intraday(), compare: compare() }, input || {})); }

test('PASS case has no block or warn reasons', () => {
  const out = report();
  assert.equal(out.readiness_status, 'PASS');
  assert.deepEqual(out.block_reasons, []);
  assert.deepEqual(out.warn_reasons, []);
});

test('BLOCK for missing provider matches', () => {
  const out = report({ compare: compare({ comparison: { metrics: { provider_matched_count: 9, provider_missing_count: 1, cautions: [] } } }) });
  assert.equal(out.readiness_status, 'BLOCK');
  assert.match(out.block_reasons.join('\n'), /provider_matched_count/);
  assert.match(out.block_reasons.join('\n'), /provider_missing_count/);
});

test('BLOCK for NO_INTRADAY_DATA and INTRADAY_UNKNOWN', () => {
  const out = report({
    intraday: intraday({ summary: { candidates: 20, data_quality: { OK: 18, NO_INTRADAY_DATA: 2 }, intraday_priority_label: { INTRADAY_UNKNOWN: 1 }, intraday_confirmation_label: { INTRADAY_UNKNOWN: 1 } } }),
    compare: compare({ comparison: { metrics: { provider_matched_count: 20, provider_missing_count: 0, avg_score_delta: 0, max_score_delta: 0, priority_label_counts: { INTRADAY_UNKNOWN: 1 }, confirmation_label_counts: { INTRADAY_UNKNOWN: 1 }, cautions: [] } } })
  });
  assert.equal(out.readiness_status, 'BLOCK');
  assert.match(out.block_reasons.join('\n'), /NO_INTRADAY_DATA/);
  assert.match(out.block_reasons.join('\n'), /INTRADAY_UNKNOWN/);
});

test('BLOCK for stale/incomplete caution', () => {
  const out = report({ compare: compare({ comparison: { metrics: { provider_matched_count: 20, provider_missing_count: 0, cautions: ['STALE_OR_INCOMPLETE_INTRADAY_DATA'] } } }) });
  assert.equal(out.readiness_status, 'BLOCK');
  assert.match(out.block_reasons.join('\n'), /STALE_OR_INCOMPLETE_INTRADAY_DATA/);
});

test('WARN for high INTRADAY_AVOID ratio', () => {
  const out = report({ compare: compare({ comparison: { metrics: { provider_matched_count: 20, provider_missing_count: 0, avg_score_delta: 0, max_score_delta: 0, priority_label_counts: { INTRADAY_AVOID: 6, INTRADAY_OK: 14 }, confirmation_label_counts: { INTRADAY_CONFIRM: 20 }, cautions: [] } } }) });
  assert.equal(out.readiness_status, 'WARN');
  assert.match(out.warn_reasons.join('\n'), /INTRADAY_AVOID/);
});

test('WARN for high avg score delta', () => {
  const out = report({ compare: compare({ comparison: { metrics: { provider_matched_count: 20, provider_missing_count: 0, avg_score_delta: -5.1, max_score_delta: 8, cautions: [] } } }) });
  assert.equal(out.readiness_status, 'WARN');
  assert.match(out.warn_reasons.join('\n'), /avg_score_delta/);
});


test('BLOCK when blocking cautions are stored at comparison.cautions', () => {
  const out = report({
    compare: compare({
      comparison: {
        metrics: {
          provider_matched_count: 20,
          provider_missing_count: 0,
          avg_score_delta: 0,
          max_score_delta: 0,
          priority_label_counts: {},
          confirmation_label_counts: {}
        },
        cautions: ['STALE_OR_INCOMPLETE_INTRADAY_DATA', 'MANY_BELOW_VWAP_RISK']
      }
    })
  });
  assert.equal(out.readiness_status, 'BLOCK');
  assert.match(out.block_reasons.join('\n'), /STALE_OR_INCOMPLETE_INTRADAY_DATA/);
  assert.match(out.block_reasons.join('\n'), /MANY_BELOW_VWAP_RISK/);
});

test('WARN when MANY_CHASE_RISK is stored at comparison.cautions without block reasons', () => {
  const out = report({
    compare: compare({
      comparison: {
        metrics: {
          provider_matched_count: 20,
          provider_missing_count: 0,
          avg_score_delta: 0,
          max_score_delta: 0,
          priority_label_counts: {},
          confirmation_label_counts: {}
        },
        cautions: ['MANY_CHASE_RISK']
      }
    })
  });
  assert.equal(out.readiness_status, 'WARN');
  assert.match(out.warn_reasons.join('\n'), /MANY_CHASE_RISK/);
});

test('latest file discovery picks newest report by date', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readiness-latest-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-observe-2026-07-07.json'), JSON.stringify(intraday({ date: '2026-07-07' })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-observe-2026-07-08.json'), JSON.stringify(intraday({ date: '2026-07-08' })));
  await fs.writeFile(path.join(dir, 'daytrade-adjusted-vs-normal-2026-07-08.json'), JSON.stringify(compare({ date: '2026-07-08' })));
  const inputs = await lib.loadInputs({ latest: true, reportsDir: dir });
  assert.equal(inputs.intraday.date, '2026-07-08');
  assert.match(inputs.sources.intraday, /2026-07-08/);
});

test('missing report graceful error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readiness-missing-'));
  await assert.rejects(() => lib.loadInputs({ latest: true, reportsDir: dir }), /No latest daytrade-intraday-observe-/);
  await assert.rejects(() => lib.loadInputs({ intradayFile: path.join(dir, 'missing.json'), compareFile: path.join(dir, 'missing2.json') }), /Input file not found/);
});

test('generated markdown contains recommendation', () => {
  const md = lib.markdownReport(report({ compare: compare({ comparison: { metrics: { provider_matched_count: 9, provider_missing_count: 0, cautions: [] } } }) }));
  assert.match(md, /recommendation: BLOCK: do not enable production flag/);
});

test('no production write behavior', async () => {
  const libSource = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-intraday-readiness.js'), 'utf8');
  const toolSource = await fs.readFile(path.join(process.cwd(), 'tools', 'report-daytrade-intraday-readiness.js'), 'utf8');
  const source = libSource + '\n' + toolSource;
  assert.equal(/\.insert\s*\(/.test(source), false);
  assert.equal(/\.upsert\s*\(/.test(source), false);
  assert.equal(/\.delete\s*\(/.test(source), false);
  assert.equal(/fetch\s*\(/.test(source), false);
  assert.equal(/sendTelegram|telegram-notifier/i.test(source), false);
  assert.equal(/DAYTRADE_INTRADAY_SCORE_ENABLED\s*=/.test(source), false);
});
