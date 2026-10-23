'use strict';

// HANDOFF 5a "Lencana konsistensi bandar": largest net buyer over 20 archived
// sessions, net-buy days out of the last 10, streak. Disk only, no invented
// reading when fewer than 5 sessions are archived.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { computeBrokerConsistency, dayNets, MIN_DAYS } = require('../lib/broker-consistency');
const realService = require('../lib/bandarmologi-service');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Synthetic summaries in the shape normalizeBrokerSummary returns.
function fakeService(byDate) {
  return {
    listDiskDates: () => Object.keys(byDate),
    readDiskCache: (_e, _t, d) => byDate[d] || null,
    normalizeBrokerSummary: (raw) => raw
  };
}
function day(nets) {
  return { net_buyers: Object.keys(nets).filter((k) => nets[k] > 0).map((k) => ({ broker: k, nval: nets[k] })), net_sellers: Object.keys(nets).filter((k) => nets[k] <= 0).map((k) => ({ broker: k, nval: nets[k] })) };
}
function dates(count) {
  const out = []; const d = new Date(Date.UTC(2026, 8, 1));
  while (out.length < count) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

test('top broker, days out of 10 and streak from a known series', () => {
  const ds = dates(12), byDate = {};
  // MG buys on 8 of the last 10 sessions and the last 4 in a row; YP buys big once.
  const mg = [1, 1, 1, -1, 1, 1, -1, 1, 1, 1, 1, 1];
  ds.forEach((d, i) => { byDate[d] = day({ MG: mg[i] * 10e9, YP: i === 0 ? 30e9 : -5e9 }); });
  const r = computeBrokerConsistency('bbri', { service: fakeService(byDate) });
  assert.equal(r.ticker, 'BBRI');
  assert.equal(r.data_available, true);
  assert.equal(r.top_broker, 'MG');
  assert.equal(r.of_days, 10);
  assert.equal(r.days_net_buy, 8);
  assert.equal(r.streak, 5);
  assert.equal(r.window_days, 12);
  assert.equal(r.as_of_date, ds[11]);
  assert.equal(r.recent.length, 10);
});

test('fewer than 5 archived sessions gives no reading', () => {
  const ds = dates(MIN_DAYS - 1), byDate = {};
  ds.forEach((d) => { byDate[d] = day({ MG: 1e9 }); });
  const r = computeBrokerConsistency('BBRI', { service: fakeService(byDate) });
  assert.equal(r.data_available, false);
  assert.equal(r.top_broker, undefined);
  assert.equal(r.days_net_buy, undefined, 'no count is made up');
});

test('only the last 20 sessions count', () => {
  const ds = dates(30), byDate = {};
  ds.forEach((d, i) => { byDate[d] = day(i < 10 ? { OLD: 99e9, MG: -1e9 } : { OLD: -1e9, MG: 2e9 }); });
  const r = computeBrokerConsistency('BBRI', { service: fakeService(byDate) });
  assert.equal(r.window_days, 20);
  assert.equal(r.top_broker, 'MG');
  assert.equal(r.days_net_buy, 10);
});

test('net value read from nval or buy minus sell', () => {
  const m = dayNets({ gross_buyers: [{ broker: 'AK', bval: 5, sval: 2 }], net_sellers: [{ broker_code: 'YP', nval: -3 }] });
  assert.equal(m.AK.net, 3);
  assert.equal(m.YP.net, -3);
});

// Real broker summaries archived locally (2026-10-01..14), when present.
test('real BBCA archive through the real normaliser', (t) => {
  const dir = 'D:/Auto-Cuan/data-subset/broker-summary/BBCA';
  if (!fs.existsSync(dir)) return t.skip('local archive not present');
  const svc = {
    listDiskDates: () => fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)),
    readDiskCache: (_e, _t, d) => JSON.parse(fs.readFileSync(path.join(dir, d + '.json'), 'utf8')),
    normalizeBrokerSummary: realService.normalizeBrokerSummary
  };
  const r = computeBrokerConsistency('BBCA', { service: svc });
  assert.equal(r.data_available, true);
  assert.match(r.top_broker, /^[A-Z]{2}$/);
  assert.ok(r.net_total > 0);
  assert.ok(r.days_net_buy >= 0 && r.days_net_buy <= r.of_days);
  assert.equal(r.recent.filter((x) => x.net_buy).length, r.days_net_buy);
});

test('API action validates the ticker and is in the handler', () => {
  const src = read('api/sector-hot.js');
  assert.match(src, /action === 'broker-consistency'/);
  assert.match(src, /\/\^\[A-Z0-9\]\{2,8\}\$\/\.test\(tk\)/);
  assert.match(src, /computeBrokerConsistency\(tk\)/);
});

test('layer is stock only and on in Investor and Pro, as in the canvas', () => {
  const src = read('public/chart-workstation.js');
  assert.match(src, /id: 'bandar_kons', name: 'Konsistensi broker'/);
  assert.match(src, /bandar_par_f: 1, bandar_kons: 1 \}/);
  const presets = src.slice(src.indexOf('var PRESETS'), src.indexOf('MODE_STRATEGY_CONFIG = {'));
  assert.match(presets, /investor: \{[^}]*'bandar_kons'\]/);
  assert.match(presets, /pro: \{[^}]*'bandar_kons'\]/);
  assert.ok(!/simpel: \{[^}]*bandar_kons/.test(presets));
  assert.ok(!/scalping: \{[^}]*bandar_kons/.test(presets));
  assert.ok(!/swing: \{[^}]*bandar_kons/.test(presets));
});

test('badge text: reading, streak wording, and empty state', () => {
  const sb = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] }, Intl, Math, Number, String, Object, Array, Date, Promise, isFinite };
  sb.window.document = sb.document;
  vm.runInNewContext(read('public/analisis-v2.js'), sb);
  const a = sb.window.AutoCuanAnalisisV2;
  const on = a.konsHtml({ data_available: true, top_broker: 'MG', top_broker_name: 'SEMESTA INDOVEST', days_net_buy: 8, of_days: 10, streak: 4, window_days: 20, as_of_date: '2026-10-14' });
  assert.match(on.html, /Bandar<\/span><b class="k-b">MG<\/b>/);
  assert.match(on.html, /net buy 8\/10 hari/);
  assert.match(on.html, /--k:80%/);
  assert.match(on.html, /beruntun 4 hari/);
  assert.match(on.title, /data s\.d\. 2026-10-14/);
  assert.match(a.konsHtml({ data_available: true, top_broker: 'MG', days_net_buy: 3, of_days: 10, streak: 0 }).html, /hari ini tidak net buy/);
  const off = a.konsHtml({ data_available: false });
  assert.equal(off.html, 'Konsistensi: belum cukup data');
  assert.doesNotMatch(off.html, /\d/, 'no number when there is no data');
  assert.equal(a.konsHtml(null).html, 'Konsistensi: belum cukup data');
});

test('badge CSS hides on phones and has a dark token', () => {
  const css = read('public/ac-v2.css');
  assert.match(css, /@media \(max-width: 640px\) \{ html #appContent #page-analisis \.ana-kons \{ display: none; \} \}/);
  assert.match(css, /html\.is-dark #appContent #page-analisis \.ana-kons \{ --k-ink: #97A8F2/);
});
