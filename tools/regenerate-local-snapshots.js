#!/usr/bin/env node
'use strict';

/**
 * tools/regenerate-local-snapshots.js
 * ============================================================================
 * Pure local snapshot regeneration from canonical market.sqlite (ZERO quota).
 * Computes Three-Horizon Screener (Potensi Besok 1-5H, Short Swing 3-10H,
 * Swing 7-30H), Sektor Hot groups + members (VOL VS 30H), and Top 5 Radar
 * strictly from stored SQLite tables without touching raw history/broksum rows
 * and without calling paid upstream APIs.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const idxTick = require('../lib/idx-tick');
const threeHorizonStore = require('../lib/three-horizon-config-store');
const sectorRadar = require('../lib/sector-radar');
const sectorVolumeRatio = require('../lib/sector-volume-ratio');
const { getVpsMarketStore, keyFieldsFor } = require('../lib/vps-market-store');
const { buildSahamPotensialSnapshot, getTickerMap } = require('../lib/saham-potensial-engine');

function resolveDbPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    path.join(ROOT, 'data', 'market.sqlite')
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadKongloSet() {
  const set = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'conglomerates.json'), 'utf8'));
    for (const g of cfg.conglomerates || []) {
      for (const m of g.members || []) {
        if (m && m.ticker) set.add(String(m.ticker).trim().toUpperCase());
      }
    }
  } catch (_) {}
  return set;
}

function parseBrokerNet(rowJson) {
  let obj;
  try { obj = typeof rowJson === 'string' ? JSON.parse(rowJson) : rowJson; } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.brokers)) {
    let bval = 0;
    let sval = 0;
    let nval = 0;
    let top3BuyNet = 0;
    const positiveNets = [];
    for (const b of obj.brokers) {
      if (!b || typeof b !== 'object') continue;
      const bv = Number(b.bval || 0);
      const sv = Number(b.sval || 0);
      const nv = b.nval != null ? Number(b.nval) : (bv - sv);
      if (Number.isFinite(bv)) bval += bv;
      if (Number.isFinite(sv)) sval += sv;
      if (Number.isFinite(nv)) {
        nval += nv;
        if (nv > 0) positiveNets.push(nv);
      }
    }
    positiveNets.sort((a, b) => b - a);
    top3BuyNet = positiveNets.slice(0, 3).reduce((s, x) => s + x, 0);
    return { bval, sval, nval, top3BuyNet, totalTurnover: bval + sval };
  }
  const net = Number(obj.foreign_net ?? obj.net_value ?? obj.nval ?? 0);
  return Number.isFinite(net) ? { bval: 0, sval: 0, nval: net, top3BuyNet: Math.max(0, net), totalTurnover: Math.abs(net) } : null;
}

function calcEMA(arr, period) {
  if (!arr.length) return null;
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI14(closes) {
  if (closes.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgG = gains / 14;
  const avgL = losses / 14;
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function calcAtr14(candles) {
  if (candles.length < 2) return null;
  const slice = candles.slice(-Math.min(15, candles.length));
  let sum = 0;
  let count = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const p = slice[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (Number.isFinite(tr) && tr > 0) { sum += tr; count++; }
  }
  return count > 0 ? sum / count : null;
}

function clampScore(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function buildHorizonCandidate(ticker, candles, allBrokerSeries, foreignSeries, horizonCfg, maxTradeDate, emitenName, isKonglo, minRr) {
  if (!Array.isArray(candles) || candles.length < 25) return null;
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!latest || latest.time < maxTradeDate) return null; // skip suspended / stale tickers
  const close = Number(latest.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  const prevClose = Number(prev && prev.close) > 0 ? Number(prev.close) : close;
  const changePct = Number((((close - prevClose) / prevClose) * 100).toFixed(2));
  const valueTraded = close * Number(latest.volume || 0);
  if (valueTraded < 500000000) return null; // skip illiquid < 500M IDR

  const lb = Math.max(10, Number(horizonCfg.lookbackDays || 20));
  const windowCandles = candles.slice(-Math.min(candles.length, lb));
  const closes = candles.map((c) => Number(c.close));
  const ema20 = calcEMA(closes.slice(-Math.min(closes.length, 40)), 20) || close;
  const ema50 = calcEMA(closes.slice(-Math.min(closes.length, 80)), 50) || close;
  const rsi14 = calcRSI14(closes);
  const atr = calcAtr14(candles) || Math.max(idxTick.idxTickSize(close), close * 0.02);

  // Volume ratio vs trailing lookback mean
  const vols = windowCandles.slice(0, -1).map((c) => Number(c.volume || 0)).filter((v) => v > 0);
  const avgVol = vols.length ? (vols.reduce((a, b) => a + b, 0) / vols.length) : 0;
  const volRatio = avgVol > 0 && latest.volume > 0 ? Number((latest.volume / avgVol).toFixed(2)) : null;

  // Bandar accumulation ratio from recent arjum_broker_summary_all
  const recentAll = (allBrokerSeries || []).slice(-Math.min(5, (allBrokerSeries || []).length));
  const latestAll = recentAll.length ? recentAll[recentAll.length - 1] : null;
  const bandarAsOf = latestAll ? latestAll.date : null;
  let bandarScore = null;
  if (recentAll.length > 0) {
    let accSum = 0;
    let turnSum = 0;
    for (const r of recentAll) {
      accSum += r.top3BuyNet || 0;
      turnSum += r.totalTurnover || 0;
    }
    const ratio = turnSum > 0 ? accSum / turnSum : 0;
    bandarScore = clampScore(45 + ratio * 180);
  }

  // Foreign flow score from recent arjum_broker_summary_foreign
  const recentForeign = (foreignSeries || []).slice(-Math.min(5, (foreignSeries || []).length));
  const latestForeign = recentForeign.length ? recentForeign[recentForeign.length - 1] : null;
  const foreignAsOf = latestForeign ? latestForeign.date : null;
  let foreignScore = null;
  let foreignNetToday = null;
  if (recentForeign.length > 0) {
    foreignNetToday = latestForeign ? latestForeign.nval : 0;
    const netSum = recentForeign.reduce((s, r) => s + (r.nval || 0), 0);
    const ratio = valueTraded > 0 ? netSum / (valueTraded * recentForeign.length) : 0;
    foreignScore = clampScore(50 + ratio * 220);
  }

  // Technical score
  let techScore = 50;
  if (close > ema20) techScore += 14;
  if (ema20 > ema50) techScore += 10;
  if (rsi14 != null) {
    if (rsi14 >= 48 && rsi14 <= 68) techScore += 16;
    else if (rsi14 > 68 && rsi14 <= 78) techScore += 6;
    else if (rsi14 < 35) techScore -= 10;
  }
  if (changePct > 0 && changePct < 8) techScore += 6;
  techScore = clampScore(techScore);

  const volumeScore = volRatio != null ? clampScore(40 + Math.min(volRatio, 4) * 15) : null;

  // Dynamic risk plan snapped cleanly onto IDX tick grid
  const key = horizonCfg.key;
  const atrSlMult = key === 'potensi_besok' ? 1.2 : (key === 'short_swing' ? 1.6 : 2.2);
  const atrTp1Mult = key === 'potensi_besok' ? 2.1 : (key === 'short_swing' ? 2.8 : 4.0);
  const atrTp2Mult = key === 'potensi_besok' ? 3.2 : (key === 'short_swing' ? 4.4 : 6.2);

  const swingLow = Math.min(...windowCandles.map((c) => Number(c.low || close)));
  let entryLow = idxTick.roundDownToIdxTick(close - 0.35 * atr) || close;
  let entryHigh = idxTick.roundToIdxTick(close) || close;
  if (entryLow > entryHigh) entryLow = entryHigh;

  const rawSl = Math.max(swingLow * 0.99, entryHigh - atrSlMult * atr);
  let sl = idxTick.roundDownToIdxTick(rawSl);
  if (!sl || sl >= entryHigh) sl = idxTick.tickBelow(entryHigh);

  const risk = Math.max(1, entryHigh - sl);
  const minTp1ByRr = entryHigh + risk * Math.max(minRr || 1.5, 1.55);
  const rawTp1 = Math.max(minTp1ByRr, entryHigh + atrTp1Mult * atr);
  let tp1 = idxTick.roundUpToIdxTick(rawTp1);
  if (!tp1 || tp1 <= entryHigh) tp1 = idxTick.tickAbove(entryHigh);

  let rr = idxTick.rrFromLevels(entryHigh, sl, tp1);
  let guard = 0;
  while (rr != null && rr < (minRr || 1.5) && guard < 10) {
    tp1 = idxTick.tickAbove(tp1);
    rr = idxTick.rrFromLevels(entryHigh, sl, tp1);
    guard++;
  }
  if (!rr || rr < (minRr || 1.5)) return null;

  const rawTp2 = Math.max(tp1 + risk * 1.1, entryHigh + atrTp2Mult * atr);
  let tp2 = idxTick.roundUpToIdxTick(rawTp2);
  if (!tp2 || tp2 <= tp1) tp2 = idxTick.tickAbove(tp1);

  return {
    ticker,
    emiten: emitenName || ticker,
    stock_name: emitenName || ticker,
    last_price: close,
    close,
    high_price: Number(latest.high || close),
    low_price: Number(latest.low || close),
    change_pct: changePct,
    volume: Number(latest.volume || 0),
    volume_ratio: volRatio,
    volume_asof: maxTradeDate,
    technical_score: techScore,
    technical_asof: maxTradeDate,
    rsi14,
    bandar_score: bandarScore,
    bandar_asof: bandarAsOf,
    foreign_score: foreignScore,
    foreign_asof: foreignAsOf,
    foreign_net: foreignNetToday,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry1: entryHigh,
    entry2: entryLow,
    sl,
    stop_loss: sl,
    tp1,
    tp2,
    risk_reward: rr,
    rr,
    horizon: horizonCfg.key,
    horizon_label: horizonCfg.label,
    holding_label: horizonCfg.holdingLabel,
    intraday_status: 'OPEN',
    is_konglo: isKonglo,
    session_date: maxTradeDate,
    trade_date: maxTradeDate,
    price_asof: maxTradeDate,
    price_date: maxTradeDate,
    price_source: 'sqlite_market_rows',
    calculated_at: new Date().toISOString()
  };
}

function run(options = {}) {
  const dbPath = resolveDbPath(options.dbPath);
  if (!dbPath) throw new Error('CANONICAL_DB_NOT_FOUND');

  const { DatabaseSync } = require('node:sqlite');
  const roDb = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true });
  try { roDb.exec('PRAGMA busy_timeout=15000;'); } catch (_) {}

  const candlesByTicker = new Map();
  const allBrokerByTicker = new Map();
  const foreignByTicker = new Map();
  let maxTradeDate = '';

  try {
    const histRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_history'"
    ).all();
    for (const r of histRows) {
      let row;
      try { row = JSON.parse(r.row_json); } catch (_) { continue; }
      const ticker = String(row.ticker || String(r.row_key || '').split('\x1f')[0] || '').trim().toUpperCase();
      const dt = String(row.trade_date || row.date || '').slice(0, 10);
      const close = Number(row.close);
      if (!/^[A-Z0-9]{3,6}$/.test(ticker) || ticker === 'IHSG' || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      if (dt > maxTradeDate) maxTradeDate = dt;
      if (!candlesByTicker.has(ticker)) candlesByTicker.set(ticker, []);
      candlesByTicker.get(ticker).push({
        time: dt,
        open: Number(row.open) > 0 ? Number(row.open) : close,
        high: Number(row.high) > 0 ? Number(row.high) : close,
        low: Number(row.low) > 0 ? Number(row.low) : close,
        close,
        volume: Number(row.volume) >= 0 ? Number(row.volume) : 0
      });
    }
    for (const list of candlesByTicker.values()) list.sort((a, b) => a.time.localeCompare(b.time));

    const allRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_broker_summary_all'"
    ).all();
    for (const r of allRows) {
      const parts = String(r.row_key || '').split(/[\x1f ]+/);
      const dt = parts[1] ? parts[1].slice(0, 10) : '';
      const t = parts[0] ? parts[0].trim().toUpperCase() : '';
      const parsed = parseBrokerNet(r.row_json);
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dt) || !parsed) continue;
      if (!allBrokerByTicker.has(t)) allBrokerByTicker.set(t, []);
      allBrokerByTicker.get(t).push(Object.assign({ date: dt }, parsed));
    }
    for (const list of allBrokerByTicker.values()) list.sort((a, b) => a.date.localeCompare(b.date));

    const foreignRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_broker_summary_foreign'"
    ).all();
    for (const r of foreignRows) {
      const parts = String(r.row_key || '').split(/[\x1f ]+/);
      const dt = parts[1] ? parts[1].slice(0, 10) : '';
      const t = parts[0] ? parts[0].trim().toUpperCase() : '';
      const parsed = parseBrokerNet(r.row_json);
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dt) || !parsed) continue;
      if (!foreignByTicker.has(t)) foreignByTicker.set(t, []);
      foreignByTicker.get(t).push(Object.assign({ date: dt }, parsed));
    }
    for (const list of foreignByTicker.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  } finally {
    try { roDb.close(); } catch (_) {}
  }

  if (!maxTradeDate) throw new Error('NO_TRADE_DATE_IN_SQLITE');

  const cfgRead = threeHorizonStore.get();
  const cfg = cfgRead.ok ? cfgRead.doc : threeHorizonStore.DEFAULT_CONFIG;
  const tickerMap = getTickerMap();
  const kongloSet = loadKongloSet();
  const generatedAt = new Date().toISOString();

  const horizonSnapshots = {};
  for (const hKey of threeHorizonStore.HORIZON_KEYS) {
    const hCfg = cfg.horizons[hKey];
    const candidates = [];
    for (const [ticker, candles] of candlesByTicker.entries()) {
      const cand = buildHorizonCandidate(
        ticker,
        candles,
        allBrokerByTicker.get(ticker),
        foreignByTicker.get(ticker),
        hCfg,
        maxTradeDate,
        tickerMap[ticker] || (ticker + ' Tbk'),
        kongloSet.has(ticker),
        cfg.minRr
      );
      if (cand) candidates.push(cand);
    }

    const snap = buildSahamPotensialSnapshot(candidates, {
      sessionDate: maxTradeDate,
      minRiskReward: cfg.minRr,
      weights: hCfg.weights
    });

    // Attach horizon fields onto top20 & ensure top5 points to exact slice
    const enrichedTop20 = snap.top20.map((row, idx) => Object.assign({}, row, {
      rank: idx + 1,
      horizon: hKey,
      horizon_label: hCfg.label,
      holding_label: hCfg.holdingLabel,
      intraday_status: 'OPEN',
      trade_date: maxTradeDate,
      calculated_at: generatedAt,
      price_asof: maxTradeDate,
      price_date: maxTradeDate,
      price_source: 'sqlite_market_rows',
      is_konglo: kongloSet.has(row.ticker)
    }));

    horizonSnapshots[hKey] = Object.assign({}, snap, {
      horizon_key: hKey,
      horizon_label: hCfg.label,
      holding_label: hCfg.holdingLabel,
      lookback_days: hCfg.lookbackDays,
      weights: hCfg.weights,
      top20: enrichedTop20,
      picks: enrichedTop20,
      top5: enrichedTop20.slice(0, Math.min(5, enrichedTop20.length))
    });
  }

  const primaryHorizon = horizonSnapshots.short_swing;
  const kongloRows = [];
  for (const row of horizonSnapshots.short_swing.top20.concat(horizonSnapshots.swing.top20)) {
    if (kongloSet.has(row.ticker) && !kongloRows.some((x) => x.ticker === row.ticker)) {
      kongloRows.push(row);
    }
  }
  const nkRows = horizonSnapshots.swing.top20.filter((r) => !kongloSet.has(r.ticker));

  const threeHorizonDoc = {
    version: 1,
    release: 'Auto-Cuan IDX V6.5',
    generated_at: generatedAt,
    trade_date: maxTradeDate,
    config_version: cfg.version,
    horizons: horizonSnapshots,
    results: primaryHorizon.top20,
    top5: primaryHorizon.top5
  };

  const screenerLatestDoc = {
    trade_date: maxTradeDate,
    market_date: maxTradeDate,
    calculated_at: generatedAt,
    generated_by: 'tools/regenerate-local-snapshots.js',
    source_dates: {
      daytrade: maxTradeDate,
      eod: maxTradeDate
    },
    swing: primaryHorizon.top20,
    swing_non_konglo: horizonSnapshots.swing.top20,
    nk: horizonSnapshots.swing.top20,
    daytrade: horizonSnapshots.potensi_besok.top20,
    top5: primaryHorizon.top5,
    three_horizon: threeHorizonDoc.horizons
  };

  // Compute Sektor Hot from canonical market.sqlite
  const rawSectorGroups = sectorRadar.getSectorRadarGroups();
  const sectorGroups = sectorVolumeRatio.enrichGroupsWithVolumeRatios(rawSectorGroups);
  const sectorHotDoc = {
    generated_at: generatedAt,
    trade_date: maxTradeDate,
    groups: sectorGroups
  };

  const top5RadarDoc = primaryHorizon.top5.length > 0 ? {
    trade_date: maxTradeDate,
    market_date: maxTradeDate,
    generated_at: generatedAt,
    data_status: 'AVAILABLE',
    publication_blocked: false,
    top5: primaryHorizon.top5,
    picks: primaryHorizon.top5
  } : null;

  if (!options.dryRun) {
    atomicWriteJson(path.join(ROOT, 'data', 'three-horizon-latest.json'), threeHorizonDoc);
    atomicWriteJson(path.join(ROOT, 'data', 'screener-latest.json'), screenerLatestDoc);
    atomicWriteJson(path.join(ROOT, 'data', 'sector-hot-latest.json'), sectorHotDoc);
    if (top5RadarDoc) {
      atomicWriteJson(path.join(ROOT, 'data', 'top5-radar.json'), top5RadarDoc);
    }

    // Sync ONLY derived snapshot tables in VpsMarketStore (never raw history/broksum/insiders)
    if (!options.skipSqliteSync) {
      const store = getVpsMarketStore(dbPath);
      store.transaction(() => {
        store.clearTable('swing_screener_latest');
        for (const r of (kongloRows.length ? kongloRows : primaryHorizon.top20)) {
          store.writeRow('swing_screener_latest', r, keyFieldsFor('swing_screener_latest'), true);
        }
        store.writeRow('swing_screener_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          scanned_count: candlesByTicker.size,
          published_count: (kongloRows.length ? kongloRows : primaryHorizon.top20).length,
          status: 'ok',
          source: 'local_regeneration_v65'
        }, keyFieldsFor('swing_screener_meta'), true);

        store.clearTable('swing_screener_non_konglo_latest');
        for (const r of (nkRows.length ? nkRows : horizonSnapshots.swing.top20)) {
          store.writeRow('swing_screener_non_konglo_latest', r, keyFieldsFor('swing_screener_non_konglo_latest'), true);
        }
        store.writeRow('swing_screener_non_konglo_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          published_at: generatedAt,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          status: 'ok'
        }, keyFieldsFor('swing_screener_non_konglo_meta'), true);

        store.clearTable('daytrade_screener_latest');
        for (const r of horizonSnapshots.potensi_besok.top20) {
          store.writeRow('daytrade_screener_latest', r, keyFieldsFor('daytrade_screener_latest'), true);
        }
        store.writeRow('daytrade_screener_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          status: 'ok'
        }, keyFieldsFor('daytrade_screener_meta'), true);

        store.clearTable('sector_hot_latest');
        store.clearTable('sector_hot_members_latest');
        for (const g of sectorGroups) {
          store.writeRow('sector_hot_latest', {
            group_code: g.group_code,
            group_name: g.group_name,
            owner_label: g.owner_label,
            stock_count: g.stock_count,
            valid_count: (g.members || []).filter((m) => m.last_price != null).length,
            avg_change_pct: g.avg_change_pct,
            volume_ratio_30d: g.volume_ratio_30d,
            avg_volume_ratio: g.avg_volume_ratio,
            top_ticker: g.top_ticker,
            top_change_pct: g.top_change_pct,
            net_flow: g.net_flow,
            calculated_at: generatedAt,
            status: 'ok'
          }, keyFieldsFor('sector_hot_latest'), true);
          for (const m of (g.members || [])) {
            store.writeRow('sector_hot_members_latest', {
              group_code: g.group_code,
              ticker: m.ticker,
              stock_name: m.stock_name,
              last_price: m.last_price,
              change_pct: m.change_pct,
              volume_today: m.volume_today,
              volume_ratio_30d: m.volume_ratio_30d,
              net_foreign: m.net_foreign,
              member_type: m.member_type || 'MEMBER',
              calculated_at: generatedAt
            }, keyFieldsFor('sector_hot_members_latest'), true);
          }
        }
        store.writeRow('sector_hot_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          scanned_count: sectorGroups.reduce((s, g) => s + (g.stock_count || 0), 0),
          failed_count: 0,
          status: 'ok'
        }, keyFieldsFor('sector_hot_meta'), true);
      });
    }
  }

  return {
    ok: true,
    trade_date: maxTradeDate,
    tickers_evaluated: candlesByTicker.size,
    horizons: {
      potensi_besok: horizonSnapshots.potensi_besok.top20.length,
      short_swing: horizonSnapshots.short_swing.top20.length,
      swing: horizonSnapshots.swing.top20.length
    },
    sector_groups: sectorGroups.length
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipSqliteSync = args.includes('--files-only');
  try {
    const out = run({ dryRun, skipSqliteSync });
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('[regenerate-local-snapshots] FAIL:', err && err.message || err);
    process.exit(1);
  }
}

module.exports = { run };
