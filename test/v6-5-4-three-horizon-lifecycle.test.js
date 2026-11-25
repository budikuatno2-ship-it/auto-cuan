'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { buildHorizonCandidate } = require(path.join(ROOT, 'tools', 'regenerate-local-snapshots.js'));
const threeHorizonStore = require(path.join(ROOT, 'lib', 'three-horizon-config-store.js'));
const ledgerSync = require(path.join(ROOT, 'lib', 'three-horizon-ledger-sync.js'));
const spEngine = require(path.join(ROOT, 'lib', 'saham-potensial-engine.js'));
const spLifecycle = require(path.join(ROOT, 'lib', 'saham-potensial-lifecycle.js'));
const idxNorm = require(path.join(ROOT, 'lib', 'idx-tick-normalization.js'));
const idxTick = require(path.join(ROOT, 'lib', 'idx-tick.js'));
const { evaluateGates } = require(path.join(ROOT, 'public', 'signal-gate-transparency.js'));

function genCandles(count, startClose, stepPct, volBase, lastVolMult = 2.0, lowOverrideLast = null, preCloseBelow50 = false) {
  const out = [];
  let px = startClose;
  const start = new Date('2026-08-03T00:00:00Z');
  let added = 0;
  while (added < count) {
    start.setUTCDate(start.getUTCDate() + 1);
    if (start.getUTCDay() === 0 || start.getUTCDay() === 6) continue;
    const isLast = added === count - 1;
    px = Math.max(20, Math.round(px * (1 + (stepPct / 100))));
    const cVal = (preCloseBelow50 && added === count - 5) ? 45 : (isLast ? Math.max(startClose, px) : px);
    const low = isLast && lowOverrideLast != null ? lowOverrideLast : Math.round(cVal * 0.982);
    const high = Math.round(cVal * 1.015);
    out.push({
      time: start.toISOString().slice(0, 10),
      open: Math.round(cVal * 0.992),
      high: Math.max(high, cVal),
      low: Math.min(low, cVal),
      close: cVal,
      volume: Math.round(volBase * (isLast ? lastVolMult : 1.0))
    });
    added++;
  }
  return out;
}

function makeBrokerSeries(candles, days = 20) {
  return candles.slice(-days).map((c) => ({
    date: c.time,
    bval: 12e9,
    sval: 8e9,
    nval: 4e9,
    top3BuyNet: 3e9,
    totalTurnover: 20e9
  }));
}

test('V6.5.4-1: blocks < Rp 50 AND stocks with close < Rp 50 in last 20 trading sessions (WMUU pattern)', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  const candles = genCandles(60, 52, 0.2, 50000000, 2.5, null, true);
  const latestDate = candles[candles.length - 1].time;
  const broker = makeBrokerSeries(candles);
  for (const hKey of threeHorizonStore.HORIZON_KEYS) {
    const res = buildHorizonCandidate('WMUU', candles, broker, broker, cfg.horizons[hKey], latestDate, 'Widodo Makmur', false, cfg.horizons[hKey].minRr);
    assert.equal(res, null, `${hKey} must reject WMUU-like recent <50 close`);
  }
});

test('V6.5.4-2: rejects extreme SL beyond horizon band instead of forcing SL=-28% and keeps IDX ticks + ordering', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  const wideSwingCandles = genCandles(60, 250, 0.4, 20000000, 2.0, 190, false); // single bar 24% drop below close
  const latestDate = wideSwingCandles[wideSwingCandles.length - 1].time;
  const broker = makeBrokerSeries(wideSwingCandles);
  // Check structural SL rejection on extreme volatility
  wideSwingCandles.forEach((c, idx) => {
    if (idx >= 40 && idx < 59) {
      c.high = Math.round(c.close * 1.12);
      c.low = Math.round(c.close * 0.78);
    }
  });
  const blocked = buildHorizonCandidate('EXTM', wideSwingCandles, broker, broker, cfg.horizons.potensi_besok, latestDate, 'Extreme Co', false, 1.5);
  assert.equal(blocked, null, 'potensi_besok must hard-reject when structural/ATR SL exceeds 7%');

  const healthyCandles = genCandles(65, 500, 0.45, 30000000, 2.2, null, false);
  const hDate = healthyCandles[healthyCandles.length - 1].time;
  const hBroker = makeBrokerSeries(healthyCandles);
  for (const hKey of threeHorizonStore.HORIZON_KEYS) {
    const hCfg = cfg.horizons[hKey];
    const cand = buildHorizonCandidate('TEST', healthyCandles, hBroker, hBroker, hCfg, hDate, 'Test Tbk', false, hCfg.minRr);
    if (!cand) continue;
    assert.ok(cand.sl >= 50 && cand.sl < cand.entry_low && cand.entry_low <= cand.entry_high && cand.entry_high < cand.tp1 && cand.tp1 < cand.tp2);
    assert.equal(idxTick.isValidIdxTick(cand.entry_low), true);
    assert.equal(idxTick.isValidIdxTick(cand.entry_high), true);
    assert.equal(idxTick.isValidIdxTick(cand.sl), true);
    assert.equal(idxTick.isValidIdxTick(cand.tp1), true);
    assert.equal(idxTick.isValidIdxTick(cand.tp2), true);
    assert.ok(cand.sl_pct >= hCfg.slMinPct - 0.05 && cand.sl_pct <= hCfg.slMaxPct + 0.05);
    assert.ok(cand.tp1_pct >= hCfg.tp1MinPct - 0.05 && cand.tp1_pct <= hCfg.tp1MaxPct + 0.05);
    assert.ok(cand.rr >= hCfg.minRr);

    const gates = evaluateGates(cand, hKey);
    const rrGate = gates.gates.find((g) => g.id === 'rr');
    assert.equal(rrGate.passed, true, `SignalGateTransparency agrees on ${hKey}`);
  }
});

test('V6.5.4-3: Three-Horizon metadata propagated by engine (holding_days_max = 5 / 10 / 30, not fixed 5)', () => {
  const cfg = threeHorizonStore.DEFAULT_CONFIG;
  const mockCand = {
    ticker: 'BBCA', last_price: 9000, change_pct: 1.5, entry_low: 8900, entry_high: 9000,
    sl: 8500, tp1: 10000, tp2: 10800, bandar_score: 80, foreign_score: 75, technical_score: 78,
    volume_ratio: 1.8, bandar_asof: '2026-11-24', foreign_asof: '2026-11-24',
    technical_asof: '2026-11-24', volume_asof: '2026-11-24', price_asof: '2026-11-24'
  };
  for (const hKey of threeHorizonStore.HORIZON_KEYS) {
    const hCfg = cfg.horizons[hKey];
    const snap = spEngine.buildSahamPotensialSnapshot([mockCand], {
      sessionDate: '2026-11-24',
      minRiskReward: hCfg.minRr,
      weights: hCfg.weights,
      holdingLabel: hCfg.holdingLabel,
      holdingDaysMin: hCfg.minHoldingDays,
      holdingDaysMax: hCfg.maxHoldingDays
    });
    assert.equal(snap.holding_days_max, hCfg.maxHoldingDays);
    assert.equal(snap.top5[0].holding_days_max, hCfg.maxHoldingDays);
    assert.equal(snap.top5[0].expiry.days_max, hCfg.maxHoldingDays);
  }
});

test('V6.5.4-4: Daily age memory (BARU vs LANJUT H+N) + ledger sync active dedup per ticker+horizon', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-v654-mem-'));
  try {
    const mkRow = (ticker) => ({
      ticker, last_price: 500, entry_low: 495, entry_high: 500, sl: 470, tp1: 560, tp2: 600, rr: 2.0,
      holding_days_min: 3, holding_days_max: 10, holding_label: 'Short Swing (3–10H)', score: 86, confidence: 'A+'
    });
    const makeSnaps = (tkList) => ({
      potensi_besok: { holding_label: 'Potensi Besok (1–5H)', holding_days_max: 5, top20: tkList.map(mkRow), top5: tkList.map(mkRow) },
      short_swing: { holding_label: 'Short Swing (3–10H)', holding_days_max: 10, top20: tkList.map(mkRow), top5: tkList.map(mkRow) },
      swing: { holding_label: 'Swing (7–30H)', holding_days_max: 30, top20: tkList.map(mkRow), top5: tkList.map(mkRow) }
    });

    // Day 1: PWON new across horizons
    const s1 = makeSnaps(['PWON']);
    ledgerSync.annotateDailySignalMemory(s1, '2026-11-24', { rootDir: tmpDir });
    assert.equal(s1.potensi_besok.top20[0].signal_age_status, 'BARU');
    assert.equal(s1.potensi_besok.top20[0].signal_age_label, 'BARU');
    const l1 = ledgerSync.syncLiveSignalLedger(s1, '2026-11-24', '2026-11-24T14:20:00Z', { rootDir: tmpDir });
    assert.equal(l1.inserted, 3);

    // Day 2: PWON continues (LANJUT H+1), MIDI is new (BARU) -> dedup active PWON
    const s2 = makeSnaps(['PWON', 'MIDI']);
    ledgerSync.annotateDailySignalMemory(s2, '2026-11-25', { rootDir: tmpDir });
    assert.equal(s2.short_swing.top20[0].signal_age_status, 'LANJUT');
    assert.equal(s2.short_swing.top20[0].signal_age_label, 'LANJUT H+1');
    assert.equal(s2.short_swing.top20[1].signal_age_status, 'BARU');
    const l2 = ledgerSync.syncLiveSignalLedger(s2, '2026-11-25', '2026-11-25T14:20:00Z', { rootDir: tmpDir });
    assert.equal(l2.updatedActive, 3, 'Existing active PWON per horizon updated, not duplicated');
    assert.equal(l2.inserted, 3, 'Only new MIDI inserted per horizon');
    assert.equal(l2.total, 6);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('V6.5.4-5: Lifecycle expiry respects 5H / 10H / 30H per horizon', () => {
  const flatCandles = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 1 + i));
    return { trade_date: d.toISOString().slice(0, 10), high: 520, low: 505, close: 510 };
  });
  const basePick = { id: 1, date: '2026-09-30', ticker: 'BBRI', entry1: 500, entry2: 495, sl: 470, tp1: 560, tp2: 600, status: 'WAITING_ENTRY' };

  const res5 = spLifecycle.evaluateLifecycleHistory({ ...basePick, horizon_key: 'potensi_besok' }, flatCandles);
  const res10 = spLifecycle.evaluateLifecycleHistory({ ...basePick, horizon_key: 'short_swing' }, flatCandles);
  const res30 = spLifecycle.evaluateLifecycleHistory({ ...basePick, horizon_key: 'swing' }, flatCandles);
  assert.equal(res5.holdingDays, 5);
  assert.equal(res10.holdingDays, 10);
  assert.equal(res30.holdingDays, 30);

  const fSwing30 = idxNorm.deriveSetupFreshness({
    horizon_key: 'swing', monitor_source: 'three_horizon_top5', max_holding_days: 30,
    date: '2026-11-02', first_sent_at: '2026-11-02T00:00:00Z'
  }, { now: '2026-11-25T00:00:00Z' });
  assert.equal(fSwing30.setup_freshness_status, 'FRESH', '17 trading days stays FRESH inside 30H swing horizon');
});

test('V6.5.4-6: Pill tab UI & Landing Page Three-Horizon HTML/CSS wiring clean', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'ac-v2.css'), 'utf8');
  assert.match(html, /id="threeHorizonTabs"[\s\S]*?<span class="ind k1" id="threeHzInd">/);
  assert.match(html, /hzInd\.className\s*=\s*'ind c9-pill'\s*\+\s*\(key === 'swing' \? ' k2' : \(key === 'short_swing' \? ' k1' : ''\)\)/);
  assert.match(css, /#threeHorizonTabs \.ac-segment\.on/);
  assert.match(css, /#threeHorizonTabs \.ind\.k2/);
  assert.match(html, /data-c3sub="potensi_besok"[\s\S]*?data-c3sub="short_swing"[\s\S]*?data-c3sub="swing"/);
  assert.ok(!html.includes('data-c3sub="konglo"'), 'Landing preview no longer exposes Konglo/Non-Konglo subtabs');
});

test('V6.5.4-7: VpsMarketStore .or() supports .in.(...) for web-top5-history three_horizon_top5 rows', async () => {
  const os = require('os');
  const { VpsMarketStore } = require('../lib/vps-market-store');
  const tmpDb = path.join(os.tmpdir(), `ac_vps_or_${Date.now()}_${Math.random().toString(16).slice(2)}.sqlite`);
  const store = new VpsMarketStore(tmpDb);
  try {
    await store.from('telegram_daily_picks').upsert([
      { id: 101, date: '2026-08-04', ticker: 'BUMI', monitor_source: null, status: 'EXPIRED' },
      { id: 102, date: '2026-11-24', ticker: 'MYOR', monitor_source: 'three_horizon_top5', status: 'WAITING_ENTRY' },
      { id: 103, date: '2026-11-24', ticker: 'NOPE', monitor_source: 'daytrade', status: 'WAITING_ENTRY' }
    ]);
    const res = await store
      .from('telegram_daily_picks')
      .select('id,date,ticker,monitor_source')
      .or('monitor_source.in.(daily_top5,top5,three_horizon_top5),monitor_source.is.null')
      .order('date', { ascending: false });
    assert.equal(res.error, null);
    assert.deepEqual(res.data.map((r) => r.ticker), ['MYOR', 'BUMI']);
  } finally {
    store.close();
    try { fs.unlinkSync(tmpDb); } catch (_) {}
  }
});
