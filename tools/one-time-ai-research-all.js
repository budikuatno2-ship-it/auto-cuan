#!/usr/bin/env node
'use strict';

/**
 * One-Time AI Research Runner for All IDX Tickers
 * 
 * Manual VPS runner that analyzes IDX tickers using multiple Shiteru AI chat models.
 * Produces detailed technical research files locally. NOT a production signal sender.
 * 
 * Safety: No Telegram, No Supabase, No SQL, No API endpoints, No cron.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const engine = require('../lib/daytrade-screener-engine');
const candleEngine = require('../lib/candle-pattern-engine');
const fibEngine = require('../lib/fibonacci-confluence');

const VERSION = 'one-time-ai-research-v1';


// ============================================================
// CONFIGURATION FROM ENV (read dynamically for testability)
// ============================================================

function getConfig() {
  return {
    SHITERU_BASE_URL: process.env.SHITERU_BASE_URL || '',
    SHITERU_API_KEY: process.env.SHITERU_API_KEY || '',
    AI_RESEARCH_MODELS: (process.env.AI_RESEARCH_MODELS || 'qwen-3.7-max,gpt-5.5,glm-5.2,kimi-k2.7,deepseek-v4-pro,deepseek-v4-flash').split(',').map(s => s.trim()).filter(Boolean),
    AI_RESEARCH_OUTPUT_DIR: process.env.AI_RESEARCH_OUTPUT_DIR || './data/ai-research',
    DAYTRADE_CACHE_DIR: process.env.DAYTRADE_CACHE_DIR || './data/daytrade-ohlcv-cache',
    AI_RESEARCH_TIMEOUT_MS: Number(process.env.AI_RESEARCH_TIMEOUT_MS || 60000),
    AI_RESEARCH_MAX_OUTPUT_TOKENS: Number(process.env.AI_RESEARCH_MAX_OUTPUT_TOKENS || 2200),
    AI_RESEARCH_TEMPERATURE: Number(process.env.AI_RESEARCH_TEMPERATURE || 0.2),
    AI_RESEARCH_CONCURRENCY: Number(process.env.AI_RESEARCH_CONCURRENCY || 1)
  };
}


// ============================================================
// CLI ARGUMENT PARSING
// ============================================================

function parseArgs(argv) {
  const args = {
    mode: 'observe',
    tickersFile: null,
    tickers: null,
    models: null,
    limit: null,
    all: false,
    concurrency: null,
    force: false,
    dryRun: false,
    includeRawCandles: false,
    streamAi: false,
    maxOutputTokens: null,
    temperature: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { args.all = true; continue; }
    if (a === '--force') { args.force = true; continue; }
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--include-raw-candles') { args.includeRawCandles = true; continue; }
    if (a === '--stream-ai') { args.streamAi = true; continue; }
    if (a.startsWith('--') && i + 1 < argv.length) {
      const key = a.slice(2);
      const val = argv[++i];
      if (key === 'mode') args.mode = val;
      else if (key === 'tickers-file') args.tickersFile = val;
      else if (key === 'tickers') args.tickers = val;
      else if (key === 'models') args.models = val;
      else if (key === 'limit') args.limit = Number(val);
      else if (key === 'concurrency') args.concurrency = Number(val);
      else if (key === 'max-output-tokens') args.maxOutputTokens = Number(val);
      else if (key === 'temperature') args.temperature = Number(val);
    }
  }
  return args;
}


// ============================================================
// TICKER PARSER
// ============================================================

function parseTickers(content) {
  if (!content || typeof content !== 'string') return [];
  const seen = new Set();
  const result = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/[,;\s]+/);
    for (const part of parts) {
      let ticker = part.trim().toUpperCase();
      if (!ticker) continue;
      // Strip .JK suffix
      ticker = ticker.replace(/\.JK$/i, '');
      if (!ticker) continue;
      if (!seen.has(ticker)) {
        seen.add(ticker);
        result.push(ticker);
      }
    }
  }
  return result;
}

async function loadTickers(args) {
  let tickers = [];
  if (args.tickersFile) {
    const content = await fsp.readFile(args.tickersFile, 'utf8');
    tickers = parseTickers(content);
  } else if (args.tickers) {
    tickers = parseTickers(args.tickers);
  }
  if (!args.all && args.limit && args.limit > 0) {
    tickers = tickers.slice(0, args.limit);
  }
  return tickers;
}


// ============================================================
// CACHE HELPERS (reuse from VPS observe worker pattern)
// ============================================================

function safeTicker(ticker) {
  return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function cachePath(cacheDir, ticker) {
  return path.join(cacheDir, safeTicker(ticker) + '.json');
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(Boolean).map(c => ({
    time: Number(c.time),
    date: c.date || (c.time ? new Date(Number(c.time) * 1000).toISOString().slice(0, 10) : undefined),
    open: Number(c.open), high: Number(c.high), low: Number(c.low),
    close: Number(c.close), volume: Number(c.volume)
  })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.open) &&
    Number.isFinite(c.high) && Number.isFinite(c.low) &&
    Number.isFinite(c.close) && Number.isFinite(c.volume));
}

async function readCacheFile(cacheDir, ticker) {
  try {
    const raw = await fsp.readFile(cachePath(cacheDir, ticker), 'utf8');
    const parsed = JSON.parse(raw);
    const candles = normalizeCandles(parsed.candles || []);
    return { hit: true, candles, updatedAt: parsed.updated_at || null };
  } catch (e) {
    return { hit: false, candles: [], updatedAt: null };
  }
}

async function writeCacheFile(cacheDir, ticker, candles) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const trimmed = normalizeCandles(candles).slice(-90);
  const payload = {
    version: 1, ticker: safeTicker(ticker), source: 'yahoo',
    range: '90d', interval: '1d',
    updated_at: new Date().toISOString(), candles: trimmed
  };
  await fsp.writeFile(cachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
  return trimmed;
}


// ============================================================
// YAHOO FINANCE FETCHER
// ============================================================

async function fetchCandlesYahoo(ticker, timeoutMs) {
  const symbol = safeTicker(ticker) + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=90d&interval=1d&includePrePost=false';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Auto-Cuan-AI-Research/1.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data && data.chart && data.chart.result && data.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!r || !q) return null;
    return normalizeCandles((r.timestamp || []).map((time, i) => ({
      time, open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i]
    })));
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCandles(ticker, cacheDir) {
  const cache = await readCacheFile(cacheDir, ticker);
  if (cache.hit && cache.candles.length >= 20) {
    // Check freshness: if older than 18h, try to refresh
    const age = cache.updatedAt ? Date.now() - Date.parse(cache.updatedAt) : Infinity;
    if (age < 18 * 60 * 60 * 1000) return cache.candles;
  }
  // Fetch fresh data
  const fetched = await fetchCandlesYahoo(ticker);
  if (fetched && fetched.length >= 20) {
    await writeCacheFile(cacheDir, ticker, fetched);
    return fetched;
  }
  // Fallback to cache if fetch failed
  if (cache.candles.length >= 20) return cache.candles;
  return null;
}


// ============================================================
// DETERMINISTIC ANALYSIS BUILDER
// ============================================================

function calcMA(arr, period) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(arr.length - period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function round2(val) { return Math.round(val * 100) / 100; }
function round0(val) { return Math.round(val); }

function sliceHighLow(candles, n) {
  const slice = candles.slice(-n);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function avgVolume(candles, n) {
  const slice = candles.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}


// ============================================================
// 90D NOTABLE EVENTS EXTRACTION
// Extracts key candles from the full 90D history so the AI
// understands structure without needing all raw candles.
// ============================================================

function extract90DNotableEvents(candles, ctx) {
  const events = [];
  const len = candles.length;
  if (len < 5) return events;

  ctx = ctx || {};
  const vol20 = ctx.vol20 || avgVolume(candles, Math.min(20, len));

  // Helper: compact candle for output
  function compact(c, label) {
    return {
      date: c.date, label,
      open: round0(c.open), high: round0(c.high),
      low: round0(c.low), close: round0(c.close), volume: c.volume
    };
  }

  // --- 90D high candle ---
  let highIdx = 0;
  for (let i = 1; i < len; i++) {
    if (candles[i].high > candles[highIdx].high) highIdx = i;
  }
  events.push(compact(candles[highIdx], '90d_high'));

  // --- 90D low candle ---
  let lowIdx = 0;
  for (let i = 1; i < len; i++) {
    if (candles[i].low < candles[lowIdx].low) lowIdx = i;
  }
  events.push(compact(candles[lowIdx], '90d_low'));

  // --- 60D high/low (if window is large enough) ---
  if (len >= 60) {
    const start60 = len - 60;
    let hi60 = start60, lo60 = start60;
    for (let i = start60 + 1; i < len; i++) {
      if (candles[i].high > candles[hi60].high) hi60 = i;
      if (candles[i].low < candles[lo60].low) lo60 = i;
    }
    if (hi60 !== highIdx) events.push(compact(candles[hi60], '60d_high'));
    if (lo60 !== lowIdx) events.push(compact(candles[lo60], '60d_low'));
  }

  // --- Highest volume candle ---
  let maxVolIdx = 0;
  for (let i = 1; i < len; i++) {
    if (candles[i].volume > candles[maxVolIdx].volume) maxVolIdx = i;
  }
  events.push(compact(candles[maxVolIdx], 'highest_volume'));

  // --- Top 3 volume spike candles (volume > 2x avg20, excluding highest) ---
  const volThreshold = vol20 * 2;
  const spikeCandidates = [];
  for (let i = 0; i < len; i++) {
    if (i === maxVolIdx) continue; // already included as highest_volume
    if (candles[i].volume >= volThreshold) {
      spikeCandidates.push({ idx: i, volume: candles[i].volume });
    }
  }
  spikeCandidates.sort((a, b) => b.volume - a.volume);
  for (let s = 0; s < Math.min(3, spikeCandidates.length); s++) {
    events.push(compact(candles[spikeCandidates[s].idx], 'volume_spike_' + (s + 1)));
  }

  // --- Demand/supply touch candles ---
  if (ctx.majorDemand && ctx.majorDemand > 0) {
    const demandTol = ctx.majorDemand * 0.015;
    for (let i = Math.max(0, len - 90); i < len; i++) {
      if (candles[i].low <= ctx.majorDemand + demandTol && candles[i].close > ctx.majorDemand) {
        events.push(compact(candles[i], 'demand_touch'));
        break; // most recent touch only from full scan, but add up to 2
      }
    }
    // Find most recent demand touch (scan from end)
    for (let i = len - 1; i >= Math.max(0, len - 30); i--) {
      if (candles[i].low <= ctx.majorDemand + demandTol && candles[i].close > ctx.majorDemand) {
        const alreadyAdded = events.some(e => e.label === 'demand_touch' && e.date === candles[i].date);
        if (!alreadyAdded) events.push(compact(candles[i], 'demand_touch_recent'));
        break;
      }
    }
  }
  if (ctx.majorSupply && ctx.majorSupply > 0) {
    const supplyTol = ctx.majorSupply * 0.015;
    for (let i = len - 1; i >= Math.max(0, len - 30); i--) {
      if (candles[i].high >= ctx.majorSupply - supplyTol && candles[i].close < ctx.majorSupply) {
        events.push(compact(candles[i], 'supply_rejection'));
        break;
      }
    }
  }

  // --- Breakout / fakeout / rejection candles (scan last 30 candles) ---
  const scanStart = Math.max(0, len - 30);
  for (let i = scanStart + 1; i < len; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const isGreen = c.close > c.open;
    const volRatio = vol20 > 0 ? c.volume / vol20 : 1;

    // Breakout candle: strong green + high volume + close near high
    if (isGreen && bodyRatio > 0.65 && volRatio >= 1.5 && (c.high - c.close) / range < 0.15) {
      events.push(compact(c, 'breakout_candle'));
    }

    // Fakeout / failed breakout: new high but close below prev close
    if (c.high > prev.high && c.close < prev.close && !isGreen && bodyRatio > 0.4) {
      events.push(compact(c, 'fakeout_candle'));
    }

    // Rejection candle: long upper wick, close in lower third
    if (upperWick > range * 0.5 && (c.close - c.low) / range < 0.35 && volRatio >= 1.0) {
      events.push(compact(c, 'rejection_candle'));
    }
  }

  // Deduplicate by date (keep first occurrence of each date)
  const seen = new Set();
  const deduped = [];
  for (const e of events) {
    const key = e.date + '|' + e.label;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
  }

  return deduped;
}



function buildDeterministicPayload(ticker, candles, opts) {
  const len = candles.length;
  const last = candles[len - 1];
  const prev = len >= 2 ? candles[len - 2] : null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const lastClose = last.close;
  const previousClose = prev ? prev.close : last.open;
  const priceChange1D = previousClose > 0 ? round2((lastClose - previousClose) / previousClose * 100) : 0;

  // Multi-window high/low
  const hl90 = sliceHighLow(candles, Math.min(90, len));
  const hl60 = sliceHighLow(candles, Math.min(60, len));
  const hl20 = sliceHighLow(candles, Math.min(20, len));
  const hl10 = sliceHighLow(candles, Math.min(10, len));
  const hl5 = sliceHighLow(candles, Math.min(5, len));

  // Volume averages
  const vol5 = round0(avgVolume(candles, 5));
  const vol20 = round0(avgVolume(candles, 20));
  const vol60 = round0(avgVolume(candles, Math.min(60, len)));
  const volLatest = last.volume;
  const volumeRatio = vol20 > 0 ? round2(volLatest / vol20) : 0;

  // Price changes
  const close5ago = len >= 6 ? candles[len - 6].close : lastClose;
  const close20ago = len >= 21 ? candles[len - 21].close : lastClose;
  const priceChange5D = close5ago > 0 ? round2((lastClose - close5ago) / close5ago * 100) : 0;
  const priceChange20D = close20ago > 0 ? round2((lastClose - close20ago) / close20ago * 100) : 0;

  // MA/EMA
  const ma20 = calcMA(closes, 20);
  const ma50 = calcMA(closes, Math.min(50, len));

  // RSI
  const rsi14 = calcRSI(closes, 14);

  // ATR14
  let atr14 = null;
  if (len >= 15) {
    let trSum = 0, trCount = 0;
    for (let i = len - 14; i < len; i++) {
      if (i < 1) continue;
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trSum += tr; trCount++;
    }
    if (trCount > 0) atr14 = round2(trSum / trCount);
  }


  // Use existing engine analysis for scoring/levels
  const analysis = engine.analyzeDayTrade(candles, ticker);
  const candleCtx = {
    volumeAvg20: vol20, support: analysis.support,
    resistance: analysis.resistance, ma20: ma20,
    rsi14: rsi14, changePct: priceChange1D, lastPrice: lastClose
  };
  const candleResult = candleEngine.detectPattern(candles.slice(-3), candleCtx);
  const scored = engine.scoreDayTrade(analysis, 'observe', 'UTAMA', candleResult);

  // Major demand/supply context
  let majorCtx = null;
  try { majorCtx = engine.detectMajorRespectZoneContext(candles, lastClose); } catch (e) {}

  // Volume profile PoC
  let volumeProfile = null;
  try { volumeProfile = engine.detectVolumeProfilePoc(candles, lastClose); } catch (e) {}

  // Fibonacci
  let fibResult = null;
  try { fibResult = fibEngine.evaluateFibConfluence(candles, { last_price: lastClose, entry_low: scored.entry_low, entry_high: scored.entry_high, support: analysis.support }); } catch (e) {}

  // Candle notes
  const candleNotes = [];
  if (candleResult && candleResult.pattern) {
    candleNotes.push(candleResult.pattern + ' (' + candleResult.bias + ')');
    if (candleResult.note) candleNotes.push(candleResult.note);
  }
  // Additional candle context
  const lastRange = last.high - last.low;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  if (lastRange > 0 && lowerWick > lastRange * 0.5) candleNotes.push('lower_wick_recovery');
  if (lastRange > 0 && upperWick > lastRange * 0.5) candleNotes.push('upper_wick_rejection');
  if (volumeRatio >= 1.5 && lastClose > last.open && priceChange1D > 2) candleNotes.push('breakout_candle');
  if (prev && last.high > prev.high && lastClose < prev.close) candleNotes.push('failed_breakout');
  if (lastRange > 0 && Math.abs(lastClose - last.open) / lastRange < 0.3 && volumeRatio < 0.8) candleNotes.push('consolidation');
  if (priceChange1D < -1.5 && volumeRatio < 1.0) candleNotes.push('pullback');
  if (volumeRatio >= 1.3 && lastClose > last.open) candleNotes.push('volume_confirmation');
  if (prev && Math.abs(last.open - prev.close) / previousClose > 0.02) candleNotes.push('gap_risk');


  // Stale data warning
  let staleWarning = null;
  const lastCandleDate = last.date || (last.time ? new Date(last.time * 1000).toISOString().slice(0, 10) : null);
  if (lastCandleDate) {
    const candleAge = (Date.now() - Date.parse(lastCandleDate + 'T00:00:00Z')) / (1000 * 60 * 60 * 24);
    if (candleAge > 3) staleWarning = 'Latest candle is ' + Math.round(candleAge) + ' days old. Data may be stale.';
  }

  const payload = {
    ticker,
    board: 'UTAMA',
    candle_count: len,
    last_close: round0(lastClose),
    previous_close: round0(previousClose),
    '90d_high': round0(hl90.high), '90d_low': round0(hl90.low),
    '60d_high': round0(hl60.high), '60d_low': round0(hl60.low),
    '20d_high': round0(hl20.high), '20d_low': round0(hl20.low),
    '10d_high': round0(hl10.high), '10d_low': round0(hl10.low),
    '5d_high': round0(hl5.high), '5d_low': round0(hl5.low),
    volume_latest: volLatest,
    avg_volume_5d: vol5, avg_volume_20d: vol20, avg_volume_60d: vol60,
    volume_ratio: volumeRatio,
    price_change_1d: priceChange1D,
    price_change_5d: priceChange5D,
    price_change_20d: priceChange20D,
    ma20: ma20 ? round0(ma20) : null,
    ma50: ma50 ? round0(ma50) : null,
    rsi14: rsi14 !== null ? round2(rsi14) : null,
    atr14: atr14,
    major_demand: majorCtx && majorCtx.major_demand_level ? majorCtx.major_demand_level : null,
    major_supply: majorCtx && majorCtx.major_supply_level ? majorCtx.major_supply_level : null,
    major_zone_notes: majorCtx && majorCtx.major_respect_zone_notes ? majorCtx.major_respect_zone_notes : null,
    volume_profile_poc: volumeProfile ? volumeProfile.volume_profile_poc : null,
    volume_profile_note: volumeProfile ? volumeProfile.note : null,
    fib_confluence: fibResult ? fibResult.fib_confluence_label : null,
    fib_levels: fibResult ? fibResult.fib_levels : null,
    daytrade_score: scored.daytrade_score || null,
    entry1: scored.entry_low || null,
    entry2: scored.entry_high || null,
    stop_loss: scored.stop_loss || null,
    tp1: scored.tp1 || null,
    tp2: scored.tp2 || null,
    risk_reward: scored.risk_reward || null,
    signal_action: scored.status || null,
    verdict: scored.notes || null,
    candle_notes: candleNotes,
    stale_data_warning: staleWarning
  };

  // Last 30 candles (compact) — gives AI recent price action context
  payload.last_30_candles = candles.slice(-Math.min(30, len)).map(c => ({
    date: c.date, open: round0(c.open), high: round0(c.high),
    low: round0(c.low), close: round0(c.close), volume: c.volume
  }));

  // 90D Notable Events — key candles that shaped the structure
  payload.notable_events_90d = extract90DNotableEvents(candles, {
    majorDemand: majorCtx && majorCtx.major_demand_level ? majorCtx.major_demand_level : null,
    majorSupply: majorCtx && majorCtx.major_supply_level ? majorCtx.major_supply_level : null,
    vol20
  });

  // Include full raw candles only if explicitly requested
  if (opts && opts.includeRawCandles) {
    payload.full_90d_candles = candles.map(c => ({
      date: c.date, open: round0(c.open), high: round0(c.high),
      low: round0(c.low), close: round0(c.close), volume: c.volume
    }));
  }

  return payload;
}


// ============================================================
// AI SYSTEM AND USER PROMPTS
// ============================================================

const SYSTEM_PROMPT = `You are an IDX stock technical research analyst. Your job is to explain technical context from the provided deterministic data. You are not allowed to invent prices, indicators, or events. You are not allowed to override deterministic safety gates. You must not give aggressive buy calls. Treat this as research, not financial advice. If data is stale, incomplete, or conflicting, clearly mark needs_revalidation. Return strict valid JSON only. No markdown. No extra prose outside JSON.`;

const USER_PROMPT_TEMPLATE = `Analyze this IDX ticker using the structured technical data below.

Important rules:
- Use only the provided data.
- Explain in detail, but stay structured.
- Separate deterministic facts from interpretation.
- If entry is risky, say so clearly.
- If setup is only watchlist, do not call it buy.
- If candle or volume confirmation is weak, say it needs confirmation.
- Mention demand/supply, trend, momentum, volume, candle behavior, invalidation, and watch conditions.
- Return strict JSON only.

Required JSON schema:
{
  "ticker": "string",
  "model": "string",
  "analysis_date": "YYYY-MM-DD",
  "data_quality": {
    "status": "fresh|stale|incomplete|unknown",
    "notes": ["string"]
  },
  "bias": "bullish|neutral|bearish|mixed",
  "setup_type": "breakout|pullback|reversal|continuation|consolidation|avoid|watchlist|unknown",
  "quality_score": 0-100,
  "risk_level": "Low|Medium|High|Very High",
  "executive_summary": "string",
  "technical_breakdown": {
    "trend_view": "string",
    "momentum_view": "string",
    "volume_view": "string",
    "candle_structure_view": "string",
    "demand_support_view": "string",
    "supply_resistance_view": "string",
    "entry_view": "string",
    "risk_reward_view": "string"
  },
  "key_levels": {
    "entry1": "number|null",
    "entry2": "number|null",
    "stop_loss": "number|null",
    "tp1": "number|null",
    "tp2": "number|null",
    "major_demand": "number|null",
    "major_supply": "number|null",
    "poc": "number|null"
  },
  "bullish_arguments": ["string"],
  "bearish_arguments": ["string"],
  "invalidations": ["string"],
  "watch_conditions": ["string"],
  "notable_risks": ["string"],
  "final_verdict": "string",
  "short_telegram_style_summary": "string",
  "not_financial_advice": true
}

Payload:
`;


// ============================================================
// AI API ADAPTER (OpenAI-compatible)
// ============================================================

function buildApiUrl(baseUrl) {
  if (!baseUrl) return '';
  let url = baseUrl.replace(/\/+$/, '');
  // If URL already ends with /chat/completions, use as-is
  if (url.endsWith('/chat/completions')) return url;
  // Otherwise append the path
  if (!url.endsWith('/v1')) url += '';
  return url + '/chat/completions';
}

async function callAI(modelName, payload, opts) {
  const url = buildApiUrl(opts.baseUrl);
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT_TEMPLATE + JSON.stringify(payload, null, 2) }
    ],
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    max_tokens: opts.maxOutputTokens || 2200
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': 'Bearer ' + opts.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error('AI API HTTP ' + res.status + ': ' + errText.slice(0, 200));
      err.statusCode = res.status;
      throw err;
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    const usage = data.usage || null;
    return { content, usage, raw: content ? content.slice(0, 500) : null };
  } finally {
    clearTimeout(timer);
  }
}

function parseAIResponse(content) {
  if (!content) return null;
  // Try direct JSON parse
  try { return JSON.parse(content); } catch (e) {}
  // Try extracting JSON from markdown code blocks
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1]); } catch (e) {} }
  // Try finding first { to last }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(content.slice(start, end + 1)); } catch (e) {} }
  return null;
}


// ============================================================
// STREAMING AI API ADAPTER (OpenAI-compatible SSE)
// Sends stream:true and collects delta.content chunks until [DONE].
// Compatible with NVIDIA endpoint (https://integrate.api.nvidia.com/v1)
// and any OpenAI-compatible streaming API.
// ============================================================

async function callAIStream(modelName, payload, opts) {
  const url = buildApiUrl(opts.baseUrl);
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT_TEMPLATE + JSON.stringify(payload, null, 2) }
    ],
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    max_tokens: opts.maxOutputTokens || 2200,
    stream: true
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': 'Bearer ' + opts.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error('AI API HTTP ' + res.status + ': ' + errText.slice(0, 200));
      err.statusCode = res.status;
      throw err;
    }
    const text = await res.text();
    return parseStreamChunks(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse SSE text from an OpenAI-compatible streaming response.
 * Each line is "data: {...}" or "data: [DONE]".
 * Returns { content, usage, raw }.
 */
function parseStreamChunks(sseText) {
  if (!sseText) return { content: null, usage: null, raw: null };
  const lines = sseText.split('\n');
  let content = '';
  let usage = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const chunk = JSON.parse(dataStr);
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) {
        content += delta.content;
      }
      if (chunk.usage) usage = chunk.usage;
    } catch (e) {
      // Skip unparseable lines
    }
  }
  return {
    content: content || null,
    usage,
    raw: content ? content.slice(0, 500) : null
  };
}


// ============================================================
// FAIL-FAST GUARD
// Tracks consecutive HTTP 402/403/502/504 errors per model.
// If a model hits FAIL_FAST_THRESHOLD consecutive fatal errors,
// it is stopped for the remainder of the run.
// ============================================================

const FAIL_FAST_THRESHOLD = 5;
const FAIL_FAST_CODES = new Set([402, 403, 502, 504]);

function createFailFastTracker() {
  const state = {};
  return {
    recordError(model, error) {
      if (!state[model]) state[model] = { consecutive: 0, stopped: false, reason: null };
      const statusCode = extractHttpStatus(error);
      if (statusCode && FAIL_FAST_CODES.has(statusCode)) {
        state[model].consecutive++;
        if (state[model].consecutive >= FAIL_FAST_THRESHOLD) {
          state[model].stopped = true;
          state[model].reason = 'fail-fast: ' + state[model].consecutive + ' consecutive HTTP ' + statusCode + ' errors';
          return true;
        }
      }
      return false;
    },
    recordSuccess(model) {
      if (!state[model]) state[model] = { consecutive: 0, stopped: false, reason: null };
      state[model].consecutive = 0;
    },
    isStopped(model) {
      return state[model] && state[model].stopped;
    },
    getStopReason(model) {
      return state[model] && state[model].reason;
    },
    getState() { return state; }
  };
}

function extractHttpStatus(error) {
  if (!error) return null;
  if (error.statusCode && typeof error.statusCode === 'number') return error.statusCode;
  const msg = error.message || String(error);
  const match = msg.match(/AI API HTTP (\d{3})/);
  if (match) return Number(match[1]);
  return null;
}


// ============================================================
// CHECKPOINT AND OUTPUT MANAGEMENT
// ============================================================

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getOutputDir(baseDir) {
  return path.resolve(baseDir, getDateStr());
}

async function loadCheckpoint(outputDir) {
  const cpPath = path.join(outputDir, 'checkpoint.json');
  try {
    const raw = await fsp.readFile(cpPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { completed: {} };
  }
}

async function saveCheckpoint(outputDir, checkpoint) {
  await fsp.mkdir(outputDir, { recursive: true });
  const cpPath = path.join(outputDir, 'checkpoint.json');
  await fsp.writeFile(cpPath, JSON.stringify(checkpoint, null, 2) + '\n');
}

function checkpointKey(ticker, model) {
  return ticker + '::' + model;
}

async function appendJSONL(outputDir, row) {
  await fsp.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, 'results.jsonl');
  await fsp.appendFile(filePath, JSON.stringify(row) + '\n');
}


// ============================================================
// SUMMARY WRITERS
// ============================================================

async function writeSummaryCSV(outputDir, results) {
  const headers = [
    'ticker', 'model', 'bias', 'setup_type', 'quality_score', 'risk_level',
    'final_verdict', 'entry1', 'entry2', 'stop_loss', 'tp1', 'tp2',
    'major_demand', 'major_supply', 'poc', 'data_quality_status', 'error'
  ];
  const lines = [headers.join(',')];
  for (const r of results) {
    const ai = r.ai_result || {};
    const kl = ai.key_levels || {};
    const dq = ai.data_quality || {};
    const row = [
      r.ticker, r.model,
      ai.bias || '', ai.setup_type || '', ai.quality_score || '',
      ai.risk_level || '', csvEscape(ai.final_verdict || ''),
      kl.entry1 || '', kl.entry2 || '', kl.stop_loss || '',
      kl.tp1 || '', kl.tp2 || '', kl.major_demand || '',
      kl.major_supply || '', kl.poc || '',
      dq.status || '', csvEscape(r.error || '')
    ];
    lines.push(row.join(','));
  }
  await fsp.writeFile(path.join(outputDir, 'summary.csv'), lines.join('\n') + '\n');
}

function csvEscape(str) {
  if (!str) return '';
  str = String(str);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}


async function writeSummaryMD(outputDir, results, report) {
  const lines = [];
  lines.push('# AI Research Summary - ' + getDateStr());
  lines.push('');
  lines.push('## Run Report');
  lines.push('- Total tickers: ' + report.total_tickers);
  lines.push('- Total models: ' + report.total_models);
  lines.push('- Total jobs: ' + report.total_jobs);
  lines.push('- Completed: ' + report.completed_jobs);
  lines.push('- Failed: ' + report.failed_jobs);
  lines.push('- Skipped: ' + report.skipped_jobs);
  lines.push('');

  // Best quality score
  const scored = results.filter(r => r.ai_result && r.ai_result.quality_score);
  scored.sort((a, b) => (b.ai_result.quality_score || 0) - (a.ai_result.quality_score || 0));
  lines.push('## Top Quality Scores');
  lines.push('');
  lines.push('| Ticker | Model | Score | Bias | Setup | Verdict |');
  lines.push('|--------|-------|-------|------|-------|---------|');
  for (const r of scored.slice(0, 20)) {
    const ai = r.ai_result;
    lines.push('| ' + r.ticker + ' | ' + r.model + ' | ' + ai.quality_score +
      ' | ' + ai.bias + ' | ' + ai.setup_type + ' | ' + (ai.final_verdict || '').slice(0, 60) + ' |');
  }
  lines.push('');

  // Bullish/watchlist candidates
  const bullish = results.filter(r => r.ai_result && (r.ai_result.bias === 'bullish' || r.ai_result.setup_type === 'watchlist'));
  lines.push('## Bullish / Watchlist Candidates (' + bullish.length + ')');
  lines.push('');
  for (const r of bullish.slice(0, 30)) {
    const ai = r.ai_result;
    lines.push('- **' + r.ticker + '** (' + r.model + '): ' + (ai.executive_summary || '').slice(0, 100));
  }
  lines.push('');

  // High-risk avoid
  const avoid = results.filter(r => r.ai_result && (r.ai_result.risk_level === 'Very High' || r.ai_result.setup_type === 'avoid'));
  lines.push('## High-Risk / Avoid (' + avoid.length + ')');
  lines.push('');
  for (const r of avoid.slice(0, 20)) {
    const ai = r.ai_result;
    lines.push('- **' + r.ticker + '** (' + r.model + '): ' + (ai.final_verdict || '').slice(0, 100));
  }
  lines.push('');

  // Per-model disagreement
  const byTicker = {};
  for (const r of results) {
    if (!r.ai_result || !r.ai_result.bias) continue;
    if (!byTicker[r.ticker]) byTicker[r.ticker] = {};
    byTicker[r.ticker][r.model] = r.ai_result.bias;
  }
  lines.push('## Model Disagreements');
  lines.push('');
  for (const [ticker, models] of Object.entries(byTicker)) {
    const biases = [...new Set(Object.values(models))];
    if (biases.length > 1) {
      const pairs = Object.entries(models).map(([m, b]) => m + ':' + b).join(', ');
      lines.push('- **' + ticker + '**: ' + pairs);
    }
  }
  lines.push('');

  // Failed jobs
  const failed = results.filter(r => r.error);
  if (failed.length > 0) {
    lines.push('## Failed Jobs (' + failed.length + ')');
    lines.push('');
    for (const r of failed.slice(0, 30)) {
      lines.push('- ' + r.ticker + ' / ' + r.model + ': ' + (r.error || '').slice(0, 100));
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*This is research only, not financial advice. Not a Telegram signal.*');

  await fsp.writeFile(path.join(outputDir, 'summary.md'), lines.join('\n') + '\n');
}


// ============================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================

async function withRetry(fn, opts) {
  const maxAttempts = opts.attempts || 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < maxAttempts - 1) {
        const delayMs = Math.min(1000 * Math.pow(2, i) + Math.random() * 500, 30000);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }


// ============================================================
// CONCURRENT JOB QUEUE (mapLimit)
// Runs up to `limit` async workers pulling from a shared queue.
// ============================================================

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runner() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(runner());
  }
  await Promise.all(workers);
  return results;
}


// ============================================================
// WRITE MUTEX — serializes appendJSONL and checkpoint writes
// so concurrent jobs don't interleave file I/O.
// ============================================================

function createWriteMutex() {
  let chain = Promise.resolve();
  return function serialize(fn) {
    chain = chain.then(fn, fn);
    return chain;
  };
}


// ============================================================
// MAIN RUNNER
// ============================================================

async function run(cliArgs) {
  const startedAt = new Date().toISOString();
  const args = cliArgs || parseArgs(process.argv);
  const cfg = getConfig();

  // Apply config defaults to args where not set
  if (args.concurrency == null) args.concurrency = cfg.AI_RESEARCH_CONCURRENCY;
  if (args.maxOutputTokens == null) args.maxOutputTokens = cfg.AI_RESEARCH_MAX_OUTPUT_TOKENS;
  if (args.temperature == null) args.temperature = cfg.AI_RESEARCH_TEMPERATURE;

  // Validate env
  if (!args.dryRun) {
    if (!cfg.SHITERU_BASE_URL) {
      console.error('ERROR: SHITERU_BASE_URL is not set.');
      process.exitCode = 1; return { error: 'SHITERU_BASE_URL missing' };
    }
    if (!cfg.SHITERU_API_KEY) {
      console.error('ERROR: SHITERU_API_KEY is not set.');
      process.exitCode = 1; return { error: 'SHITERU_API_KEY missing' };
    }
  }

  // Determine models
  const models = args.models
    ? args.models.split(',').map(s => s.trim()).filter(Boolean)
    : cfg.AI_RESEARCH_MODELS;

  // Load tickers
  const tickers = await loadTickers(args);
  if (tickers.length === 0) {
    console.error('ERROR: No tickers loaded. Use --tickers-file or --tickers.');
    process.exitCode = 1; return { error: 'No tickers' };
  }

  const outputDir = getOutputDir(cfg.AI_RESEARCH_OUTPUT_DIR);
  await fsp.mkdir(outputDir, { recursive: true });

  // Load checkpoint
  const checkpoint = args.force ? { completed: {} } : await loadCheckpoint(outputDir);
  const concurrency = Math.max(1, args.concurrency || 1);

  console.log('=== One-Time AI Research Runner ===');
  console.log('Tickers: ' + tickers.length);
  console.log('Models: ' + models.join(', '));
  console.log('Total jobs: ' + (tickers.length * models.length));
  console.log('Concurrency: ' + concurrency);
  console.log('Output: ' + outputDir);
  console.log('Dry run: ' + (args.dryRun ? 'YES' : 'no'));
  console.log('Force: ' + (args.force ? 'YES' : 'no'));
  console.log('Include raw candles: ' + (args.includeRawCandles ? 'YES' : 'no'));
  console.log('Stream AI: ' + (args.streamAi ? 'YES' : 'no'));
  console.log('');

  const allResults = [];
  let completedJobs = 0;
  let failedJobs = 0;
  let skippedJobs = 0;
  const perModelStats = {};
  for (const m of models) perModelStats[m] = { success: 0, fail: 0 };
  let estimatedTokens = 0;
  const failFast = createFailFastTracker();
  const writeMutex = createWriteMutex();

  // Cache candles per ticker to avoid refetching in concurrent jobs
  const candleCache = new Map();

  // --- Build flat job queue: all ticker × model combinations ---
  const jobQueue = [];
  for (const ticker of tickers) {
    for (const model of models) {
      jobQueue.push({ ticker, model });
    }
  }
  const totalJobs = jobQueue.length;

  // --- Process all jobs concurrently up to --concurrency ---
  await mapLimit(jobQueue, concurrency, async (job, jobIdx) => {
    const { ticker, model } = job;
    const cpKey = checkpointKey(ticker, model);

    // Fail-fast: skip model if stopped
    if (failFast.isStopped(model)) {
      skippedJobs++;
      return;
    }

    // Skip if already completed (checkpoint)
    if (checkpoint.completed[cpKey] && !args.force) {
      console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] SKIP (checkpoint): ' + ticker + '/' + model);
      skippedJobs++;
      return;
    }

    // Fetch/cache candles (serialized per ticker to avoid duplicate fetches)
    if (!candleCache.has(ticker)) {
      const candles = await getCandles(ticker, path.resolve(cfg.DAYTRADE_CACHE_DIR));
      candleCache.set(ticker, candles);
    }
    const candles = candleCache.get(ticker);

    if (!candles || candles.length < 20) {
      const row = { ticker, model, deterministic_summary: null, ai_result: null, raw_response_preview: null, usage: null, error: 'insufficient_candle_data', started_at: new Date().toISOString(), ended_at: new Date().toISOString() };
      await writeMutex(() => appendJSONL(outputDir, row));
      allResults.push(row);
      failedJobs++;
      perModelStats[model].fail++;
      return;
    }

    // Build deterministic payload
    const payload = buildDeterministicPayload(ticker, candles, { includeRawCandles: args.includeRawCandles });
    const jobStarted = new Date().toISOString();

    if (args.dryRun) {
      const row = {
        ticker, model, deterministic_summary: payload, ai_result: null,
        raw_response_preview: '[DRY RUN - no API call]',
        usage: null, error: null,
        started_at: jobStarted, ended_at: new Date().toISOString()
      };
      await writeMutex(() => appendJSONL(outputDir, row));
      allResults.push(row);
      completedJobs++;
      perModelStats[model].success++;
      console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] DRY RUN: ' + ticker + '/' + model);
      return;
    }

    // Call AI with retry (choose streaming or non-streaming)
    const aiCallFn = args.streamAi ? callAIStream : callAI;
    try {
      const response = await withRetry(() => aiCallFn(model, payload, {
        baseUrl: cfg.SHITERU_BASE_URL,
        apiKey: cfg.SHITERU_API_KEY,
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
        timeoutMs: cfg.AI_RESEARCH_TIMEOUT_MS
      }), { attempts: 3 });

      const parsed = parseAIResponse(response.content);
      const row = {
        ticker, model, deterministic_summary: payload,
        ai_result: parsed,
        raw_response_preview: response.raw || (response.content || '').slice(0, 500),
        usage: response.usage, error: parsed ? null : 'parse_failed',
        started_at: jobStarted, ended_at: new Date().toISOString()
      };
      await writeMutex(async () => {
        await appendJSONL(outputDir, row);
        if (parsed) {
          checkpoint.completed[cpKey] = true;
          await saveCheckpoint(outputDir, checkpoint);
        }
      });
      allResults.push(row);

      if (parsed) {
        completedJobs++;
        perModelStats[model].success++;
        failFast.recordSuccess(model);
        console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] OK: ' + ticker + '/' + model + ' score=' + (parsed.quality_score || '?'));
      } else {
        failedJobs++;
        perModelStats[model].fail++;
        console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] WARN: ' + ticker + '/' + model + ' - not parseable');
      }

      if (response.usage) {
        estimatedTokens += (response.usage.total_tokens || response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0);
      }
    } catch (e) {
      const errMsg = (e.message || 'unknown').slice(0, 200);
      const row = {
        ticker, model, deterministic_summary: payload, ai_result: null,
        raw_response_preview: null, usage: null, error: errMsg,
        started_at: jobStarted, ended_at: new Date().toISOString()
      };
      await writeMutex(() => appendJSONL(outputDir, row));
      allResults.push(row);
      failedJobs++;
      perModelStats[model].fail++;

      const stopped = failFast.recordError(model, e);
      if (stopped) {
        console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] FAIL-FAST: ' + model + ' stopped — ' + failFast.getStopReason(model));
      } else {
        console.log('[' + (jobIdx + 1) + '/' + totalJobs + '] ERROR: ' + ticker + '/' + model + ' - ' + errMsg);
      }
    }
  });


  // Build run report
  const endedAt = new Date().toISOString();
  const report = {
    version: VERSION,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Date.now() - Date.parse(startedAt),
    total_tickers: tickers.length,
    total_models: models.length,
    total_jobs: tickers.length * models.length,
    completed_jobs: completedJobs,
    failed_jobs: failedJobs,
    skipped_jobs: skippedJobs,
    output_dir: outputDir,
    models_used: models,
    estimated_token_usage: estimatedTokens || null,
    per_model_stats: perModelStats,
    fail_fast_stopped: failFast.getState(),
    dry_run: args.dryRun || false
  };

  // Write report
  await fsp.writeFile(path.join(outputDir, 'run-report.json'), JSON.stringify(report, null, 2) + '\n');

  // Write summary CSV and MD (only from non-error results)
  const validResults = allResults.filter(r => r.ai_result || r.error);
  await writeSummaryCSV(outputDir, validResults);
  await writeSummaryMD(outputDir, validResults, report);

  console.log('');
  console.log('=== Run Complete ===');
  console.log('Completed: ' + completedJobs + ' | Failed: ' + failedJobs + ' | Skipped: ' + skippedJobs);
  console.log('Output: ' + outputDir);
  console.log('Duration: ' + (report.duration_ms / 1000).toFixed(1) + 's');
  if (estimatedTokens) console.log('Estimated tokens: ' + estimatedTokens);

  return report;
}


// ============================================================
// ENTRY POINT
// ============================================================

if (require.main === module) {
  run().catch(e => {
    console.error('FATAL:', e.stack || e.message);
    process.exitCode = 1;
  });
}

// ============================================================
// EXPORTS (for testing)
// ============================================================

module.exports = {
  VERSION,
  parseArgs,
  parseTickers,
  loadTickers,
  buildDeterministicPayload,
  extract90DNotableEvents,
  buildApiUrl,
  callAI,
  callAIStream,
  parseAIResponse,
  parseStreamChunks,
  createFailFastTracker,
  extractHttpStatus,
  FAIL_FAST_THRESHOLD,
  FAIL_FAST_CODES,
  mapLimit,
  createWriteMutex,
  getOutputDir,
  loadCheckpoint,
  saveCheckpoint,
  checkpointKey,
  appendJSONL,
  writeSummaryCSV,
  writeSummaryMD,
  normalizeCandles,
  readCacheFile,
  writeCacheFile,
  getCandles,
  fetchCandlesYahoo,
  run,
  SYSTEM_PROMPT,
  USER_PROMPT_TEMPLATE
};
