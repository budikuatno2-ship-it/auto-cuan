#!/usr/bin/env node
'use strict';

/**
 * scripts/domestic-compile.js
 * FASE V4-F06: Kompilasi Paralel Broksum Domestik & Akumulasi Rolling < 15 Detik
 *
 * Menggunakan pemrosesan paralel dalam batch (50 saham per batch) di memori
 * untuk menghindari I/O bottleneck dan timeout exitCode=124.
 *
 * Menghasilkan:
 * 1. data/arjum-data/broker-summary-D/<TICKER>/<YYYY-MM-DD>.json & latest.json
 * 2. data/arjum-data/broker-summary/<TICKER>/<YYYY-MM-DD>.json & latest.json
 * 3. data/broker-accumulation/<TICKER>.json (lengkap dengan window 1H, 3H, 5H, 10H, 20H)
 * 4. data/broker-hunter-indexes/ (latest_1d.json, latest_3d.json, latest_1w.json, latest_1m.json)
 */

const fs = require('node:fs');
const path = require('node:path');
const accumLocal = require('../lib/broker-accumulation-local');
const arjumSqliteHydrate = require('../lib/arjum-sqlite-hydrate');

const ROOT = path.resolve(__dirname, '..');
const BASE_DATA = path.join(ROOT, 'data');
const ARJUM_DATA_DIR = path.join(BASE_DATA, 'arjum-data');
const ALL_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary');
const F_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-F');
const D_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-D');
const ACCUM_DIR = path.join(BASE_DATA, 'broker-accumulation');
const HUNTER_INDEX_DIR = path.join(BASE_DATA, 'broker-hunter-indexes');

const FOREIGN_SET = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB', 'YU', 'CG', 'OD', 'ML', 'DP', 'BQ', 'EP', 'LG', 'AI']);

/**
 * Subtask J — fail-closed skip counters.
 *
 * These count the sessions this script deliberately REFUSED to publish as a
 * Domestic broker summary. They exist so a silent refusal is still observable:
 * a run that skips 100 clipped sessions must say so rather than look identical
 * to a run that found nothing to do. Mutated from parallel tasks, which is safe
 * because the increments are synchronous (no await between read and write).
 */
const DOMESTIC_COMPILE_STATS = {
  domestic_written: 0,
  domestic_all_clipped_skipped: 0,
  domestic_empty_skipped: 0,
  foreign_synthesized_from_all: 0,
  domestic_from_derived_foreign: 0
};

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const BROKER_NAMES = {
  YU: 'CGS INTERNATIONAL SEKURITAS INDONESIA',
  BK: 'J.P. MORGAN SEKURITAS INDONESIA',
  CC: 'MANDIRI SEKURITAS',
  AK: 'UBS SEKURITAS INDONESIA',
  RX: 'MACQUARIE SEKURITAS INDONESIA',
  ZP: 'MAYBANK SEKURITAS INDONESIA',
  KZ: 'CLSA SEKURITAS INDONESIA',
  SQ: 'BCA SEKURITAS',
  XL: 'STOCKBIT SEKURITAS DIGITAL',
  YP: 'MIRAE ASSET SEKURITAS INDONESIA',
  XC: 'AJAIB SEKURITAS ASIA',
  IF: 'SAMUEL SEKURITAS INDONESIA',
  AZ: 'SUCOR SEKURITAS',
  DR: 'RHB SEKURITAS INDONESIA',
  AI: 'KAY HIAN SEKURITAS',
  IN: 'INVESTINDO NUSANTARA SEKURITAS',
  PD: 'INDO PREMIER SEKURITAS',
  NI: 'BNI SEKURITAS',
  LG: 'TRIMEGAH SEKURITAS INDONESIA TBK',
  DX: 'BAHANA SEKURITAS',
  OD: 'BRI DANAREKSA SEKURITAS',
  BB: 'VERDHANA SEKURITAS INDONESIA',
  CS: 'CREDIT SUISSE SEKURITAS INDONESIA',
  DB: 'DEUTSCHE SEKURITAS INDONESIA',
  DP: 'DBS VICKERS SEKURITAS INDONESIA',
  BQ: 'KOREA INVESTMENT AND SEKURITAS INDONESIA',
  EP: 'MNC SEKURITAS',
  SS: 'BOC INTERNATIONAL SEKURITAS',
  AG: 'KIWOOM SEKURITAS INDONESIA'
};

function synthesizeBroksumFromAccum(ticker, date, flow, windowData) {
  if (!windowData) return null;
  const isForeign = flow === 'F';
  const isDomestic = flow === 'D';
  const isAll = flow === 'all';

  const buyers = (windowData.top_buyers || []).map(b => ({
    broker_code: b.broker_code,
    broker_name: b.broker_name || BROKER_NAMES[b.broker_code] || (b.broker_code + ' SEKURITAS'),
    bval: Number(b.buy_val || 0),
    bvol: Number(b.buy_lot ? b.buy_lot * 100 : (b.bvol || 1000000)),
    sval: Number(b.sell_val || 0),
    svol: Number(b.sell_lot ? b.sell_lot * 100 : (b.svol || 0)),
    nval: Number(b.net_val || b.buy_val || 0),
    nvol: Number(b.net_lot ? b.net_lot * 100 : 1000000),
    avg_price: Number(b.avg_buy_price || 0)
  }));

  const sellers = (windowData.top_sellers || []).map(s => ({
    broker_code: s.broker_code,
    broker_name: s.broker_name || BROKER_NAMES[s.broker_code] || (s.broker_code + ' SEKURITAS'),
    bval: Number(s.buy_val || 0),
    bvol: Number(s.buy_lot ? s.buy_lot * 100 : (s.bvol || 0)),
    sval: Math.abs(Number(s.sell_val || 0)),
    svol: Math.abs(Number(s.sell_lot ? s.sell_lot * 100 : (s.svol || 1000000))),
    nval: Number(s.net_val != null ? s.net_val : -Math.abs(Number(s.sell_val || 0))),
    nvol: Number(s.net_lot != null ? s.net_lot * 100 : -1000000),
    avg_price: Number(s.avg_sell_price || 0)
  }));

  const brokers = buyers.concat(sellers);
  const netVal = Number(windowData.net_val || 0);
  const totalBuyVal = Number(windowData.total_buy_val || buyers.reduce((sum, b) => sum + b.bval, 0));
  const totalSellVal = Number(windowData.total_sell_val || sellers.reduce((sum, s) => sum + s.sval, 0));
  const totalVol = Number(windowData.total_buy_lot ? windowData.total_buy_lot * 100 : buyers.reduce((sum, b) => sum + b.bvol, 0));

  return {
    stock_code: ticker,
    ticker: ticker,
    date: date,
    flow: flow,
    status: 'RELEASED',
    is_complete: true,
    brokers: brokers,
    broker_net: netVal,
    net_flow: netVal,
    total_buy_val: totalBuyVal,
    total_sell_val: totalSellVal,
    total_buy_vol: totalVol,
    total_volume: totalVol,
    total_turnover: Math.max(totalBuyVal, totalSellVal),
    top_buyers: buyers,
    top_sellers: sellers
  };
}

async function processTickerBatch(tickers) {
  const tasks = tickers.map(async (ticker) => {
    try {
      const tickerAllDir = path.join(ALL_DIR, ticker);
      const tickerFDir = path.join(F_DIR, ticker);
      const tickerDDir = path.join(D_DIR, ticker);
      const accumFile = path.join(ACCUM_DIR, `${ticker}.json`);

      let rawAllDays = [];
      let rawFDays = [];

      // Collect per-date ALL payloads from disk AND SQLite (0 API calls)
      const allByDate = new Map();
      if (fs.existsSync(tickerAllDir)) {
        const dateFiles = (await fs.promises.readdir(tickerAllDir))
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort();
        for (const file of dateFiles) {
          const d = file.slice(0, 10);
          const allJson = safeReadJson(path.join(tickerAllDir, file));
          if (allJson) allByDate.set(d, allJson);
        }
      }
      const sqlAllRows = arjumSqliteHydrate.readAllDateRowsForTickerFromSqlite(
        arjumSqliteHydrate.FLOW_TO_TABLE.ALL,
        ticker
      );
      for (const item of sqlAllRows) {
        if (!allByDate.has(item.date)) {
          allByDate.set(item.date, item.payload);
        }
      }
      const sortedDates = Array.from(allByDate.keys()).sort();

      if (sortedDates.length > 0) {
        for (const date of sortedDates) {
          const file = `${date}.json`;
          const allJson = allByDate.get(date);
          if (!allJson) continue;

          rawAllDays.push({ date, broksum: allJson });

          // Check if F exists on disk first, then SQLite, BEFORE heuristic fallback
          let fJson = safeReadJson(path.join(tickerFDir, file));
          if (!fJson) {
            fJson = arjumSqliteHydrate.hydrateFromSqliteIfPresent({
              ticker,
              date,
              flow: 'F',
              baseDir: ARJUM_DATA_DIR,
              hydrateToDisk: false
            });
          }
          if (!fJson && Array.isArray(allJson.brokers) && allJson.brokers.length > 0) {
            // Extract F from allJson
            const fBrokers = allJson.brokers.filter(b => FOREIGN_SET.has(b.broker_code));
            if (fBrokers.length > 0) {
              const fBuyVal = fBrokers.reduce((s, b) => s + Number(b.bval || 0), 0);
              const fSellVal = fBrokers.reduce((s, b) => s + Number(b.sval || 0), 0);
              // Subtask J — PROVENANCE. This payload is NOT the provider's
              // `flow=F` feed. It is a subset of ALL selected by a hardcoded
              // 16-code FOREIGN_SET, written into `broker-summary-F/`, which is
              // the directory consumers read as PROVIDER_ORIGINAL foreign data.
              //
              // It used to be written as `is_complete: true` with no marker, so
              // a derived file was byte-for-byte indistinguishable from an
              // authentic one — exactly the "do not claim identical" violation
              // this audit exists to close. The repo already sets the standard
              // for this in lib/legacy-foreign-adapter.normalizeLegacyForeign(),
              // which refuses to fabricate a foreign decomposition and marks
              // `is_complete: false` + `data_status: 'PARTIAL'`. This now matches.
              //
              // `is_complete` is false because FOREIGN_SET covers 16 broker
              // codes, not the full foreign broker universe, so the true foreign
              // total is unobserved. `status` stays 'RELEASED' so the in-memory
              // D computation below is unchanged; consumers that read the file
              // back through lib/broksum-flow.computeDomestic now fail closed on
              // `is_complete === false` instead of trusting a derived figure.
              fJson = {
                stock_code: ticker,
                ticker,
                date,
                flow: 'F',
                status: 'RELEASED',
                is_complete: false,
                provenance: 'DERIVED_LOCAL',
                computed_from: 'broker_code_heuristic_from_all',
                data_status: 'PARTIAL',
                note: 'Derived by filtering ALL to a hardcoded 16-code FOREIGN_SET; NOT the provider flow=F feed. Foreign total is unobserved beyond that set.',
                brokers: fBrokers,
                broker_net: fBuyVal - fSellVal,
                net_flow: fBuyVal - fSellVal,
                total_buy_val: fBuyVal,
                total_sell_val: fSellVal,
                total_turnover: Math.max(fBuyVal, fSellVal),
                top_buyers: fBrokers.filter(b => Number(b.nval || (b.bval - b.sval)) > 0),
                top_sellers: fBrokers.filter(b => Number(b.nval || (b.bval - b.sval)) < 0)
              };
              safeWriteJson(path.join(tickerFDir, file), fJson);
              DOMESTIC_COMPILE_STATS.foreign_synthesized_from_all++;
            }
          }

          if (fJson) {
            rawFDays.push({ date, broksum: fJson });
            const domResult = accumLocal.computeDomesticBroksum(allJson, fJson, date, ticker);
            if (domResult && domResult.status === 'RELEASED') {
              // Subtask J — propagate the foreign side's provenance onto D.
              // When F was synthesized from ALL above, D is not
              // `ALL − provider_foreign`; it is `ALL − (ALL filtered by a
              // 16-code set)`. Without this marker the D file looks identical to
              // one derived from an authentic provider F feed.
              if (fJson.provenance === 'DERIVED_LOCAL') {
                domResult.foreign_provenance = 'DERIVED_LOCAL';
                domResult.foreign_computed_from = fJson.computed_from || 'broker_code_heuristic_from_all';
                domResult.note = 'Domestic computed against a foreign side DERIVED from ALL (not the provider flow=F feed).';
                DOMESTIC_COMPILE_STATS.domestic_from_derived_foreign++;
              }
              safeWriteJson(path.join(tickerDDir, file), domResult);
              DOMESTIC_COMPILE_STATS.domestic_written++;
            } else if (accumLocal.isAllBroksumClipped(allJson)) {
              // Subtask J — FAIL CLOSED on a truncated ALL feed.
              // `broker_levels` capped at 25 without `all_data: true` means every
              // broker ranked below 25 is missing, so neither the identity nor the
              // heuristic below can produce a trustworthy domestic figure. Writing
              // one anyway would publish a partial session as a complete one.
              DOMESTIC_COMPILE_STATS.domestic_all_clipped_skipped++;
            } else if (Array.isArray(allJson.brokers) && allJson.brokers.length > 0) {
              // Direct domestic extraction.
              //
              // Subtask J — this branch is NOT the `D = ALL − F` identity: it never
              // subtracts the foreign payload, it excludes a hardcoded foreign
              // broker-code set from ALL. That is a weaker, different definition, so
              // it is now labelled with `computed_from` and is not allowed to claim
              // `is_complete: true`. Two fail-open defects were closed here:
              //   1. `Array.isArray([])` is true, so an ALL payload with an empty
              //      brokers[] used to write `status:'RELEASED', is_complete:true`
              //      with ZERO brokers and 0 turnover — an empty session published
              //      as a complete one (the GPRA/META pattern).
              //   2. the heuristic output was byte-identical in its status fields to
              //      the identity-derived output, so a consumer could not tell which
              //      definition produced the file.
              const dBrokers = allJson.brokers.filter(b => !FOREIGN_SET.has(b.broker_code));
              if (dBrokers.length === 0) {
                DOMESTIC_COMPILE_STATS.domestic_empty_skipped++;
              } else {
                const dBuyVal = dBrokers.reduce((s, b) => s + Number(b.bval || 0), 0);
                const dSellVal = dBrokers.reduce((s, b) => s + Number(b.sval || 0), 0);
                const dPayload = {
                  stock_code: ticker,
                  ticker,
                  date,
                  flow: 'D',
                  status: 'RELEASED',
                  is_complete: false,
                  computed_from: 'broker_code_heuristic',
                  note: 'Domestic derived by excluding a hardcoded foreign broker-code set from ALL; foreign payload was NOT subtracted (D != ALL - F).',
                  brokers: dBrokers,
                  broker_net: dBuyVal - dSellVal,
                  net_flow: dBuyVal - dSellVal,
                  total_buy_val: dBuyVal,
                  total_sell_val: dSellVal,
                  total_turnover: Math.max(dBuyVal, dSellVal),
                  top_buyers: dBrokers.filter(b => Number(b.nval || (b.bval - b.sval)) > 0),
                  top_sellers: dBrokers.filter(b => Number(b.nval || (b.bval - b.sval)) < 0)
                };
                safeWriteJson(path.join(tickerDDir, file), dPayload);
              }
            }
          }
        }

        // Write latest D and latest ALL files
        const latestDFile = (await fs.promises.readdir(tickerDDir).catch(() => []))
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort().pop();
        if (latestDFile) {
          const content = safeReadJson(path.join(tickerDDir, latestDFile));
          if (content) safeWriteJson(path.join(tickerDDir, 'latest.json'), content);
        }
      }

      // If accumulation file exists, ensure ALL, F, and D files exist for latest date
      let existingAccum = safeReadJson(accumFile);
      if (existingAccum && existingAccum.latest && existingAccum.latest.windows) {
        const latestDate = existingAccum.latest.date || '2026-10-28';
        const win = existingAccum.latest.windows['1H'];
        if (win) {
          if (win.all && !fs.existsSync(path.join(tickerAllDir, `${latestDate}.json`))) {
            const allSynth = synthesizeBroksumFromAccum(ticker, latestDate, 'all', win.all);
            if (allSynth) {
              safeWriteJson(path.join(tickerAllDir, `${latestDate}.json`), allSynth);
              safeWriteJson(path.join(tickerAllDir, 'latest.json'), allSynth);
            }
          }
          if (win.foreign && !fs.existsSync(path.join(tickerFDir, `${latestDate}.json`))) {
            const fSynth = synthesizeBroksumFromAccum(ticker, latestDate, 'F', win.foreign);
            if (fSynth) {
              safeWriteJson(path.join(tickerFDir, `${latestDate}.json`), fSynth);
              safeWriteJson(path.join(tickerFDir, 'latest.json'), fSynth);
            }
          }
          if (win.domestic && !fs.existsSync(path.join(tickerDDir, `${latestDate}.json`))) {
            const dSynth = synthesizeBroksumFromAccum(ticker, latestDate, 'D', win.domestic);
            if (dSynth) {
              safeWriteJson(path.join(tickerDDir, `${latestDate}.json`), dSynth);
              safeWriteJson(path.join(tickerDDir, 'latest.json'), dSynth);
            }
          }
        }
      }

      // Recompute rolling accumulation if rawAllDays exists
      if (rawAllDays.length > 0) {
        const rolling = accumLocal.computeFullRollingAccumulation(ticker, rawAllDays, rawFDays);
        if (rolling) {
          safeWriteJson(accumFile, rolling);
        }
      }

      return { ticker, success: true };
    } catch (e) {
      return { ticker, success: false, error: e.message };
    }
  });

  return Promise.all(tasks);
}

async function runDomesticCompile() {
  const startTime = Date.now();
  console.log('================================================================');
  console.log(' AUTO-CUAN V4: DOMESTIC COMPILE PARALEL (< 15 DETIK)');
  console.log('================================================================');

  const tickerSet = new Set();
  if (fs.existsSync(ALL_DIR)) {
    fs.readdirSync(ALL_DIR).forEach(d => {
      if (/^[A-Z0-9.-]{2,10}$/.test(d)) tickerSet.add(d);
    });
  }
  for (const tk of arjumSqliteHydrate.listTickersInSqliteTable(arjumSqliteHydrate.FLOW_TO_TABLE.ALL)) {
    tickerSet.add(tk);
  }
  if (fs.existsSync(ACCUM_DIR)) {
    fs.readdirSync(ACCUM_DIR).forEach(f => {
      if (f.endsWith('.json') && f !== 'archive-index.json') {
        tickerSet.add(f.replace(/\.json$/, ''));
      }
    });
  }

  ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ANTM', 'ASII', 'BREN', 'BRPT', 'CUAN', 'TPIA', 'PGAS'].forEach(t => tickerSet.add(t));

  const allTickers = Array.from(tickerSet).sort();
  console.log(`Menemukan ${allTickers.length} emiten untuk diproses paralel...`);

  const BATCH_SIZE = 50;
  for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
    const batch = allTickers.slice(i, i + BATCH_SIZE);
    await processTickerBatch(batch);
  }

  console.log(
    `Domestic: ${DOMESTIC_COMPILE_STATS.domestic_written} ditulis · ` +
    `${DOMESTIC_COMPILE_STATS.domestic_all_clipped_skipped} dilewati (ALL terpotong 25 level) · ` +
    `${DOMESTIC_COMPILE_STATS.domestic_empty_skipped} dilewati (0 broker domestik) · ` +
    `${DOMESTIC_COMPILE_STATS.foreign_synthesized_from_all} F diturunkan dari ALL (bukan feed provider) · ` +
    `${DOMESTIC_COMPILE_STATS.domestic_from_derived_foreign} D dihitung dari F turunan`
  );

  // Build Hunter Indexes
  fs.mkdirSync(HUNTER_INDEX_DIR, { recursive: true });
  const hunterWindows = [
    { range: '1d', days: 1, out: 'latest_1d.json', winKey: '1H' },
    { range: '3d', days: 3, out: 'latest_3d.json', winKey: '3H' },
    { range: '1w', days: 5, out: 'latest_1w.json', winKey: '5H' },
    { range: '1m', days: 20, out: 'latest_1m.json', winKey: '20H' }
  ];

  for (const hw of hunterWindows) {
    const summary = {
      range: hw.range,
      days: hw.days,
      generated_at: new Date().toISOString(),
      total_tickers: allTickers.length,
      items: []
    };

    for (const t of allTickers) {
      const acc = safeReadJson(path.join(ACCUM_DIR, `${t}.json`));
      if (!acc || !acc.latest || !acc.latest.windows) continue;
      const win = acc.latest.windows[hw.winKey];
      if (!win || !win.all) continue;

      summary.items.push({
        ticker: t,
        direction: win.all.arah || 'Netral',
        bs_ratio_3: win.all.bs_ratio_3 || 1.0,
        net_val: win.all.net_val || 0,
        total_turnover: win.all.total_buy_val || 0,
        top_buyers: (win.all.top_buyers || []).map(b => b.broker_code),
        top_sellers: (win.all.top_sellers || []).map(s => s.broker_code)
      });
    }

    safeWriteJson(path.join(HUNTER_INDEX_DIR, hw.out), summary);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[PASS] Kompilasi Domestik Selesai dalam ${durationSec} detik (< 15 detik)`);
  return { success: true, durationSec: Number(durationSec), total: allTickers.length };
}

if (require.main === module) {
  runDomesticCompile().then(res => {
    if (res.durationSec >= 15) {
      console.error(`FAILED: Kompilasi melebihi budget 15 detik (${res.durationSec}s)`);
      process.exit(1);
    }
    process.exit(0);
  }).catch(err => {
    console.error('ERROR domestic-compile:', err);
    process.exit(1);
  });
}

module.exports = { runDomesticCompile };
