'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const extension = require('../public/pattern-screener-extension');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('official Screener labels are extracted without inventing patterns from status or prose', () => {
  const setups = extension.extractScreenerSetups([
    {
      name: 'Swing Konglo',
      payload: { results: [
        { ticker:'BBCA', smart_setup_labels:['VCP', 'Smart Money'], primary_smart_setup:'VCP', status:'READY_BREAKOUT', pattern:'Head and Shoulders' },
        { ticker:'TLKM', raw_payload:{ smart_setup_labels:['Uptrend Pullback'], primary_smart_setup:'Trend Template / Stage 2' } }
      ] }
    },
    {
      name: 'Day Trade',
      payload: { rows: [
        { ticker:'BBCA.JK', smart_setup_labels:['Bullish Harami+'] },
        { ticker:'ASII', status:'BULLISH_FLAG', notes:'Cup and Handle' }
      ] }
    }
  ]);

  assert.deepEqual(setups, [
    { ticker:'BBCA', labels:['VCP', 'Smart Money', 'Bullish Harami+'], sources:['Swing Konglo', 'Day Trade'] },
    { ticker:'TLKM', labels:['Uptrend Pullback', 'Trend Template / Stage 2'], sources:['Swing Konglo'] }
  ]);
  assert.equal(setups.some(row => row.ticker === 'ASII'), false);
  assert.doesNotMatch(JSON.stringify(setups), /Head and Shoulders|Cup and Handle|READY_BREAKOUT|BULLISH_FLAG/);
});

test('Screener-only cards are clearly contextual and never fabricate a Pattern Map button', () => {
  const html = extension.setupOnlyCardHtml({ ticker:'BBRI', labels:['VCP', 'Smart Money'], sources:['Swing Konglo'] });
  assert.match(html, /Setup resmi dari Screener terbaru/);
  assert.match(html, /Label setup bukan sinyal BUY/);
  assert.match(html, /data-setup-chart="BBRI"/);
  assert.doesNotMatch(html, /data-ps-map|Lihat Peta/);
});

test('artifact and redundant Chart control guards are narrow', () => {
  assert.equal(extension.isStandaloneArtifact(';'), true);
  assert.equal(extension.isStandaloneArtifact(' ; \n'), true);
  assert.equal(extension.isStandaloneArtifact('Risiko; keputusan manual.'), false);
  assert.equal(extension.isRedundantChartControl('Technical Chart', '', ''), true);
  assert.equal(extension.isRedundantChartControl('Lihat Chart', '', ''), false);
  assert.equal(extension.isRedundantChartControl('Technical Chart', 'technicalChartTab', ''), false);
  assert.equal(extension.isRedundantChartControl('Technical Chart', '', 'chart'), false);
});

test('runtime loads after stable Pattern and preserves protected systems', () => {
  const loader = read('public/assets/fca-stocks.js');
  const source = read('public/pattern-screener-extension.js');
  new vm.Script(source, { filename:'pattern-screener-extension.js' });
  assert.ok(loader.indexOf('/pattern-stable-runtime.js') < loader.indexOf('/pattern-screener-extension.js'));
  assert.match(source, /smart_setup_labels/);
  assert.match(source, /primary_smart_setup/);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /recoverReentry/);
  assert.match(source, /isRedundantChartControl/);
  assert.match(source, /isStandaloneArtifact/);
  assert.doesNotMatch(source, /sendTelegram|telegramNotifier|supabase\.from|createOrder|DAYTRADE_INTRADAY_SCORE_ENABLED|smart_setup_score_bonus\s*=/i);
});

test('ABCD detector remains explicitly bullish and bearish only', () => {
  const detector = read('lib/pattern-abcd.js');
  assert.match(detector, /'Bullish ABCD'/);
  assert.match(detector, /'Bearish ABCD'/);
  assert.doesNotMatch(detector, /Head and Shoulder|Double Top|Double Bottom|Triangle|Pennant|Cup and Handle/);
});
