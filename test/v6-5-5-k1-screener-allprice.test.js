'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const idxTick = require(path.join(ROOT, 'lib', 'idx-tick.js'));
const threeHorizonStore = require(path.join(ROOT, 'lib', 'three-horizon-config-store.js'));
const { buildHorizonCandidate } = require(path.join(ROOT, 'tools', 'regenerate-local-snapshots.js'));
const screenerApi = require(path.join(ROOT, 'api', 'screener.js'));
const top5RadarApi = require(path.join(ROOT, 'api', 'top5-radar.js'));
const { evaluateGates } = require(path.join(ROOT, 'public', 'signal-gate-transparency.js'));

function makeUpCandles(count, targetEndClose, stepPct = 0.35, volBase = 40000000, lastMult = 2.0) {
  const out = [];
  let d = new Date('2026-08-01T00:00:00Z');
  let cur = Math.max(5, targetEndClose * 0.93);
  while (out.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const idx = out.length;
      const isLast = idx === count - 1;
      // Pullbacks keep RSI ~56-62 within all horizon windows
      const wave = isLast ? 0.008 : (idx % 3 === 1 ? -0.009 : 0.0065);
      cur = Math.max(1, cur * (1 + wave));
      const cVal = isLast ? targetEndClose : Math.max(1, Math.round(cur));
      const spread = Math.max(1, Math.round(cVal * 0.025));
      out.push({
        time: d.toISOString().slice(0, 10),
        open: Math.max(1, cVal - Math.round(spread * 0.35)),
        high: cVal + spread,
        low: Math.max(1, cVal - Math.round(spread * 0.8)),
        close: cVal,
        volume: Math.round(volBase * (isLast ? lastMult : 1.0))
      });
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function makeRichBrokerAll(candles) {
  return candles.slice(-20).map((c) => ({
    date: c.time,
    emptyConfirmed: false,
    bval: 10e9,
    sval: 6e9,
    nval: 4e9,
    top3BuyNet: 3.2e9,
    top5BuyNet: 3.8e9,
    totalTurnover: 16e9,
    cr3Pct: 65,
    cr5Pct: 78,
    instBuy: 7e9,
    instSell: 2e9,
    retailBuy: 1.5e9,
    retailSell: 4e9,
    instNet: 5e9,
    retailNet: -2.5e9,
    rawObj: {
      stock_code: 'TEST',
      all_data: true,
      brokers: [
        { broker_code: 'ZP', bval: 4e9, sval: 1e9, nval: 3e9 },
        { broker_code: 'AK', bval: 3e9, sval: 1e9, nval: 2e9 },
        { broker_code: 'BK', bval: 2e9, sval: 1e9, nval: 1e9 },
        { broker_code: 'YP', bval: 1e9, sval: 3e9, nval: -2e9 }
      ]
    }
  }));
}

function makeRichBrokerForeign(candles) {
  return candles.slice(-20).map((c) => ({
    date: c.time,
    emptyConfirmed: false,
    bval: 3e9,
    sval: 1.5e9,
    nval: 1.5e9,
    rawObj: {
      stock_code: 'TEST',
      brokers: [
        { broker_code: 'ZP', bval: 2e9, sval: 5e8, nval: 1.5e9 },
        { broker_code: 'AK', bval: 1e9, sval: 1e9, nval: 0 }
      ]
    }
  }));
}

test('K1-1: All-Price >= Rp 1 admits Rp 26 / Rp 18 / Rp 47 liquid stocks with valid IDX tick order 1 <= SL < entry_low <= entry_high < TP1 < TP2', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  for (const px of [18, 26, 47]) {
    const candles = makeUpCandles(65, px, 0.35, 80000000, 2.2);
    const latestDate = candles[candles.length - 1].time;
    const allBr = makeRichBrokerAll(candles);
    const forBr = makeRichBrokerForeign(candles);

    const cand = buildHorizonCandidate(
      `LOW${px}`,
      candles,
      allBr,
      forBr,
      cfg.horizons.potensi_besok,
      latestDate,
      `Emiten Rp ${px}`,
      false,
      cfg.horizons.potensi_besok.minRr
    );
    assert.ok(cand, `Rp ${px} liquid stock must not be rejected by legacy <50 floor`);
    assert.ok(cand.sl >= 1 && cand.sl < cand.entry_low && cand.entry_low <= cand.entry_high && cand.entry_high < cand.tp1 && cand.tp1 < cand.tp2,
      `Level ordering failed for Rp ${px}: SL=${cand.sl}, E=${cand.entry_low}-${cand.entry_high}, TP1=${cand.tp1}, TP2=${cand.tp2}`);
    assert.equal(idxTick.isIdxTickValid(cand.sl), true);
    assert.equal(idxTick.isIdxTickValid(cand.tp1), true);
    assert.equal(idxTick.isIdxTickValid(cand.tp2), true);
  }
});

test('K1-2: Wires real pillars — Derived Domestic (ALL-F), CR3/Inst, Foreign, Insider 30D, KSEI freeFloat & Fundamental into pillar_breakdown', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  const candles = makeUpCandles(65, 620, 0.35, 25000000, 1.6);
  const latestDate = candles[candles.length - 1].time;
  const allBr = makeRichBrokerAll(candles);
  const forBr = makeRichBrokerForeign(candles);

  const candWithExtra = buildHorizonCandidate(
    'ADRO',
    candles,
    allBr,
    forBr,
    cfg.horizons.short_swing,
    latestDate,
    'Alamtri Resources Indonesia Tbk',
    true,
    cfg.horizons.short_swing.minRr,
    {
      insider: { signal: 'BUY_30D', buyCount: 2, sellCount: 0, netShares: 5000000, latestDate, bonus: 5 },
      fundamental: { net_profit: 12000, pbv: 1.25, market_cap: 90e12, sector: 'Energy', fundamental_period: 'Q3 2026', free_float_pct: 32.5 },
      ksei: { ticker: 'ADRO', freeFloat: 33.1, as_of: '2026-10-30' }
    }
  );
  assert.ok(candWithExtra);
  assert.ok(candWithExtra.bandar_score > 60, 'CR3 + Inst/Retail + Domestic produces strong bandar score');
  assert.ok(candWithExtra.domestic_score > 50 && candWithExtra.domestic_net > 0, 'Derived Domestic (ALL - F) must be positive');
  assert.ok(candWithExtra.foreign_score > 50 && candWithExtra.foreign_net > 0);
  assert.equal(candWithExtra.insider_signal, 'BUY_30D');
  assert.equal(candWithExtra.free_float_pct, 33.1);
  assert.equal(candWithExtra.pbv, 1.25);
  assert.ok(candWithExtra.pillar_breakdown && candWithExtra.pillar_breakdown.domestic.formula === 'ALL - Foreign');

  const gateEval = evaluateGates(candWithExtra, 'short_swing');
  assert.ok(gateEval.gates.some((g) => g.id === 'bandar' && g.passed === true), 'Bukti gate surfaces Bandar & Domestik');
  assert.ok(gateEval.gates.some((g) => g.id === 'foreign' && g.passed === true), 'Bukti gate surfaces Foreign');
  assert.ok(gateEval.gates.some((g) => g.id === 'ownership' && g.passed === true), 'Bukti gate surfaces Insider & FreeFloat');
});

test('K1-3: Swing (7-30H) admits structural EMA20 accumulation base below MA50 without opening weak junk', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  const closes = [];
  for (let i = 0; i < 35; i++) closes.push(1400 - i * 16); // drops to 856 -> MA50 stays high (~1090)
  for (let i = 0; i < 30; i++) closes.push(856 + (i % 3 === 1 ? -4 : 9)); // gradual accumulation base (~1000, > EMA20 ~965, < MA50 ~1070)
  const outCandles = [];
  let d = new Date('2026-08-01T00:00:00Z');
  let k = 0;
  while (outCandles.length < closes.length) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const c = closes[k++];
      outCandles.push({
        time: d.toISOString().slice(0, 10),
        open: c - 5,
        high: c + 30,
        low: c - 20,
        close: c,
        volume: 10000000
      });
    }
    d = new Date(d.getTime() + 86400000);
  }
  const latestDate = outCandles[outCandles.length - 1].time;
  const allBr = makeRichBrokerAll(outCandles);
  const forBr = makeRichBrokerForeign(outCandles);
  const swingCand = buildHorizonCandidate('BASE', outCandles, allBr, forBr, cfg.horizons.swing, latestDate, 'Base Reversal Tbk', false, cfg.horizons.swing.minRr);
  assert.ok(swingCand, 'Swing must admit strong rising-EMA20 accumulation base even during macro MA50 recovery');
  assert.ok(swingCand.rr >= 1.8);
});

test('K1-4: api/screener & api/top5-radar keep pre-21:00 WIB synchronized T-1 complete EOD READY without demoting valid picks', async () => {
  // 2026-11-25T10:30:00.000Z === 17:30 WIB (pre-21:00 WIB Broksum publish)
  const now1730Wib = new Date('2026-11-25T10:30:00.000Z').getTime();
  const reval = top5RadarApi.revalidatePick({
    ticker: 'WMUU',
    readiness: 'READY',
    last_price: 47,
    volume: 500000000,
    entry_low: 46,
    entry_high: 47,
    sl: 44,
    tp1: 53,
    tp2: 58,
    rr_at_max_entry: 2.0,
    data_status: 'AVAILABLE',
    trade_date: '2026-11-24'
  }, now1730Wib, { publicationBlocked: false, sourceDates: { broksum_all: '2026-11-24', ohlcv: '2026-11-25' } });
  assert.equal(reval.readiness_status, 'READY', 'All-Price Rp 47 T-1 pick must remain READY pre-21:00 WIB while awaiting today Broksum');
  assert.equal(reval.action, 'BUY');

  // Truly stale T-5 row must STILL fail closed
  const staleReval = top5RadarApi.revalidatePick({
    ticker: 'WMUU',
    readiness: 'READY',
    last_price: 47,
    volume: 500000000,
    entry_low: 46,
    entry_high: 47,
    sl: 44,
    tp1: 53,
    rr_at_max_entry: 2.0,
    data_status: 'AVAILABLE',
    trade_date: '2026-11-17'
  }, now1730Wib, { publicationBlocked: false, sourceDates: { broksum_all: '2026-11-24', ohlcv: '2026-11-25' } });
  assert.notEqual(staleReval.readiness_status, 'READY', 'Truly stale T-5 row must still be demoted');

  // screener.js buildCategory still marks T-1 AVAILABLE pre-21:00 when broksum matches T-1
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /pxVal < 50/, 'Legacy pxVal < 50 UI exclusion must be completely removed');
  assert.equal(typeof screenerApi.expectedCompletedEodDate, 'function');
});

test('K1-5: Dashboard quarantine ignores Insider SELL_30D and Track Record preserves 3-horizon & lifecycle status labels', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /insider\\s\+\(\?:sell\|buy\)_\?30/, 'isDashboardUnsafeActionable must strip Insider SELL_30D notes');
  assert.match(html, /\^risiko\\b/i, 'dashboardExcludedHtml must not double prefix Risiko Risiko Tinggi');
  assert.doesNotMatch(html, /sinyal kedaluwarsa setelah 10 hari bursa/, 'Track Record footer must describe Three-Horizon 5/10/30 hari bursa');

  const trJs = fs.readFileSync(path.join(ROOT, 'public', 'track-record-runtime.js'), 'utf8');
  assert.match(trJs, /oLabel\s*=\s*'SUDAH ENTRY'/);
  assert.match(trJs, /oLabel\s*=\s*'MENUNGGU ENTRY'/);
  assert.match(trJs, /oLabel\s*=\s*'AMBIGU BAR'/);
  assert.match(trJs, /indexOf\('short swing'\)/);

  const regenSrc = fs.readFileSync(path.join(ROOT, 'tools', 'regenerate-local-snapshots.js'), 'utf8');
  assert.match(regenSrc, /Insider Jual 30H/);
});
