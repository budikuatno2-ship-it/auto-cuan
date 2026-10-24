const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDom() {
  const elements = {};
  function makeEl(id) {
    return {
      id,
      innerHTML: '',
      textContent: '',
      style: {},
      attributes: {},
      children: [],
      classList: {
        add(c) { this._classes = this._classes || new Set(); this._classes.add(c); },
        remove(c) { if (this._classes) this._classes.delete(c); },
        contains(c) { return !!(this._classes && this._classes.has(c)); },
        toggle(c, v) { if (v) this.add(c); else this.remove(c); }
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; }
    };
  }

  const elIds = [
    'panel-tab-ranking', 'rankingSearchInput', 'rankingPresetSeg', 'rankingPresetInd',
    'btnRankingPreset0', 'btnRankingPreset1', 'btnRankingPreset2', 'btnRankingPreset3',
    'rankingCountLabel', 'btnRankingCsv', 'rankingTableWrap', 'rankingPinnedRow',
    'rankingProvenance', 'rankingDateVal', 'rankingPaywallGate', 'rankingContentWrap'
  ];
  for (const id of elIds) {
    elements[id] = makeEl(id);
  }

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl('created-' + tag),
      querySelectorAll: () => []
    },
    console,
    URL,
    Intl,
    Date,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);

  const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analisis-saham-runtime.js'), 'utf8');
  vm.runInContext(runtimeSrc, sandbox);

  return { sandbox, elements };
}

test('Ranking: normalizes rows with real data and calculates composite score', () => {
  const { sandbox } = createMockDom();
  const normalize = sandbox.window.normalizeRankingRow;
  assert.equal(typeof normalize, 'function');

  const rawRow = {
    ticker: 'BBCA',
    last_price: 10250,
    change_pct: 0.98,
    rsi_14: 58.4,
    week52_high_dist_pct: -1.92,
    volume_ratio_vs_7d_avg: 1.4,
    foreign_net_today: 185000000000, // 185 B in IDR
    foreign_net_3d: 412500000000,
    as_of_trade_date: '2026-10-13'
  };

  const norm = normalize(rawRow, 0);
  assert.equal(norm.t, 'BBCA');
  assert.equal(norm.p, 10250);
  assert.equal(norm.c, 0.98);
  assert.equal(norm.rsi, 58.4);
  assert.equal(norm.h, -1.92);
  assert.equal(norm.v, 1.4);
  assert.equal(Math.round(norm.f1), 185);
  assert.equal(Math.round(norm.f3), 413);
  assert.ok(norm.s >= 15 && norm.s <= 99, 'score in valid range: ' + norm.s);
  assert.equal(norm.as_of, '2026-10-13');
});

test('Ranking: presets filter data correctly', () => {
  const { sandbox } = createMockDom();
  const state = sandbox.window.rankingState;
  const render = sandbox.window.renderRankingTable;
  const setPreset = sandbox.window.setRankingPreset;

  assert.equal(typeof setPreset, 'function');
  assert.equal(typeof render, 'function');

  state.rows = [
    { t: 'BBCA', p: 10000, c: 2.5, rsi: 35.0, f1: 50, f3: 100, s: 90 },
    { t: 'GOTO', p: 65, c: -2.0, rsi: 28.0, f1: -10, f3: -20, s: 40 },
    { t: 'TLKM', p: 3000, c: 0.5, rsi: 55.0, f1: -5, f3: 10, s: 60 }
  ];

  // Preset 0: Semua
  setPreset(0);
  assert.equal(state._currentFilteredRows.length, 3);

  // Preset 1: Top gainer (c >= 1.5)
  setPreset(1);
  assert.equal(state._currentFilteredRows.length, 1);
  assert.equal(state._currentFilteredRows[0].t, 'BBCA');

  // Preset 2: Asing beli (f1 > 0 && f3 > 0)
  setPreset(2);
  assert.equal(state._currentFilteredRows.length, 1);
  assert.equal(state._currentFilteredRows[0].t, 'BBCA');

  // Preset 3: RSI rebound (rsi < 40)
  setPreset(3);
  assert.equal(state._currentFilteredRows.length, 2);
  assert.ok(state._currentFilteredRows.some(r => r.t === 'BBCA'));
  assert.ok(state._currentFilteredRows.some(r => r.t === 'GOTO'));
});

test('Ranking: sorts data placing nulls last', () => {
  const { sandbox } = createMockDom();
  const state = sandbox.window.rankingState;
  const setSort = sandbox.window.setRankingSort;

  state.rows = [
    { t: 'MEDC', p: 1380, c: 4.15, rsi: null, s: 91 },
    { t: 'BBCA', p: 10250, c: 0.98, rsi: 58.4, s: 94 },
    { t: 'GOTO', p: 65, c: -1.5, rsi: 38.0, s: 42 }
  ];

  // Sort by RSI descending
  state.preset = 0;
  state.sortKey = 'rsi';
  state.sortDirection = 'desc';
  sandbox.window.renderRankingTable();

  const sorted = state._currentFilteredRows;
  assert.equal(sorted[0].t, 'BBCA'); // 58.4
  assert.equal(sorted[1].t, 'GOTO'); // 38.0
  assert.equal(sorted[2].t, 'MEDC'); // null placed last
});

test('Ranking: pinned row and unpinning update state and DOM', () => {
  const { sandbox, elements } = createMockDom();
  const pin = sandbox.window.pinRankingRow;
  const unpin = sandbox.window.unpinRankingRow;

  sandbox.window.rankingState.rows = [
    { t: 'BBCA', p: 10250, c: 0.98, rsi: 58.4, f3: 412.5, s: 94 }
  ];
  sandbox.window.renderRankingTable();

  pin('BBCA');
  assert.equal(sandbox.window.rankingState.selectedTicker, 'BBCA');
  assert.equal(elements['rankingPinnedRow'].style.display, 'block');
  assert.ok(elements['rankingPinnedRow'].innerHTML.includes('BBCA'));
  assert.ok(elements['rankingPinnedRow'].innerHTML.includes('Buka Chart Workstation'));

  unpin();
  assert.equal(sandbox.window.rankingState.selectedTicker, null);
  assert.equal(elements['rankingPinnedRow'].style.display, 'none');
});
