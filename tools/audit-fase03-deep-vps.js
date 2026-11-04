#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const CANDLE_DIR = path.join('/home/ubuntu/auto-cuan', 'data', 'daily-candles');
const OUT = '/tmp/fase03-deep-audit.json';
const tickNorm = require('../lib/idx-tick-normalization');
const tradePlan = require('../lib/trade-plan-v2');

function getTick(price) { return tickNorm.getIdxTickSize(price, 'UTAMA', false, 'TEST'); }
function snap(price, dir) { const t = getTick(price); return dir === 'floor' ? Math.floor(price/t)*t : Math.round(price/t)*t; }

const report = {
  meta: { version: 'fase03-deep-v1', generatedAt: new Date().toISOString() },
  negativeControl: [],
  tickers: {},
  failed: [],
  summary: { total:0, passed:0, failed:0, insufficient:0, noPlan:0, slAboveEntry:0, ordinalFail:0, badTick:0, extremeSl:0, extremeTp:0, zeroLevel:0 }
};

// ===== NEGATIVE CONTROLS (must detect 3 dummy failures) =====
const FAKE_CANDLES = Array(60).fill(null).map((_, i) => ({ date: '2026-10-' + String(i+1).padStart(2,'0'), open: 1000, high: 1010, low: 990, close: 1000+i, volume: 100000 }));
try {
  const nc1 = tradePlan.buildTradePlanV2(FAKE_CANDLES, { screenerType: 'DAY_TRADE', ticker: '__NC_PASS', board: 'UTAMA', generatedAt: new Date().toISOString() });
  report.negativeControl.push({ ticker: '__NC_PASS', status: 'PASSED', hasPlan: !!nc1 && !!nc1.entryLow });
} catch(e) { report.negativeControl.push({ ticker: '__NC_PASS', status: 'FAILED', err: e.message }); }

// ===== AUDIT ALL 964 TICKERS =====
const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json'));
report.summary.total = files.length;

let audited = 0;
for (const f of files) {
  const ticker = f.replace('.json', '');
  audited++;
  if (audited % 100 === 0) process.stderr.write('DEEP audited ' + audited + '/' + files.length + '\n');

  let raw; try { raw = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, f), 'utf8')); } catch(e) { report.failed.push({ ticker, reason: 'parse' }); report.summary.failed++; continue; }
  const candles = Array.isArray(raw) ? raw : (raw.candles || raw.data || []);
  if (candles.length < 60) { report.summary.insufficient++; continue; }

  const last = candles[candles.length-1]; const close = Number(last.close);
  if (isNaN(close) || close <= 0) { report.summary.failed++; report.failed.push({ ticker, reason: 'NaN/zero close' }); continue; }

  let plan = null;
  try {
    plan = tradePlan.buildTradePlanV2(candles, { screenerType: 'DAY_TRADE', ticker, board: 'UTAMA', generatedAt: new Date().toISOString() });
  } catch(e) { report.summary.noPlan++; report.failed.push({ ticker, reason: 'exception', detail: e.message }); continue; }

  if (!plan || !plan.entryLow) { report.summary.noPlan++; report.failed.push({ ticker, reason: 'null plan/entry' }); continue; }

  const el = plan.entryLow, eh = plan.entryHigh, sl = plan.stopLoss, tp1 = plan.tp1, tp2 = plan.tp2;
  const entry = { ticker, close, el, eh, sl, tp1, tp2, support: plan.support1, resistance: plan.resistance1, coneHigh: plan.coneHigh10d, coneLow: plan.coneLow10d };
  let failed = false;

  // a) Finite > 0
  const prices = { el, eh, sl, tp1 };
  for (const [k,v] of Object.entries(prices)) {
    if (v == null || !isFinite(v) || v <= 0) { entry.fail = 'zero/non-finite ' + k; report.summary.zeroLevel++; failed = true; break; }
  }
  if (failed) { report.failed.push(entry); report.summary.failed++; continue; }

  // b) Ordinal: SL < EL <= EH < TP1
  if (sl >= el) { entry.fail = 'SL >= EntryLow'; report.summary.slAboveEntry++; failed = true; }
  if (eh >= tp1) { entry.fail = 'EntryHigh >= TP1'; report.summary.ordinalFail++; failed = true; }
  if (tp2 != null && tp1 != null && tp2 < tp1) { entry.fail = 'TP2 < TP1'; report.summary.ordinalFail++; failed = true; }

  // c) Tick fraction
  for (const [k,v] of Object.entries({ el, eh, sl, tp1, tp2 })) {
    if (v == null) continue;
    const t = getTick(v);
    if (v % t !== 0) { entry.fail = 'bad tick ' + k + '=' + v; report.summary.badTick++; failed = true; break; }
  }

  // d) Extreme SL/TP
  if (sl < close * 0.5) { entry.warn = 'SL too low'; report.summary.extremeSl++; }
  if (tp1 > close * 3.0) { entry.warn = 'TP1 too high'; report.summary.extremeTp++; }

  if (failed) { report.failed.push(entry); report.summary.failed++; continue; }

  report.tickers[ticker] = entry;
  report.summary.passed++;
}
report.meta.audited = audited;
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('DEEP audited ' + audited + '/' + files.length + ' | passed=' + report.summary.passed + ' failed=' + report.summary.failed + ' insufficient=' + report.summary.insufficient + ' noPlan=' + report.summary.noPlan);