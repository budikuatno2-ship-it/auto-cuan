#!/usr/bin/env node
'use strict';

/**
 * tools/prewarm-daily-cache.js
 * ============================================================================
 * Zero-quota pre-warm cache builder for Auto-Cuan V6.5.2.
 * Scheduled at 02:30 WIB (cron: 30 2 * * * with nice -n 19 ionice -c 3) and
 * also safe to trigger manually on deploy without touching paid Stock Arjum quota.
 *
 * Outputs computed/indexed JSON artifacts into data/cache/:
 *   - ownership-names-map.json
 *   - pattern-radar.json
 *   - struktur-pasar-summary.json
 *   - screener-3horizon-warm.json
 *   - top5-radar-warm.json
 *   - sector-hot-summary.json
 *   - insider-summary.json
 *   - ctrlk-search-index.json
 *   - financial-snapshots/<TICKER>.json (top liquid universe)
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const HEARTBEAT_FILE = path.join(ROOT, 'data', 'job-heartbeat', 'prewarm-cache.json');

const TOP_LIQUID_TICKERS = [
  'IHSG', 'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII', 'BRPT', 'BREN',
  'AMMN', 'ADRO', 'MEDC', 'ANTM', 'ICBP', 'INDF', 'GOTO', 'KLBF', 'UNVR',
  'PGAS', 'PTBA', 'CPIN', 'MDKA', 'INCO', 'ITMG', 'TPIA', 'BRIS', 'PWON',
  'MIDI', 'BBHI', 'HRUM', 'AKRA', 'JPFA', 'MAPI', 'CTRA', 'BSDE', 'SMGR'
];

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function resolveDbPath() {
  const candidates = [
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    path.join(ROOT, 'data', 'market.sqlite')
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

function resolveDbSig(dbPath) {
  if (!dbPath) return null;
  try {
    const st = fs.statSync(dbPath);
    return `${dbPath}|${st.size}|${Math.floor(st.mtimeMs)}`;
  } catch (_) { return null; }
}

function buildOwnershipNamesMap() {
  const out = {};
  try {
    const csvPath = path.join(ROOT, 'public', 'assets', 'idx-tickers.csv');
    if (fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = /^([A-Z0-9]{3,6}),\s*"?([^"\r\n]+)"?\s*$/.exec(line.trim());
        if (m && m[1] && m[2] && m[2].toUpperCase() !== 'NAME') {
          out[m[1]] = m[2].trim();
        }
      }
    }
  } catch (_) {}

  try {
    const kseiStore = require('../lib/ksei-ownership-store');
    const loaded = kseiStore.loadActiveOwnership(ROOT);
    const list = Array.isArray(loaded.items) ? loaded.items : [];
    for (const item of list) {
      if (item && item.ticker && item.name) {
        out[String(item.ticker).trim().toUpperCase()] = String(item.name).trim();
      }
    }
  } catch (_) {}

  atomicWriteJson(path.join(CACHE_DIR, 'ownership-names-map.json'), out);
  return { count: Object.keys(out).length, namesMap: out };
}

function buildPatternRadarCache(dbSig) {
  const patternRadar = require('../api/pattern-radar');
  const result = patternRadar.scanAllPatterns();
  const doc = Object.assign({}, result, {
    db_sig: dbSig,
    cached_at: new Date().toISOString()
  });
  atomicWriteJson(path.join(CACHE_DIR, 'pattern-radar.json'), doc);
  return { count: doc.count || 0, total_scanned: doc.total_scanned || 0 };
}

function buildStrukturPasarCache() {
  const strukturPasar = require('../api/struktur-pasar');
  if (typeof strukturPasar.invalidateCache === 'function') strukturPasar.invalidateCache();
  const built = strukturPasar.buildStrukturPasarData();
  const full = built && built.data ? built.data : {};
  const summary = {
    success: true,
    count: full.count || 0,
    as_of: full.as_of || null,
    source: full.source || 'KSEI',
    cached_at: new Date().toISOString(),
    preview_tickers: Array.isArray(full.universe) ? full.universe.slice(0, 20).map((u) => u.ticker) : []
  };
  atomicWriteJson(path.join(CACHE_DIR, 'struktur-pasar-summary.json'), summary);
  return { count: summary.count, as_of: summary.as_of };
}

function buildScreenerAndTop5Cache() {
  const regen = require('./regenerate-local-snapshots');
  const threeHorizonPath = path.join(ROOT, 'data', 'three-horizon-latest.json');
  let regenerateMeta = null;
  if (!fs.existsSync(threeHorizonPath)) {
    regenerateMeta = regen.run({});
  }
  const threeHorizon = JSON.parse(fs.readFileSync(threeHorizonPath, 'utf8'));
  const top5RadarPath = path.join(ROOT, 'data', 'top5-radar.json');
  const top5Radar = fs.existsSync(top5RadarPath) ? JSON.parse(fs.readFileSync(top5RadarPath, 'utf8')) : {};
  const sectorHotPath = path.join(ROOT, 'data', 'sector-hot-latest.json');
  const sectorHot = fs.existsSync(sectorHotPath) ? JSON.parse(fs.readFileSync(sectorHotPath, 'utf8')) : {};

  atomicWriteJson(path.join(CACHE_DIR, 'screener-3horizon-warm.json'), {
    cached_at: new Date().toISOString(),
    trade_date: threeHorizon.trade_date || null,
    horizons: threeHorizon.horizons || {},
    regenerated: Boolean(regenerateMeta)
  });
  atomicWriteJson(path.join(CACHE_DIR, 'top5-radar-warm.json'), {
    cached_at: new Date().toISOString(),
    trade_date: top5Radar.trade_date || threeHorizon.trade_date || null,
    top5: top5Radar.top5 || threeHorizon.top5 || [],
    top5_by_horizon: top5Radar.top5_by_horizon || {}
  });
  atomicWriteJson(path.join(CACHE_DIR, 'sector-hot-summary.json'), {
    cached_at: new Date().toISOString(),
    trade_date: sectorHot.trade_date || null,
    groups_count: Array.isArray(sectorHot.groups) ? sectorHot.groups.length : 0
  });
  return {
    trade_date: threeHorizon.trade_date || null,
    groups: Array.isArray(sectorHot.groups) ? sectorHot.groups.length : 0
  };
}

function buildInsiderSummaryCache(dbPath) {
  let totalInsiders = 0;
  let uniqueTickers = 0;
  const sampleTickers = [];
  if (dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true });
    try {
      const c = db.prepare("SELECT COUNT(*) AS n FROM market_rows WHERE table_name='arjum_insiders'").get();
      totalInsiders = Number((c && c.n) || 0);
      const rows = db.prepare("SELECT DISTINCT substr(row_key, 1, 4) AS tk FROM market_rows WHERE table_name='arjum_insiders' LIMIT 50").all();
      uniqueTickers = rows.length;
      for (const r of rows.slice(0, 15)) if (r.tk) sampleTickers.push(r.tk);
    } finally {
      try { db.close(); } catch (_) {}
    }
  }
  const summary = {
    cached_at: new Date().toISOString(),
    total_rows: totalInsiders,
    sample_tickers: sampleTickers
  };
  atomicWriteJson(path.join(CACHE_DIR, 'insider-summary.json'), summary);
  return { total_rows: totalInsiders, unique_sample: uniqueTickers };
}

function buildCtrlKIndex(namesMap) {
  const items = Object.entries(namesMap || {}).map(([ticker, name]) => ({
    ticker,
    name,
    q: `${ticker} ${name}`.toLowerCase()
  })).sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (!namesMap.IHSG) {
    items.unshift({ ticker: 'IHSG', name: 'Indeks Harga Saham Gabungan (IDX Composite)', q: 'ihsg jkse indeks harga saham gabungan idx composite' });
  }
  atomicWriteJson(path.join(CACHE_DIR, 'ctrlk-search-index.json'), {
    cached_at: new Date().toISOString(),
    count: items.length,
    items
  });
  return { count: items.length };
}

function buildForeignFlowMultiDayCache(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return { tickers: 0, as_of: null };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true });
  try {
    try { db.exec('PRAGMA busy_timeout=10000;'); } catch (_) {}
    const byTicker = new Map();
    let maxDate = '';
    const histStmt = db.prepare("SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_history'");
    const latestPrice = new Map();
    for (const r of histStmt.iterate()) {
      try {
        const j = JSON.parse(r.row_json);
        const tk = String(j.ticker || String(r.row_key || '').split('\x1f')[0] || '').trim().toUpperCase();
        const dt = String(j.trade_date || j.date || '').slice(0, 10);
        if (!/^[A-Z]{4}$/.test(tk) || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
        if (dt > maxDate) maxDate = dt;
        const prev = latestPrice.get(tk);
        if (!prev || dt > prev.dt) {
          latestPrice.set(tk, { dt, close: Number(j.close) || null, volume: Number(j.volume) || null });
        }
      } catch (_) {}
    }

    const fStmt = db.prepare("SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_broker_summary_foreign'");
    let maxForeignDate = '';
    for (const r of fStmt.iterate()) {
      try {
        const j = JSON.parse(r.row_json);
        const parts = String(r.row_key || '').split(/[\x1f\s]+/);
        const tk = String(j.ticker || j.stock_code || (j._fetch_meta && j._fetch_meta.ticker) || parts[0] || '').trim().toUpperCase();
        const dt = String(j.broker_start_date || j.broker_end_date || j.trade_date || j.date || (j._fetch_meta && j._fetch_meta.trade_date) || parts[1] || '').slice(0, 10);
        if (!/^[A-Z]{4}$/.test(tk) || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
        if (dt > maxForeignDate) maxForeignDate = dt;
        let net = null;
        if (Array.isArray(j.brokers) && j.brokers.length > 0) {
          net = j.brokers.reduce((s, b) => s + Number((b && (b.nval ?? b.net_val ?? ((Number(b.bval) || 0) - (Number(b.sval) || 0)))) || 0), 0);
        } else if (j.net_val != null || j.net_value != null || j.foreign_net != null || j.net_buy != null) {
          net = Number(j.net_val ?? j.net_value ?? j.foreign_net ?? j.net_buy);
        }
        if (net == null || !Number.isFinite(net)) continue;
        if (!byTicker.has(tk)) byTicker.set(tk, []);
        byTicker.get(tk).push({ dt, net });
      } catch (_) {}
    }

    const data = {};
    for (const [tk, list] of byTicker.entries()) {
      list.sort((a, b) => b.dt.localeCompare(a.dt));
      const fToday = list.length ? Math.round(list[0].net) : null;
      const f3d = list.slice(0, 3).reduce((s, x) => s + x.net, 0);
      const f7d = list.slice(0, 7).reduce((s, x) => s + x.net, 0);
      const lp = latestPrice.get(tk);
      data[tk] = {
        last_price: lp ? lp.close : null,
        volume_today: lp ? lp.volume : null,
        foreign_net_today: fToday,
        foreign_net_3d: Math.round(f3d),
        foreign_net_7d: Math.round(f7d),
        as_of: (list[0] && list[0].dt) || maxForeignDate || maxDate
      };
    }
    const asOf = maxForeignDate || maxDate || null;
    atomicWriteJson(path.join(ROOT, 'data', 'foreign-flow-multi-day.json'), {
      as_of: asOf,
      generated_at: new Date().toISOString(),
      source: 'sqlite_arjum_broker_summary_foreign',
      count: Object.keys(data).length,
      data
    });
    return { tickers: Object.keys(data).length, as_of: asOf };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function prewarmFinancialSnapshots(dbPath) {
  if (!dbPath) return { warmed: 0 };
  const { getVpsMarketStore } = require('../lib/vps-market-store');
  const { buildFinancialSnapshot } = require('../lib/financial-snapshot');
  const db = getVpsMarketStore(dbPath);
  const outDir = path.join(CACHE_DIR, 'financial-snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  let warmed = 0;
  for (const ticker of TOP_LIQUID_TICKERS) {
    if (ticker === 'IHSG') continue;
    try {
      const snap = await buildFinancialSnapshot(db, ticker);
      if (snap) {
        atomicWriteJson(path.join(outDir, `${ticker}.json`), {
          success: true,
          cached_at: new Date().toISOString(),
          snapshot: snap
        });
        warmed++;
      }
    } catch (_) {}
  }
  return { warmed };
}

function writeHeartbeat(payload) {
  atomicWriteJson(HEARTBEAT_FILE, Object.assign({
    jobName: 'prewarm-cache',
    outcome: 'SUCCESS',
    status: 'OK',
    exitCode: 0,
    requestsUsed: 0
  }, payload));
}

async function main() {
  const startedAt = Date.now();
  const startIso = new Date().toISOString();
  const dbPath = resolveDbPath();
  const dbSig = resolveDbSig(dbPath);

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const fsRes = (() => {
    try {
      const { syncQuotaState } = require('./sync-quota-state');
      return syncQuotaState();
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  })();

  const namesRes = buildOwnershipNamesMap();
  const ffRes = buildForeignFlowMultiDayCache(dbPath);
  const patternRes = buildPatternRadarCache(dbSig);
  const strukturRes = buildStrukturPasarCache();
  const screenerRes = buildScreenerAndTop5Cache();
  const insiderRes = buildInsiderSummaryCache(dbPath);
  const ctrlKRes = buildCtrlKIndex(namesRes.namesMap);
  const finRes = await prewarmFinancialSnapshots(dbPath);

  const durationMs = Date.now() - startedAt;
  const result = {
    ok: true,
    durationMs,
    dbPath,
    paid_arjum_requests: 0,
    quota_sync: fsRes,
    names: namesRes.count,
    foreign_flow: ffRes,
    pattern_radar: patternRes,
    struktur_pasar: strukturRes,
    screener_top5: screenerRes,
    insider: insiderRes,
    ctrlk: ctrlKRes,
    financial: finRes
  };

  writeHeartbeat({
    lastStartWIB: startIso,
    lastEndWIB: new Date().toISOString(),
    durationMs,
    summary: result
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    try {
      writeHeartbeat({
        outcome: 'FAILED',
        status: 'ERROR',
        exitCode: 1,
        lastErrorSnippet: String(err && err.message || err).slice(0, 200)
      });
    } catch (_) {}
    console.error('[prewarm-daily-cache] fatal:', err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { main, CACHE_DIR, TOP_LIQUID_TICKERS };
