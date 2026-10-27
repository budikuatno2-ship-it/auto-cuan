'use strict';

// HANDOFF 5a: today's provisional bar ("sementara · diperbarui hh:mm") moved
// with series.update(), LPM named "LPM · kurva tekanan candle · Money Flow",
// and the "Watchlist + alert" star in the Analisis header.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const runtime = read('public/market-feature-runtime.js');
function extract(signature) {
  const start = runtime.indexOf(signature);
  assert.ok(start >= 0, signature);
  let depth = 0;
  for (let j = runtime.indexOf('{', start); j < runtime.length; j++) {
    if (runtime[j] === '{') depth++;
    else if (runtime[j] === '}') { depth--; if (depth === 0) return runtime.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + signature);
}

test('provisional label: only for a provisional bar, time in WIB', () => {
  const sb = { Math, Number, String, Date, isNaN };
  vm.createContext(sb);
  vm.runInContext(extract('function acProvisionalLabel(') + '\nthis.f=acProvisionalLabel;', sb);
  assert.equal(sb.f({ close: 1, provisional: true, updatedAt: '2026-10-23T07:32:00Z' }), 'sementara · diperbarui 14:32');
  assert.equal(sb.f({ close: 1, provisional: true, updated_at: '2026-10-23T02:05:00Z' }), 'sementara · diperbarui 09:05');
  assert.equal(sb.f({ close: 1, provisional: true }), 'sementara', 'no time invented when the server sends none');
  assert.equal(sb.f({ close: 1, provisional: true, updatedAt: 'nope' }), 'sementara');
  assert.equal(sb.f({ close: 1 }), '');
  assert.equal(sb.f(null), '');
});

test('legend carries the tag; today\'s bar goes through series.update()', () => {
  assert.equal((runtime.match(/' · ' \+ tf \+ '(?: · IDX)?<\/span>' \+ prov \+/g) || []).length, 2, 'desktop and phone legend');
  assert.match(runtime, /setHdr\('prov', acProvisionalLabel\(c\)\);/);
  const reg = runtime.slice(runtime.indexOf('updateBar: function(bar)'), runtime.indexOf('updateBar: function(bar)') + 2000);
  assert.match(reg, /candleSeries\.update\(bar\)/);
  assert.match(reg, /volumeSeries\.update\(/);
  assert.match(reg, /_lastLine\.applyOptions\(\{ price: lp\.price/);
  assert.match(reg, /updateCanvasHeader\(_lastCandle\)/);
  assert.match(reg, /if \(_hiLo\) _hiLo\.refresh\(\);/);
  assert.doesNotMatch(reg, /setData\(/, 'no full redraw for a live tick');
});

test('LPM is named after what it is and sits with Money Flow', () => {
  assert.match(runtime, /LPM · kurva tekanan candle · Money Flow <b/);
  assert.doesNotMatch(runtime, /Liquidity Pressure Model \(LPM\)/);
  const ws = read('public/chart-workstation.js');
  assert.match(ws, /id: 'bandar_lpm', name: 'LPM · kurva tekanan candle', desc: 'Dihitung dari candle harian \(OHLCV\), bukan data transaksi\./);
});

const STAR = '<button type="button" id="anaWlStar" class="vbtn sm wl-star-btn scr-star ana-wl"';
test('star markup is in all three Analisis copies', () => {
  ['public/partials/analisis-saham.partial.html', 'partials/analisis-saham.partial.html', 'public/index.html'].forEach((f) => {
    const html = read(f);
    assert.equal(html.split(STAR).length - 1, 1, f);
    assert.match(html, /onclick="AutoCuanAnalisisV2\.toggleWatch\(event\)"/);
    assert.match(html, /<span class="ana-wl-l">Watchlist \+ alert<\/span>/);
  });
});

function load(set, calls) {
  const star = {
    hidden: false, attrs: {}, cls: new Set(), svgFill: null, label: { textContent: '' },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    classList: { toggle(c, on) { on ? star.cls.add(c) : star.cls.delete(c); } },
    querySelector(q) { return q === 'svg' ? { setAttribute: (k, v) => { star.svgFill = v; } } : star.label; }
  };
  const sb = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: (id) => (id === 'anaWlStar' ? star : null), querySelectorAll: () => [] }, Intl, Math, Number, String, Object, Array, Date, Promise, isFinite };
  sb.window.document = sb.document;
  sb.window.__AUTOCUAN_WATCHLIST_SET__ = set;
  sb.window.toggleWatchlistTicker = (t) => { calls.push('toggle ' + t); if (set.has(t)) set.delete(t); else set.add(t); return Promise.resolve(); };
  sb.window.openCreateAlertModal = (t) => calls.push('alert ' + t);
  vm.runInNewContext(read('public/analisis-v2.js'), sb);
  return { api: sb.window.AutoCuanAnalisisV2, star };
}

test('star: save opens the alert form, remove does not; hidden for indices', async () => {
  const set = new Set(), calls = [];
  const { api, star } = load(set, calls);
  api.state.ticker = 'BBRI';
  api.syncStar();
  assert.equal(star.hidden, false);
  assert.equal(star.attrs['aria-pressed'], 'false');
  assert.equal(star.label.textContent, 'Watchlist + alert');
  await api.toggleWatch({});
  assert.deepEqual(calls, ['toggle BBRI', 'alert BBRI']);
  assert.equal(star.attrs['aria-pressed'], 'true');
  assert.equal(star.label.textContent, 'Dipantau');
  assert.equal(star.svgFill, 'currentColor');
  assert.ok(star.cls.has('on-star'));
  await api.toggleWatch({});
  assert.deepEqual(calls, ['toggle BBRI', 'alert BBRI', 'toggle BBRI']);
  assert.equal(star.label.textContent, 'Watchlist + alert');
  api.state.ticker = 'IHSG';
  api.syncStar();
  assert.equal(star.hidden, true);
  await api.toggleWatch({});
  assert.equal(calls.length, 3, 'an index is never saved');
});

test('star CSS: label hides on phones, 44px target on touch', () => {
  const css = read('public/ac-v2.css');
  assert.match(css, /@media \(max-width: 640px\) \{ html #appContent #page-analisis \.ana-wl \.ana-wl-l \{ display: none; \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ html #appContent #page-analisis \.ana-wl \{ height: 44px; min-width: 44px; \} \}/);
});
