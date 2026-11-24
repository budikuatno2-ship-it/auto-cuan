'use strict';

/**
 * ZERO_QUOTA Intraday Top 20 Monitor (V6.5).
 * Reads active Top 20 picks from data/three-horizon-latest.json (or fallback
 * data/screener-latest.json), checks live Yahoo prices during IDX trading hours
 * (concurrency <= 4, 0 Arjum quota), and updates `intraday_status` atomically.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const marketHours = require('../lib/market-hours-guard');
const idxTick = require('../lib/idx-tick');

const ROOT = path.resolve(__dirname, '..');
const THREE_HORIZON_PATH = path.join(ROOT, 'data', 'three-horizon-latest.json');
const SCREENER_PATH = path.join(ROOT, 'data', 'screener-latest.json');
const INTRADAY_OUT_PATH = path.join(ROOT, 'data', 'intraday-top20-status.json');
const HEARTBEAT_PATH = path.join(ROOT, 'data', 'job-heartbeat', 'intraday-top20-monitor.json');

function atomicWriteJson(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
}

function collectTopTickers(threeHorizonDoc, screenerDoc) {
  const map = new Map();
  const ingestList = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const t = String(r && (r.ticker || r.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!t || map.has(t)) continue;
      map.set(t, {
        ticker: t,
        entry_min: Number(r.entry_min || r.entryMin || r.close || 0) || null,
        entry_max: Number(r.entry_max || r.entryMax || r.close || 0) || null,
        stop_loss: Number(r.stop_loss || r.stopLoss || 0) || null,
        tp1: Number(r.tp1 || r.target_1 || 0) || null
      });
    }
  };
  if (threeHorizonDoc && threeHorizonDoc.horizons) {
    for (const key of ['potensi_besok', 'short_swing', 'swing']) {
      ingestList(threeHorizonDoc.horizons[key] && threeHorizonDoc.horizons[key].picks);
    }
  }
  if (screenerDoc && Array.isArray(screenerDoc.picks)) ingestList(screenerDoc.picks);
  return Array.from(map.values()).slice(0, 20);
}

function classifyZoneStatus(price, row) {
  if (!Number.isFinite(price) || price <= 0) return 'UNKNOWN';
  if (row.stop_loss && price <= row.stop_loss) return 'BELOW_SL';
  if (row.tp1 && price >= row.tp1) return 'TARGET_HIT';
  if (row.entry_min && row.entry_max && price >= row.entry_min && price <= row.entry_max) return 'ENTRY_ZONE_ACTIVE';
  if (row.entry_max && price > row.entry_max) return 'ABOVE_ENTRY';
  return 'WATCHING';
}

async function fetchYahooIntradayPrice(ticker, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker + '.JK') + '?range=1d&interval=5m';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: 'HTTP_' + res.status };
    const json = await res.json();
    const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
    const price = Number(meta && meta.regularMarketPrice);
    const prev = Number(meta && (meta.chartPreviousClose || meta.previousClose));
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'NO_PRICE' };
    const rounded = idxTick.roundToIdxTick ? idxTick.roundToIdxTick(price) : Math.round(price);
    const chgPct = Number.isFinite(prev) && prev > 0 ? Number((((rounded - prev) / prev) * 100).toFixed(2)) : null;
    return { ok: true, price: rounded, prevClose: prev || null, change_pct: chgPct };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err && err.message ? err.message : 'FETCH_ERR' };
  }
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function writeHeartbeat(outcome, detail) {
  try {
    atomicWriteJson(HEARTBEAT_PATH, {
      jobName: 'intraday-top20-monitor',
      updatedAt: new Date().toISOString(),
      exitCode: outcome === 'FAILED' ? 1 : 0,
      outcome,
      status: outcome === 'SUCCESS' ? 'OK' : outcome,
      detail: String(detail || '')
    });
  } catch (_) {}
}

async function main(argv = process.argv.slice(2), opts = {}) {
  const force = argv.includes('--force') || opts.force === true;
  const dryRun = argv.includes('--dry-run') || opts.dryRun === true;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const isOpen = marketHours.isMarketOpen(now);

  if (!isOpen && !force && !dryRun) {
    const out = { ok: true, skipped: true, reason: 'MARKET_CLOSED', updated_at: now.toISOString(), monitored: 0 };
    writeHeartbeat('SKIPPED', 'MARKET_CLOSED');
    console.log(JSON.stringify(out));
    return out;
  }

  const threeHorizonPath = opts.threeHorizonPath || THREE_HORIZON_PATH;
  const screenerPath = opts.screenerPath || SCREENER_PATH;
  const threeDoc = readJsonSafe(threeHorizonPath);
  const screenerDoc = readJsonSafe(screenerPath);
  const targets = collectTopTickers(threeDoc, screenerDoc);

  if (dryRun || targets.length === 0) {
    const out = {
      ok: true,
      dryRun,
      marketOpen: isOpen,
      monitored: targets.length,
      tickers: targets.map((t) => t.ticker),
      arjumQuotaUsed: 0
    };
    console.log(JSON.stringify(out));
    return out;
  }

  const wibStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(now) + ' WIB';

  const statusByTicker = {};
  const fetchQuote = opts.fetchQuote || fetchYahooIntradayPrice;
  await runPool(targets, 4, async (row) => {
    const q = await fetchQuote(row.ticker);
    if (q && q.ok) {
      statusByTicker[row.ticker] = {
        last_price: q.price,
        change_pct: q.change_pct,
        zone_status: classifyZoneStatus(q.price, row),
        updated_at_wib: wibStr,
        source: 'yahoo_intraday_zero_quota'
      };
    }
  });

  if (threeDoc && threeDoc.horizons) {
    for (const hKey of ['potensi_besok', 'short_swing', 'swing']) {
      const picks = threeDoc.horizons[hKey] && threeDoc.horizons[hKey].picks;
      if (!Array.isArray(picks)) continue;
      for (const p of picks) {
        const t = String(p && p.ticker || '').toUpperCase();
        if (statusByTicker[t]) p.intraday_status = statusByTicker[t];
      }
    }
    threeDoc.intraday_updated_at = now.toISOString();
    atomicWriteJson(threeHorizonPath, threeDoc);
  }

  const outPayload = {
    ok: true,
    updated_at: now.toISOString(),
    updated_at_wib: wibStr,
    arjumQuotaUsed: 0,
    count: Object.keys(statusByTicker).length,
    statuses: statusByTicker
  };
  atomicWriteJson(opts.outPath || INTRADAY_OUT_PATH, outPayload);
  writeHeartbeat('SUCCESS', 'monitored=' + outPayload.count);
  console.log(JSON.stringify(outPayload));
  return outPayload;
}

if (require.main === module) {
  main().catch((err) => {
    writeHeartbeat('FAILED', err && err.message ? err.message : String(err));
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}

module.exports = { main, collectTopTickers, classifyZoneStatus };
