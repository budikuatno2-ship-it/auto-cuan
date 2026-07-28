'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const extension = require('../public/pattern-screener-extension');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('official Screener labels include object setup labels and classic fields without reading prose', () => {
  const setups = extension.extractScreenerSetups([
    {
      name: 'Swing Konglo',
      payload: { results: [
        {
          ticker:'BBCA',
          smart_setup_labels:[
            { setup_label:'VCP Setup', setup_type:'VCP' },
            { setup_label:'Smart Money Before Rally', setup_type:'SMART_MONEY' }
          ],
          primary_smart_setup:{ setup_label:'VCP Setup' },
          classic_chart_patterns:[{ label:'Cup and Handle', type:'CUP_AND_HANDLE' }],
          status:'READY_BREAKOUT',
          notes:'Head and Shoulders only in free prose'
        },
        { ticker:'TLKM', raw_payload:{ smart_setup_labels:[{ setup_label:'Uptrend Pullback' }], primary_classic_pattern:{ label:'Ascending Triangle' } } }
      ] }
    },
    {
      name: 'Day Trade',
      payload: { rows: [
        { ticker:'BBCA.JK', smart_setup_labels:['Bullish Harami+'] },
        { ticker:'ASII', status:'BULLISH_FLAG', notes:'Double Bottom' }
      ] }
    }
  ]);

  assert.deepEqual(setups, [
    { ticker:'BBCA', labels:['VCP Setup', 'Smart Money Before Rally', 'Cup and Handle', 'Bullish Harami+'], sources:['Swing Konglo', 'Day Trade'] },
    { ticker:'TLKM', labels:['Uptrend Pullback', 'Ascending Triangle'], sources:['Swing Konglo'] }
  ]);
  assert.equal(setups.some(row => row.ticker === 'ASII'), false);
  assert.doesNotMatch(JSON.stringify(setups), /\[object Object\]|free prose|READY_BREAKOUT|BULLISH_FLAG/);
});

test('generic and malformed pattern labels are ignored', () => {
  assert.equal(extension.labelText({ setup_label:'VCP Setup' }), 'VCP Setup');
  assert.equal(extension.labelText({ label:'Double Bottom' }), 'Double Bottom');
  assert.equal(extension.labelText({}), null);
  assert.equal(extension.labelText('No Clear Pattern'), null);
  assert.equal(extension.labelText('[object Object]'), null);
});

test('Screener-only cards are clearly contextual and never fabricate a Pattern Map button', () => {
  const html = extension.setupOnlyCardHtml({ ticker:'BBRI', labels:['VCP Setup', 'Cup and Handle'], sources:['Swing Konglo'] });
  assert.match(html, /Pattern dan setup resmi dari Screener terbaru/);
  assert.match(html, /bukan sinyal BUY otomatis/);
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
  assert.match(loader, /pattern-screener-v3/);
  assert.match(source, /smart_setup_labels/);
  assert.match(source, /classic_chart_patterns/);
  assert.match(source, /primary_classic_pattern/);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /recoverReentry/);
  assert.match(source, /isRedundantChartControl/);
  assert.match(source, /isStandaloneArtifact/);
  assert.doesNotMatch(source, /sendTelegram|telegramNotifier|supabase\.from|createOrder|DAYTRADE_INTRADAY_SCORE_ENABLED|smart_setup_score_bonus\s*=/i);
});

test('ABCD detector remains separate while classic detector owns expanded formations', () => {
  const abcd = read('lib/pattern-abcd.js');
  const classic = read('lib/classic-chart-patterns.js');
  assert.match(abcd, /'Bullish ABCD'/);
  assert.match(abcd, /'Bearish ABCD'/);
  assert.doesNotMatch(abcd, /Head and Shoulder|Double Top|Double Bottom|Triangle|Pennant|Cup and Handle/);
  assert.match(classic, /HEAD_AND_SHOULDERS/);
  assert.match(classic, /DOUBLE_BOTTOM/);
  assert.match(classic, /ASCENDING_TRIANGLE/);
  assert.match(classic, /BULL_PENNANT/);
  assert.match(classic, /CUP_AND_HANDLE/);
});
