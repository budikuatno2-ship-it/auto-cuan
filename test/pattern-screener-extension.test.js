'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const extension = require('../public/pattern-screener-extension');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('official Screener labels and trade levels enrich matching Pattern cards without reading prose', () => {
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
          entry_low:100, entry_high:104, stop_loss:96, tp1:110, tp2:118, risk_reward:2.1,
          status:'READY_BREAKOUT',
          notes:'Head and Shoulders only in free prose'
        },
        { ticker:'TLKM', raw_payload:{ smart_setup_labels:[{ setup_label:'Uptrend Pullback' }], primary_classic_pattern:{ label:'Ascending Triangle' }, entry_low:2800, entry_high:2850, stop_loss:2720, tp1:2940, tp2:3020 } }
      ] }
    },
    {
      name: 'Day Trade',
      payload: { rows: [
        { ticker:'BBCA.JK', smart_setup_labels:['Bullish Harami+'], entry_low:101, entry_high:103, stop_loss:98, tp1:107, tp2:111, risk_reward:1.8 },
        { ticker:'ASII', status:'BULLISH_FLAG', notes:'Double Bottom', entry_low:5000, entry_high:5050, stop_loss:4900, tp1:5150, tp2:5250 }
      ] }
    }
  ]);

  assert.deepEqual(setups, [
    {
      ticker:'ASII', labels:[], sources:['Day Trade'],
      tradePlan:{ source:'Day Trade', entry_low:5000, entry_high:5050, stop_loss:4900, tp1:5150, tp2:5250, risk_reward:null }
    },
    {
      ticker:'BBCA', labels:['VCP Setup', 'Smart Money Before Rally', 'Cup and Handle', 'Bullish Harami+'], sources:['Swing Konglo', 'Day Trade'],
      tradePlan:{ source:'Day Trade', entry_low:101, entry_high:103, stop_loss:98, tp1:107, tp2:111, risk_reward:1.8 }
    },
    {
      ticker:'TLKM', labels:['Uptrend Pullback', 'Ascending Triangle'], sources:['Swing Konglo'],
      tradePlan:{ source:'Swing Konglo', entry_low:2800, entry_high:2850, stop_loss:2720, tp1:2940, tp2:3020, risk_reward:null }
    }
  ]);
  assert.doesNotMatch(JSON.stringify(setups), /\[object Object\]|free prose|READY_BREAKOUT|BULLISH_FLAG/);
});

test('trade-plan extraction reads official entry, stop, TP1, TP2, and RR fields only', () => {
  assert.deepEqual(extension.officialTradePlan({
    entry_low:'100', entry_high:105, stop_loss:95, tp1:110, tp2:120, risk_reward:2.5,
    notes:'entry 1-999 stop 1 tp1 9999'
  }, 'Day Trade'), {
    source:'Day Trade', entry_low:100, entry_high:105, stop_loss:95, tp1:110, tp2:120, risk_reward:2.5
  });
  assert.equal(extension.entryText({ entry_low:100, entry_high:105 }), '100–105');
  assert.equal(extension.entryText({ entry_low:100, entry_high:100 }), '100');
  assert.equal(extension.officialTradePlan({ notes:'Entry 100 TP1 120' }, 'Screener'), null);
});

test('generic and malformed pattern labels are ignored', () => {
  assert.equal(extension.labelText({ setup_label:'VCP Setup' }), 'VCP Setup');
  assert.equal(extension.labelText({ label:'Double Bottom' }), 'Double Bottom');
  assert.equal(extension.labelText({}), null);
  assert.equal(extension.labelText('No Clear Pattern'), null);
  assert.equal(extension.labelText('[object Object]'), null);
});

test('Screener labels and official levels enrich existing Pattern cards only', () => {
  const source = read('public/pattern-screener-extension.js');
  assert.match(source, /syncExistingCards/);
  assert.match(source, /querySelectorAll\('\[data-screener-only="1"\]'\)/);
  assert.match(source, /card\.remove\(\)/);
  assert.match(source, /\.ps-card:not\(\[data-screener-only="1"\]\)/);
  assert.match(source, /Level Screener/);
  assert.match(source, /<span>Entry<\/span>/);
  assert.match(source, /<span>Stop Loss<\/span>/);
  assert.match(source, /<span>TP1<\/span>/);
  assert.match(source, /<span>TP2<\/span>/);
  assert.doesNotMatch(source, /setupOnlyCardHtml|data-setup-chart|insertAdjacentHTML\('beforeend'/);
});

test('artifact cleanup stays narrow and the dead Technical Chart control is always removed', () => {
  assert.equal(extension.isStandaloneArtifact(';'), true);
  assert.equal(extension.isStandaloneArtifact(' ; \n'), true);
  assert.equal(extension.isStandaloneArtifact('Risiko; keputusan manual.'), false);
  assert.equal(extension.isRedundantChartControl('Technical Chart', '', ''), true);
  assert.equal(extension.isRedundantChartControl(' Technical Chart ', 'technicalChartTab', 'chart'), true);
  assert.equal(extension.isRedundantChartControl('Lihat Chart', '', ''), false);
  assert.equal(extension.isRedundantChartControl('Buka Chart', '', ''), false);
});

test('runtime loads after stable Pattern and preserves protected systems', () => {
  const loader = read('public/assets/fca-stocks.js');
  const source = read('public/pattern-screener-extension.js');
  new vm.Script(source, { filename:'pattern-screener-extension.js' });
  assert.ok(loader.indexOf('/pattern-stable-runtime.js') < loader.indexOf('/pattern-screener-extension.js'));
  assert.match(loader, /pattern-tab-resume-v1/);
  assert.match(loader, /pattern-stable-v3/);
  assert.match(loader, /pattern-screener-v6/);
  assert.match(source, /smart_setup_labels/);
  assert.match(source, /classic_chart_patterns/);
  assert.match(source, /primary_classic_pattern/);
  assert.match(source, /entry_low/);
  assert.match(source, /stop_loss/);
  assert.match(source, /tp1/);
  assert.match(source, /tp2/);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /removeRedundantChartControl/);
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
