'use strict';
// Mesin Sensus Kelengkapan Data 964 Saham Penuh (P3).
// Menghitung langsung dari disk untuk SELURUH ticker di data/daily-candles/*.json
// (963 emiten + IHSG = 964, atau jumlah eksak file di disk) + kalender bursa dari IHSG.json.
// Output: data/completeness/latest.json (+ salinan baseline ke bukti-verifikasi-final/faseP3/before-backfill.json via CLI --write-baseline).
// DILARANG: sampel, hardcode kuota, print secret. Istilah UI netral: "Kuota API data".
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');
const ALL_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const F_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F');
const D_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-D');
const ACCUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const HUNTER_IDX_DIR = path.join(ROOT, 'data', 'broker-hunter-indexes');
const INTEL_IDX_DIR = path.join(ROOT, 'data', 'bandarmologi-intel-indexes');
const INSIDER_ARJUM_DIR = path.join(ROOT, 'data', 'arjum-data', 'insiders');
const INSIDER_NET_DIR = path.join(ROOT, 'data', 'insider-network');
const FIN_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');
const OUT_PATH = path.join(ROOT, 'data', 'completeness', 'latest.json');

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function safeReadJson(filePath) {
  // Validator inti: dipakai juga oleh gate-P3 kontrol negatif.
  // return { ok, data?, reason? } — 0-byte / korup / bukan-JSON ditolak (ok:false).
  let st = null;
  try { st = fs.statSync(filePath); } catch (e) { return { ok: false, reason: 'missing: ' + e.message }; }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
  if (st.size === 0) return { ok: false, reason: 'empty-0-byte' };
  let raw = null;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { ok: false, reason: 'read-error: ' + e.message }; }
  if (!raw || raw.trim().length === 0) return { ok: false, reason: 'empty-body' };
  try {
    const data = JSON.parse(raw);
    return { ok: true, data, bytes: st.size };
  } catch (e) { return { ok: false, reason: 'corrupt-json: ' + e.message }; }
}

function isValidJsonFile(filePath) {
  return safeReadJson(filePath).ok;
}

function listDailyTickers() {
  let files = [];
  try { files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json')); } catch (_) { files = []; }
  const tickers = files.map((f) => f.slice(0, -5)).sort();
  return { files, tickers };
}

function loadCalendar() {
  // Kalender hari bursa = tanggal candle IHSG.json (sumber kebenaran tunggal).
  const ihsgPath = path.join(DAILY_DIR, 'IHSG.json');
  const r = safeReadJson(ihsgPath);
  if (!r.ok) return { ok: false, reason: r.reason, dates: [], last: null };
  const candles = Array.isArray(r.data.candles) ? r.data.candles : [];
  const dates = candles.map((c) => c && c.date).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return { ok: true, dates, last: dates.length ? dates[dates.length - 1] : null, count: dates.length };
}

function listDateCells(dirForTicker) {
  // Kembalikan { dates:Set, files:number, corrupt:number, hasLatest:boolean }
  let entries = [];
  try { entries = fs.readdirSync(dirForTicker); } catch (_) { return { dates: new Set(), files: 0, corrupt: 0, hasLatest: false, missing: true }; }
  const dates = new Set();
  let files = 0;
  let corrupt = 0;
  let hasLatest = false;
  for (const e of entries) {
    if (e === 'latest.json') { hasLatest = true; continue; }
    const m = e.match(DATE_RE);
    if (!m) continue;
    files += 1;
    const fp = path.join(dirForTicker, e);
    const v = safeReadJson(fp);
    if (!v.ok) { corrupt += 1; continue; }
    // Sel terisi = file JSON valid non-kosong (objek/array dengan >=1 key/elemen).
    // Bentuk non-standar (mis. ringkasan top_buyers/top_sellers tanpa brokers array)
    // tetap dihitung TERISI, bukan korup; hanya 0-byte / JSON rusak yang korup.
    const d = v.data;
    const isObj = d && typeof d === 'object';
    const nonEmpty = isObj && (Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0);
    if (!nonEmpty) { corrupt += 1; continue; }
    dates.add(m[1]);
  }
  return { dates, files, corrupt, hasLatest, missing: false };
}

function detectQ2_2026(items) {
  // items: array periode quarterly. Q2 2026 jika salah satu:
  // label "Q2 2026" / "6M 2026" / "2026-06-30", atau year=2026 & quarter=2/06/H1.
  if (!Array.isArray(items)) return { has: false, latest: null };
  let has = false;
  let latest = null;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '');
    const year = String(it.year || '');
    const q = String(it.quarter || '').toUpperCase();
    const blob = JSON.stringify([label, year, q, it.period || '', it.date || '', it.end_date || '']).toUpperCase();
    const isQ2 = label.toUpperCase().includes('Q2 2026')
      || label.toUpperCase().includes('6M 2026')
      || blob.includes('2026-06-30')
      || (year === '2026' && (q === '2' || q === 'Q2' || q === '06' || q === 'H1' || q === '6M'));
    if (isQ2) has = true;
    const key = (year || '') + '-' + (q || '') + '-' + label;
    if (!latest || key > latest) latest = key;
  }
  return { has, latest };
}

function detectFY(items, targetYear) {
  if (!Array.isArray(items)) return { has: false };
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '').toUpperCase();
    const year = String(it.year || '');
    const q = String(it.quarter || '').toUpperCase();
    if (year === String(targetYear) && (q === 'FY' || q === 'ANNUAL' || label.includes('FY ' + targetYear) || label.includes(String(targetYear)))) return { has: true };
  }
  return { has: false };
}

function censusAll() {
  const startedAt = new Date().toISOString();
  const { files: dailyFiles, tickers } = listDailyTickers();
  const totalDisk = dailyFiles.length;
  const emitens = tickers.filter((t) => t !== 'IHSG');
  const cal = loadCalendar();
  const calendar = cal.dates;
  const lastDay = cal.last;
  const calSet = new Set(calendar);

  // --- 4) Candle & volume harian ---
  let candleFresh = 0;
  let candleStale = 0;
  let candleCorrupt = 0;
  let candleMissing = 0;
  const candleStaleList = [];
  const candleLastByTicker = {};
  for (const t of tickers) {
    const fp = path.join(DAILY_DIR, t + '.json');
    const r = safeReadJson(fp);
    if (!r.ok) {
      if (r.reason && r.reason.startsWith('missing')) candleMissing += 1;
      else candleCorrupt += 1;
      candleLastByTicker[t] = null;
      continue;
    }
    const candles = Array.isArray(r.data.candles) ? r.data.candles : [];
    if (!candles.length) { candleCorrupt += 1; candleLastByTicker[t] = null; continue; }
    const dates = candles.map((c) => c && c.date).filter(Boolean).sort();
    const last = dates[dates.length - 1];
    candleLastByTicker[t] = last || null;
    if (last === lastDay) candleFresh += 1;
    else { candleStale += 1; if (candleStaleList.length < 300) candleStaleList.push(t + '@' + (last || 'EMPTY')); }
  }

  // --- 1/2/3) Broksum ALL / Foreign / Domestik ---
  // Jendela ekspektasi: tanggal kalender >= tanggal DATE.json paling awal di ALL_DIR (atau kalender penuh bila kosong).
  let minBroksumDate = null;
  try {
    const tickerDirs = fs.readdirSync(ALL_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const td of tickerDirs.slice(0, 60)) {
      let ents = [];
      try { ents = fs.readdirSync(path.join(ALL_DIR, td)); } catch (_) { continue; }
      for (const e of ents) {
        const m = e.match(DATE_RE);
        if (m && (!minBroksumDate || m[1] < minBroksumDate)) minBroksumDate = m[1];
      }
    }
  } catch (_) {}
  if (!minBroksumDate && calendar.length) minBroksumDate = calendar[0];
  const expectedDates = calendar.filter((d) => !minBroksumDate || d >= minBroksumDate);
  const expectedSet = new Set(expectedDates);

  function censusBroksum(baseDir) {
    let filled = 0;
    let corrupt = 0;
    let tickersWithDir = 0;
    const missingPairs = [];
    const missingCountByTicker = {};
    const filledByTicker = {};
    for (const t of tickers) {
      const dir = path.join(baseDir, t);
      let exists = false;
      try { exists = fs.statSync(dir).isDirectory(); } catch (_) { exists = false; }
      if (!exists) {
        missingCountByTicker[t] = expectedDates.length;
        filledByTicker[t] = 0;
        continue;
      }
      tickersWithDir += 1;
      const cells = listDateCells(dir);
      corrupt += cells.corrupt;
      let f = 0;
      for (const d of expectedDates) {
        if (cells.dates.has(d)) { filled += 1; f += 1; }
        else {
          if (missingPairs.length < 200000) missingPairs.push(t + '@' + d);
        }
      }
      filledByTicker[t] = f;
      missingCountByTicker[t] = expectedDates.length - f;
    }
    const expectedCells = expectedDates.length * tickers.length;
    return {
      baseDir: path.relative(ROOT, baseDir).replace(/\\/g, '/'),
      exists: fs.existsSync(baseDir),
      windowStart: minBroksumDate,
      windowEnd: lastDay,
      expectedDates: expectedDates.length,
      expectedCells,
      filledCells: filled,
      missingCells: expectedCells - filled,
      corruptCells: corrupt,
      tickersWithDir,
      tickersWithoutDir: tickers.length - tickersWithDir,
      missingCountByTicker,
      missingPairsSample: missingPairs.slice(0, 200),
      missingPairsCount: missingPairs.length,
    };
  }

  const broksumALL = censusBroksum(ALL_DIR);
  const broksumF = censusBroksum(F_DIR);
  // Domestik: pasangan ALL+F sudah vs belum dihitung (D_DIR/<T>/<DATE>.json).
  let domesticDone = 0;
  let domesticPending = 0;
  const domesticPendingSample = [];
  try {
    for (const t of tickers) {
      const allCells = listDateCells(path.join(ALL_DIR, t)).dates;
      const fCells = listDateCells(path.join(F_DIR, t)).dates;
      const dCells = listDateCells(path.join(D_DIR, t)).dates;
      const pairDates = [...allCells].filter((d) => fCells.has(d) && expectedSet.has(d));
      for (const d of pairDates) {
        if (dCells.has(d)) domesticDone += 1;
        else {
          domesticPending += 1;
          if (domesticPendingSample.length < 200) domesticPendingSample.push(t + '@' + d);
        }
      }
    }
  } catch (_) {}
  const domestic = {
    baseDir: path.relative(ROOT, D_DIR).replace(/\\/g, '/'),
    exists: fs.existsSync(D_DIR),
    pairsDone: domesticDone,
    pairsPending: domesticPending,
    pendingSample: domesticPendingSample,
  };

  // --- 5) Akumulasi + indeks hunter ---
  const WINDOWS = ['1H', '3H', '5H', '10H', '20H'];
  let accumFresh = 0;
  let accumStale = 0;
  let accumMissing = 0;
  let accumCorrupt = 0;
  const accumWindowsCount = { '1H': 0, '3H': 0, '5H': 0, '10H': 0, '20H': 0 };
  const accumStaleSample = [];
  for (const t of tickers) {
    const fp = path.join(ACCUM_DIR, t + '.json');
    if (!fs.existsSync(fp)) { accumMissing += 1; continue; }
    const r = safeReadJson(fp);
    if (!r.ok) { accumCorrupt += 1; continue; }
    const d = r.data || {};
    const wins = (d.latest && d.latest.windows) || d.windows || {};
    for (const w of WINDOWS) if (wins[w]) accumWindowsCount[w] += 1;
    const end = d.end_date || (d.latest && d.latest.date) || null;
    const fresh = end && lastDay && end >= lastDay;
    if (fresh) accumFresh += 1;
    else { accumStale += 1; if (accumStaleSample.length < 200) accumStaleSample.push(t + '@' + (end || 'NO_END')); }
  }
  const intelFiles = ['latest_1d.json', 'latest_3d.json', 'latest_7d.json', 'latest_30d.json'];
  const intelFresh = {};
  for (const f of intelFiles) {
    const fp = path.join(INTEL_IDX_DIR, f);
    if (!fs.existsSync(fp)) { intelFresh[f] = { exists: false, updated_at: null }; continue; }
    const r = safeReadJson(fp);
    intelFresh[f] = { exists: true, ok: r.ok, updated_at: (r.ok && (r.data.updated_at || r.data.generated_at)) || null, bytes: r.ok ? r.bytes : 0 };
  }
  let hunterIdxCount = 0;
  try { hunterIdxCount = fs.readdirSync(HUNTER_IDX_DIR).filter((f) => f.endsWith('.json')).length; } catch (_) {}

  // --- 6) Insider & KSEI ---
  let rosterTickers = [];
  let rosterTotal = 0;
  let rosterUpdatedAt = null;
  try {
    const r = safeReadJson(path.join(INSIDER_NET_DIR, 'roster.json'));
    if (r.ok) {
      rosterUpdatedAt = r.data.updated_at || null;
      const tk = (r.data.tickers && typeof r.data.tickers === 'object') ? Object.keys(r.data.tickers) : [];
      rosterTickers = tk.sort();
      rosterTotal = typeof r.data.total_tickers === 'number' ? r.data.total_tickers : tk.length;
    }
  } catch (_) {}
  const rosterSet = new Set(rosterTickers);
  let insiderWithData = 0;
  let insiderWithRealDate = 0;
  const insiderMissingSample = [];
  // tanggal asli: minimal satu record roster punya last_date non-kosong.
  let rosterDateCache = null;
  try {
    const r = safeReadJson(path.join(INSIDER_NET_DIR, 'roster.json'));
    rosterDateCache = r.ok ? r.data.tickers : null;
  } catch (_) {}
  for (const t of emitens) {
    if (rosterSet.has(t)) {
      insiderWithData += 1;
      let hasDate = false;
      try {
        const recs = rosterDateCache ? rosterDateCache[t] : null;
        if (Array.isArray(recs)) hasDate = recs.some((x) => x && typeof x.last_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.last_date));
      } catch (_) {}
      if (hasDate) insiderWithRealDate += 1;
    } else if (insiderMissingSample.length < 200) insiderMissingSample.push(t);
  }
  let insiderArjumTickers = 0;
  try { insiderArjumTickers = fs.readdirSync(INSIDER_ARJUM_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch (_) {}

  // --- 7) Fundamental (6 berkas per emiten) ---
  const REPORTS = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW_REPORT'];
  const PERIODS = ['quarterly', 'annually'];
  let finFilesPresent = 0;
  let finFilesMissing = 0;
  let finCorrupt = 0;
  let q2Count = 0; // emiten yang punya Q2 2026 di >=1 quarterly? — dihitung ketat: punya di KETIGA quarterly
  let q2PerReport = { INCOME_STATEMENT: 0, BALANCE_SHEET: 0, CASH_FLOW_REPORT: 0 };
  let fy2025PerReport = { INCOME_STATEMENT: 0, BALANCE_SHEET: 0, CASH_FLOW_REPORT: 0 };
  const finStuckQ1OrBefore = [];
  const finMissingSample = [];
  let upstreamRequests = 0;
  const upstreamByKind = { missingFile: 0, quarterlyRefreshQ2: 0, annuallyRefreshFY: 0 };
  for (const t of emitens) {
    let hasQ2All3 = true;
    let latestLabel = null;
    for (const rep of REPORTS) {
      for (const per of PERIODS) {
        const fp = path.join(FIN_DIR, t, rep + '-' + per + '.json');
        if (!fs.existsSync(fp)) {
          finFilesMissing += 1;
          upstreamRequests += 1;
          upstreamByKind.missingFile += 1;
          if (finMissingSample.length < 200) finMissingSample.push(t + '/' + rep + '-' + per);
          if (per === 'quarterly') hasQ2All3 = false;
          continue;
        }
        const r = safeReadJson(fp);
        if (!r.ok) {
          finCorrupt += 1;
          upstreamRequests += 1;
          upstreamByKind.missingFile += 1;
          if (per === 'quarterly') hasQ2All3 = false;
          continue;
        }
        finFilesPresent += 1;
        const items = r.data && r.data.data && Array.isArray(r.data.data.items) ? r.data.data.items
          : Array.isArray(r.data.items) ? r.data.items : [];
        if (per === 'quarterly') {
          const q = detectQ2_2026(items);
          if (q.has) q2PerReport[rep] += 1;
          else {
            hasQ2All3 = false;
            upstreamRequests += 1;
            upstreamByKind.quarterlyRefreshQ2 += 1;
          }
          if (q.latest && (!latestLabel || q.latest > latestLabel)) latestLabel = q.latest;
        } else {
          const fy = detectFY(items, 2025);
          if (fy.has) fy2025PerReport[rep] += 1;
          else { upstreamRequests += 1; upstreamByKind.annuallyRefreshFY += 1; }
        }
      }
    }
    if (hasQ2All3) q2Count += 1;
    else if (finStuckQ1OrBefore.length < 300) finStuckQ1OrBefore.push(t + (latestLabel ? '@' + latestLabel : '@NO_Q2'));
  }
  const finExpected = emitens.length * 6;

  const result = {
    tool: 'tools/data-completeness.js',
    generatedAt: startedAt,
    universe: { totalFiles: totalDisk, tickers: tickers.length, emitens: emitens.length, hasIHSG: tickers.includes('IHSG') },
    calendar: { source: 'data/daily-candles/IHSG.json', tradingDays: calendar.length, first: calendar[0] || null, last: lastDay, ok: cal.ok },
    broksumALL: { filledCells: broksumALL.filledCells, missingCells: broksumALL.missingCells, expectedCells: broksumALL.expectedCells, corruptCells: broksumALL.corruptCells, tickersWithDir: broksumALL.tickersWithDir, tickersWithoutDir: broksumALL.tickersWithoutDir, windowStart: broksumALL.windowStart, windowEnd: broksumALL.windowEnd, expectedDates: broksumALL.expectedDates, missingPairsCount: broksumALL.missingPairsCount, missingPairsSample: broksumALL.missingPairsSample, missingCountByTicker: broksumALL.missingCountByTicker },
    broksumForeign: { filledCells: broksumF.filledCells, missingCells: broksumF.missingCells, expectedCells: broksumF.expectedCells, corruptCells: broksumF.corruptCells, tickersWithDir: broksumF.tickersWithDir, tickersWithoutDir: broksumF.tickersWithoutDir, windowStart: broksumF.windowStart, windowEnd: broksumF.windowEnd, expectedDates: broksumF.expectedDates, missingPairsCount: broksumF.missingPairsCount, missingPairsSample: broksumF.missingPairsSample, missingCountByTicker: broksumF.missingCountByTicker },
    broksumDomestic: domestic,
    candles: { lastTradingDay: lastDay, freshTickers: candleFresh, staleTickers: candleStale, corruptFiles: candleCorrupt, missingFiles: candleMissing, staleSample: candleStaleList.slice(0, 200), staleCount: candleStaleList.length },
    accumulation: { dir: 'data/broker-accumulation', filesPresent: accumFresh + accumStale, freshTickers: accumFresh, staleTickers: accumStale, missingTickers: accumMissing, corruptFiles: accumCorrupt, windowsCount: accumWindowsCount, staleSample: accumStaleSample.slice(0, 200) },
    hunterIndexes: { dir: 'data/broker-hunter-indexes', indexFiles: hunterIdxCount, intelDir: 'data/bandarmologi-intel-indexes', intel: intelFresh },
    insider: { emitens: emitens.length, withShareholderData: insiderWithData, withRealDate: insiderWithRealDate, withoutData: emitens.length - insiderWithData, rosterTotalTickers: rosterTotal, rosterUpdatedAt, arjumInsiderTickerDirs: insiderArjumTickers, missingSample: insiderMissingSample.slice(0, 200) },
    fundamental: { emitens: emitens.length, expectedFiles: finExpected, presentFiles: finFilesPresent, missingFiles: finFilesMissing, corruptFiles: finCorrupt, withQ2_2026_all3: q2Count, stuckQ1OrBefore: emitens.length - q2Count, q2PerReport, fy2025PerReport, stuckSample: finStuckQ1OrBefore.slice(0, 300), missingSample: finMissingSample.slice(0, 200), upstreamRequests, upstreamByKind },
  };
  return result;
}

function writeLatest() {
  const res = censusAll();
  res.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(res, null, 2));
  return { out: OUT_PATH, result: res };
}

module.exports = { censusAll, writeLatest, safeReadJson, isValidJsonFile, OUT_PATH };

if (require.main === module) {
  const args = process.argv.slice(2);
  const { out, result } = writeLatest();
  if (args.includes('--write-baseline')) {
    const base = path.join(ROOT, 'bukti-verifikasi-final', 'faseP3', 'before-backfill.json');
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, JSON.stringify(result, null, 2));
    console.log('baseline=' + base);
  }
  console.log('wrote=' + out);
  console.log('tickers=' + result.universe.tickers + ' emitens=' + result.universe.emitens + ' last=' + result.calendar.last);
  console.log('ALL filled=' + result.broksumALL.filledCells + ' missing=' + result.broksumALL.missingCells + ' corrupt=' + result.broksumALL.corruptCells);
  console.log('F filled=' + result.broksumForeign.filledCells + ' missing=' + result.broksumForeign.missingCells);
  console.log('domestic done=' + result.broksumDomestic.pairsDone + ' pending=' + result.broksumDomestic.pairsPending);
  console.log('candles fresh=' + result.candles.freshTickers + '/' + result.universe.tickers);
  console.log('accum fresh=' + result.accumulation.freshTickers + ' missing=' + result.accumulation.missingTickers);
  console.log('insider withData=' + result.insider.withShareholderData + ' withDate=' + result.insider.withRealDate);
  console.log('fundamental Q2all3=' + result.fundamental.withQ2_2026_all3 + '/' + result.fundamental.emitens + ' upstream=' + result.fundamental.upstreamRequests);
}
