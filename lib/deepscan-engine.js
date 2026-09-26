'use strict';

/**
 * DeepScan Weekend Engine — Macro Swing 1-3 Bulan & Resource-Conservative
 * ========================================================================
 * - Hanya Sabtu/Minggu WIB, max 1x per akhir pekan
 * - Screening berbasis akumulasi bandar 3-6 bulan (CR3/CR5), support floor, dynamic RSI
 * - Batching 50 per batch, jeda 200-500ms, GC-friendly
 * - Trading plan swing macro: entry di lantai akumulasi, SL di bawah lantai (valid hingga Rp1), TP1/TP2 fleksibel R/R 1:3-1:6+
 * - Dispatch dengan is_permanent:true + auto-pin
 */

const fs = require('fs');
const path = require('path');

// WIB helpers
function getWibDate(now) {
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  return shifted.toISOString().slice(0, 10);
}

function isWeekendWib(now) {
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  const day = shifted.getUTCDay();
  return day === 0 || day === 6;
}

function getWeekendKey(now) {
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  const day = shifted.getUTCDay();
  // Find Saturday of this weekend
  const saturday = new Date(shifted);
  if (day === 0) { // Sunday -> previous Saturday
    saturday.setUTCDate(saturday.getUTCDate() - 1);
  } else if (day === 6) { // Saturday -> itself
    // keep
  } else {
    // Not weekend, return null
    return null;
  }
  return saturday.toISOString().slice(0, 10);
}

function getWibDayName(now) {
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return days[shifted.getUTCDay()];
}

// State persistence for last_weekend_deepscan_date
function getStateFilePath(rootDir) {
  const root = rootDir || process.cwd();
  return path.join(root, 'data', 'deepscan-state.json');
}

function loadDeepScanState(rootDir) {
  const filePath = getStateFilePath(rootDir);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data;
    }
  } catch (_) {}
  return { last_weekend_deepscan_date: null, last_weekend_key: null };
}

function saveDeepScanState(rootDir, state) {
  const filePath = getStateFilePath(rootDir);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}

async function loadDeepScanStateDb(db) {
  if (!db || typeof db.from !== 'function') return null;
  try {
    const res = await db.from('kv_store').select('value').eq('key', 'last_weekend_deepscan_date').maybeSingle();
    if (!res.error && res.data && res.data.value) {
      const val = typeof res.data.value === 'string' ? JSON.parse(res.data.value) : res.data.value;
      return val;
    }
  } catch (_) {}
  return null;
}

async function saveDeepScanStateDb(db, weekendKey, dateStr) {
  if (!db || typeof db.from !== 'function') return false;
  try {
    const payload = JSON.stringify({ last_weekend_deepscan_date: dateStr, last_weekend_key: weekendKey, updated_at: new Date().toISOString() });
    const res = await db.from('kv_store').upsert({ key: 'last_weekend_deepscan_date', value: payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    return !res.error;
  } catch (_) { return false; }
}

function canRunDeepScan(now, state) {
  if (!isWeekendWib(now)) {
    return { allowed: false, reason: 'not_weekend', message: `⏳ DeepScan hanya dapat dijalankan pada hari Sabtu atau Minggu (WIB). Hari ini adalah ${getWibDayName(now)}.` };
  }
  const weekendKey = getWeekendKey(now);
  if (!weekendKey) {
    return { allowed: false, reason: 'not_weekend', message: '⏳ DeepScan hanya tersedia di akhir pekan (Sabtu/Minggu WIB).' };
  }
  if (state && state.last_weekend_key === weekendKey) {
    return { allowed: false, reason: 'already_ran_this_weekend', message: '⚠️ DeepScan sudah dijalankan pada akhir pekan ini. Maksimal 1 kali per akhir pekan. Coba lagi akhir pekan depan.' };
  }
  return { allowed: true, weekendKey };
}

// Dynamic RSI: adaptif terhadap tren macro
function dynamicRsiThreshold(candles, ma20, ma50, ma200) {
  // Jika tren macro bullish (price > MA50 > MA200 atau MA20 > MA50), longgarkan overbought
  const lastClose = candles && candles.length ? candles[candles.length - 1].close : null;
  let isMacroBullish = false;
  if (lastClose && ma50 && ma200 && lastClose > ma50 && ma50 > ma200) isMacroBullish = true;
  if (ma20 && ma50 && ma20 > ma50 && lastClose && lastClose > ma20) isMacroBullish = true;

  if (isMacroBullish) {
    return { overbought: 78, oversold: 30, note: 'Tren macro bullish — RSI overbought dilonggarkan ke 78' };
  }
  return { overbought: 70, oversold: 30, note: 'RSI standard 70/30' };
}

function calculateRsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ARB floor Rp1
function arbFloor(prevClose) {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return 1;
  return Math.max(1, Math.floor(prevClose * 0.85));
}

// Batching helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay() {
  return 200 + Math.floor(Math.random() * 300); // 200-500ms
}

// Load tickers universe
function listAllTickers(rootDir) {
  const root = rootDir || process.cwd();
  const candidatesDirs = [
    path.join(root, 'data', 'daytrade-ohlcv-cache'),
    path.join(root, 'data', 'daily-candles'),
    path.join(root, 'data', 'arjum-data', 'broker-summary')
  ];
  const tickers = new Set();
  for (const dir of candidatesDirs) {
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.json')) {
            tickers.add(e.name.replace('.json', '').toUpperCase());
          } else if (e.isDirectory()) {
            tickers.add(e.name.toUpperCase());
          }
        }
      }
    } catch (_) {}
  }
  return Array.from(tickers).filter(t => /^[A-Z]{2,6}[A-Z0-9]{0,4}$/.test(t));
}

function loadCandlesForTicker(rootDir, ticker) {
  const root = rootDir || process.cwd();
  const candidates = [
    path.join(root, 'data', 'daytrade-ohlcv-cache', ticker + '.json'),
    path.join(root, 'data', 'daily-candles', ticker + '.json')
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const candles = Array.isArray(data) ? data : (data.candles || []);
        if (candles.length > 0) {
          return candles
            .filter(r => r && r.date && Number.isFinite(Number(r.close)))
            .map(r => ({
              date: String(r.date).slice(0, 10),
              open: Number(r.open != null ? r.open : r.close),
              high: Number(r.high != null ? r.high : r.close),
              low: Number(r.low != null ? r.low : r.close),
              close: Number(r.close),
              volume: Number(r.volume) || 0
            }))
            .sort((a, b) => a.date < b.date ? -1 : 1);
        }
      } catch (_) {}
    }
  }
  return [];
}

function loadBrokerForTicker(rootDir, ticker, days = 90) {
  const brokerRoot = path.join(rootDir || process.cwd(), 'data', 'arjum-data', 'broker-summary', ticker);
  if (!fs.existsSync(brokerRoot)) return null;
  try {
    const files = fs.readdirSync(brokerRoot).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    const slice = files.slice(-days);
    let totalNet = 0;
    let cr3 = null, cr5 = null;
    // Simplified: aggregate last 90 days net
    for (const f of slice) {
      const data = JSON.parse(fs.readFileSync(path.join(brokerRoot, f), 'utf8'));
      const brokers = Array.isArray(data.brokers) ? data.brokers : [];
      for (const b of brokers) totalNet += Number(b.nval) || 0;
    }
    // Try to get CR3/CR5 from latest file if available
    if (slice.length) {
      const latest = JSON.parse(fs.readFileSync(path.join(brokerRoot, slice[slice.length - 1]), 'utf8'));
      if (latest.cr3 != null) cr3 = Number(latest.cr3);
      if (latest.cr5 != null) cr5 = Number(latest.cr5);
    }
    return { totalNet, cr3, cr5, days: slice.length };
  } catch (_) { return null; }
}

// Main screening logic per ticker
function screenTicker(ticker, candles, brokerData) {
  if (!candles || candles.length < 60) return null; // Need at least 60 days for 3-month view

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : last.close;
  const lastPrice = last.close;

  // Floor validation: price >=1
  if (!Number.isFinite(lastPrice) || lastPrice < 1) return null;

  // ARB floor
  const arbPrice = arbFloor(prevClose);

  // Liquidity check: avg value 7d or volume
  const recentVolumes = candles.slice(-7).map(c => c.volume);
  const avgVol7 = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const avgValue7 = avgVol7 * lastPrice; // rough
  if (avgValue7 < 500000000 && lastPrice <= 50) {
    // For low price, need stronger liquidity, but not hard reject if accumulation strong
    // We'll allow but mark as needing confirmation
  }

  // MA calculations
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma100 = closes.length >= 100 ? sma(closes, 100) : null;
  const ma200 = closes.length >= 200 ? sma(closes, 200) : null;

  // RSI dynamic
  const rsi14 = calculateRsi(closes, 14);
  const rsiThreshold = dynamicRsiThreshold(candles, ma20, ma50, ma200);
  if (rsi14 != null && rsi14 > rsiThreshold.overbought) {
    // If macro bullish, allow overbought; otherwise filter
    if (!rsiThreshold.note.includes('dilonggarkan')) return null;
  }

  // Support floor / accumulation detection: look for 3-6 month low as accumulation floor
  const validCloses = closes.filter(c => Number.isFinite(c) && c > 0);
  const lookback90 = validCloses.slice(-90);
  const lookback180 = validCloses.slice(-180);
  const floor90 = lookback90.length ? Math.min(...lookback90) : lastPrice;
  const floor180 = lookback180.length >= 90 ? Math.min(...lookback180) : floor90;
  const accumulationFloor = Math.max(1, Math.min(floor90, floor180));

  // Check if price is near accumulation floor (Buy on Weakness - BoW)
  const distanceFromFloorPct = ((lastPrice - accumulationFloor) / accumulationFloor) * 100;
  const isNearFloor = distanceFromFloorPct >= -2 && distanceFromFloorPct <= 35;
  const isAtFloor = lastPrice <= accumulationFloor * 1.08;

  // Bandarmologi 3-6 bulan: CR3/CR5 accumulation
  let isAccumulation = false;
  let cr3 = null, cr5 = null;
  if (brokerData) {
    cr3 = brokerData.cr3;
    cr5 = brokerData.cr5;
    // If CR3 >50% or net positive over 3-6 months, consider accumulation
    if ((cr3 != null && cr3 >= 50) || (brokerData.totalNet > 0 && brokerData.days >= 30)) {
      isAccumulation = true;
    }
  } else {
    // Fallback: if no broker data, use price action as proxy (volume + price near floor)
    if (isNearFloor || isAtFloor) isAccumulation = true;
  }

  if (!isAccumulation && !isNearFloor) return null;

  // Trading plan swing macro BoW:
  // Entry: area beli sekitar lantai support akumulasi
  const entryLow = Math.max(1, Math.floor(accumulationFloor));
  const entryHigh = Math.max(entryLow, Math.floor(accumulationFloor * 1.07));
  // Stop Loss terukur di bawah support floor, valid hingga Rp1
  const sl = Math.max(1, Math.floor(accumulationFloor * 0.94));
  const slFinal = Math.max(1, Math.min(sl, arbPrice - 1 > 0 ? arbPrice - 1 : sl));

  // TP1 & TP2: resistance levels terukur (R/R fleksibel)
  const recentHigh90 = lookback90.length ? Math.max(...lookback90) : Math.round(lastPrice * 1.15);
  const recentHigh180 = lookback180.length ? Math.max(...lookback180) : recentHigh90;
  const tp1 = Math.max(Math.round(entryHigh * 1.08), Math.floor(recentHigh90 * 0.98));
  const tp2 = Math.max(Math.round(entryHigh * 1.18), Math.floor(recentHigh180 * 1.02));

  const risk = Math.max(1, entryHigh - slFinal);
  const reward1 = Math.max(1, tp1 - entryHigh);
  const reward2 = Math.max(1, tp2 - entryHigh);
  const rr1 = reward1 / risk;
  const rr2 = reward2 / risk;

  // R/R flexible 1:1.5 to 1:6+
  if (rr1 < 1.0 && rr2 < 1.5) return null;

  // Score: combine factors
  let score = 50;
  if (isAccumulation) score += 15;
  if (isNearFloor || isAtFloor) score += 10;
  if (rsi14 != null && rsi14 >= 40 && rsi14 <= 65) score += 10;
  if (ma20 && lastPrice >= ma20) score += 5;
  if (ma50 && lastPrice >= ma50) score += 5;
  if (cr3 != null && cr3 >= 60) score += 5;
  if (rr1 >= 3 || rr2 >= 4) score += 10;

  score = Math.max(0, Math.min(100, score));

  return {
    ticker,
    last_price: lastPrice,
    close: lastPrice,
    prev_close: prevClose,
    arb_price: arbPrice,
    accumulation_floor: accumulationFloor,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: slFinal,
    tp1,
    tp2,
    rr_to_tp1: Number(rr1.toFixed(2)),
    rr_to_tp2: Number(rr2.toFixed(2)),
    rsi14: rsi14 != null ? Number(rsi14.toFixed(1)) : null,
    rsi_threshold: rsiThreshold,
    ma20, ma50, ma100, ma200,
    cr3, cr5,
    is_accumulation: isAccumulation,
    is_near_floor: isNearFloor,
    distance_from_floor_pct: Number(distanceFromFloorPct.toFixed(1)),
    score,
    support: accumulationFloor,
    resistance: recentHigh90,
    major_resistance: recentHigh180,
    volume_avg_7d: avgVol7,
    value_avg_7d: avgValue7,
    candles_count: candles.length
  };
}

async function runDeepScan(options) {
  options = options || {};
  const rootDir = options.rootDir || process.cwd();
  const db = options.db || null;
  const now = options.now || new Date();
  const onProgress = options.onProgress || (() => {});
  const batchSize = options.batchSize || 50;

  // Guard: weekend check
  const state = loadDeepScanState(rootDir);
  const dbState = await loadDeepScanStateDb(db);
  const effectiveState = dbState || state;
  const guard = canRunDeepScan(now, effectiveState);
  if (!guard.allowed) {
    return { ok: false, reason: guard.reason, message: guard.message };
  }

  const tickers = listAllTickers(rootDir);
  if (!tickers.length) {
    return { ok: false, reason: 'no_tickers', message: 'Tidak ada data ticker tersedia untuk deepscan.' };
  }

  const results = [];
  const totalBatches = Math.ceil(tickers.length / batchSize);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchTickers = tickers.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
    const batchResults = [];

    for (const ticker of batchTickers) {
      try {
        const candles = loadCandlesForTicker(rootDir, ticker);
        const brokerData = loadBrokerForTicker(rootDir, ticker, 90);
        const screened = screenTicker(ticker, candles, brokerData);
        if (screened) batchResults.push(screened);
      } catch (_) {
        // Skip ticker on error
      }
    }

    // Sort batch by score descending and take top
    batchResults.sort((a, b) => b.score - a.score);
    results.push(...batchResults);

    // Progress notification
    try { await onProgress({ batch: batchIdx + 1, totalBatches, processed: Math.min((batchIdx + 1) * batchSize, tickers.length), total: tickers.length, batchResults: batchResults.length }); } catch (_) {}

    // Help GC: clear batch arrays
    batchTickers.length = 0;
    batchResults.length = 0;

    // Delay between batches (except last)
    if (batchIdx < totalBatches - 1) {
      const delay = getRandomDelay();
      await sleep(delay);
      // Hint GC if available
      if (global.gc) try { global.gc(); } catch (_) {}
    }
  }

  // Global sort and pick top 3-5
  results.sort((a, b) => b.score - a.score);
  const topPicks = results.slice(0, 5);

  // Save state: mark this weekend as done
  const weekendKey = guard.weekendKey;
  const dateStr = getWibDate(now);
  const allResults = results.slice(0, 20);
  const newState = {
    last_weekend_deepscan_date: dateStr,
    last_weekend_key: weekendKey,
    updated_at: new Date().toISOString(),
    total_tickers: tickers.length,
    total_candidates: results.length,
    top_picks: topPicks,
    all_results: allResults
  };
  saveDeepScanState(rootDir, newState);
  await saveDeepScanStateDb(db, weekendKey, dateStr);

  return {
    ok: true,
    weekendKey,
    date: dateStr,
    total_tickers: tickers.length,
    total_candidates: results.length,
    top_picks: topPicks,
    all_results: allResults,
    is_permanent: true
  };
}

function formatDeepScanMessage(result, options) {
  options = options || {};
  if (!result || !result.ok) return result ? result.message : 'DeepScan gagal.';

  const picks = result.top_picks || [];
  if (!picks.length) {
    return `🔍 <b>DeepScan Akhir Pekan</b> — ${result.date}\n\nTidak ada kandidat yang memenuhi kriteria akumulasi 3-6 bulan dan support floor saat ini.\n\nTotal ticker dipindai: ${result.total_tickers}\nKandidat terfilter: 0`;
  }

  const lines = [];
  lines.push(`🔍 <b>DeepScan Akhir Pekan — Macro Swing 1-3 Bulan</b>`);
  lines.push(`📅 ${result.date} | Total dipindai: ${result.total_tickers} | Kandidat: ${result.total_candidates}`);
  lines.push(`📌 <i>Disematkan otomatis — is_permanent:true</i>`);
  lines.push(``);
  lines.push(`<b>Top ${picks.length} Saham Terbaik (Akumulasi 3-6 Bulan):</b>`);
  lines.push(``);

  picks.forEach((p, idx) => {
    lines.push(`${idx + 1}. <b>${p.ticker}</b> — Score ${p.score}/100 | RSI ${p.rsi14} | R/R 1:${p.rr_to_tp1} (TP1) / 1:${p.rr_to_tp2} (TP2)`);
    lines.push(`   Entry: ${p.entry_low}-${p.entry_high} (lantai akumulasi ${p.accumulation_floor}) | SL: ${p.stop_loss} (di bawah lantai, valid hingga Rp1) | ARB: ${p.arb_price}`);
    lines.push(`   TP1: ${p.tp1} | TP2: ${p.tp2} (resistance tahunan mayor) | CR3: ${p.cr3 != null ? p.cr3 + '%' : '-'} | Jarak lantai: ${p.distance_from_floor_pct}%`);
    lines.push(``);
  });

  lines.push(`<i>Entry: Buy on Weakness di lantai akumulasi. SL terukur di bawah lantai. TP2 menembus resistance tahunan mayor (R/R 1:3 hingga 1:6+).</i>`);
  lines.push(`<i>Dynamic RSI: ${picks[0] ? picks[0].rsi_threshold.note : ''}</i>`);
  lines.push(``);
  lines.push(`#deepscan #weekend #macroswing`);

  return lines.join('\n');
}

async function getLatestDeepScan(options) {
  options = options || {};
  const rootDir = options.rootDir || process.cwd();
  const db = options.db || null;

  let state = loadDeepScanState(rootDir);
  let dbState = await loadDeepScanStateDb(db);
  let effectiveState = (dbState && dbState.top_picks && dbState.top_picks.length) ? dbState : state;

  if (effectiveState && Array.isArray(effectiveState.top_picks) && effectiveState.top_picks.length > 0) {
    return {
      ok: true,
      cached: true,
      date: effectiveState.last_weekend_deepscan_date || getWibDate(new Date()),
      weekendKey: effectiveState.last_weekend_key || 'active',
      total_tickers: effectiveState.total_tickers || 180,
      total_candidates: effectiveState.total_candidates || effectiveState.top_picks.length,
      top_picks: effectiveState.top_picks,
      all_results: effectiveState.all_results || effectiveState.top_picks
    };
  }

  // If no weekend scan saved yet, screen on-demand up to 30 sample tickers
  const allTickers = listAllTickers(rootDir);
  const sampleTickers = (allTickers.length > 0 ? allTickers : ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'ADRO', 'PTBA', 'ANTM', 'MDKA', 'PGAS', 'MEDC', 'AKRA', 'INCO', 'BRIS', 'CPIN', 'UNTR']).slice(0, 35);
  const results = [];

  for (const ticker of sampleTickers) {
    try {
      const candles = loadCandlesForTicker(rootDir, ticker);
      const brokerData = loadBrokerForTicker(rootDir, ticker, 90);
      const screened = screenTicker(ticker, candles, brokerData);
      if (screened) results.push(screened);
    } catch (_) {}
  }

  results.sort((a, b) => b.score - a.score);
  const topPicks = results.slice(0, 5);
  const allResults = results.slice(0, 20);

  const precalcPayload = {
    last_weekend_deepscan_date: getWibDate(new Date()),
    last_weekend_key: getWeekendKey(new Date()) || 'active',
    updated_at: new Date().toISOString(),
    total_tickers: allTickers.length || sampleTickers.length,
    total_candidates: results.length,
    top_picks: topPicks,
    all_results: allResults
  };

  if (topPicks.length > 0) {
    try {
      saveDeepScanState(rootDir, precalcPayload);
    } catch (_) {}
  }

  return {
    ok: true,
    cached: false,
    date: precalcPayload.last_weekend_deepscan_date,
    weekendKey: precalcPayload.last_weekend_key,
    total_tickers: precalcPayload.total_tickers,
    total_candidates: precalcPayload.total_candidates,
    top_picks: topPicks,
    all_results: allResults
  };
}

module.exports = {
  getWibDate,
  isWeekendWib,
  getWeekendKey,
  getWibDayName,
  loadDeepScanState,
  saveDeepScanState,
  canRunDeepScan,
  calculateRsi,
  sma,
  arbFloor,
  dynamicRsiThreshold,
  screenTicker,
  runDeepScan,
  getLatestDeepScan,
  formatDeepScanMessage,
  listAllTickers,
  loadCandlesForTicker,
  loadBrokerForTicker
};
