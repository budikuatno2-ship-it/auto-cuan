#!/usr/bin/env node
'use strict';
// P4 — Mesin Penyerap Kuota Harian & Backfill Otomatis.
// Eksekutor antrean prioritas data/backfill-queue.json (dibangun tools/build-backfill-queue.js
// dari data/completeness/latest.json):
//   P1 = Laporan Keuangan Q2 2026 untuk emiten tertahan Q1 (likuid dulu, lalu sisanya);
//   P2 = sel bolong Broksum ALL (tanggal bursa terbaru mundur);
//   P3 = sel bolong Broksum Foreign (20 hari bursa terakhir dulu, lalu sisa);
//   P4 = sisa histori Foreign lebih tua.
// Kontrak P4:
//   - WAJIB panggil lib/quota-state.js canConsumeQuota(requestedCount, jobType) tiap batch
//     (dan tiap request), hormati reserve floor dinamis dari config/quota.json
//     (siang/malam/weekend via reserveFloorFor) + hard stop 23:50-00:10 WIB.
//   - Tulis heartbeat data/job-heartbeat/quota-burn.json tiap batch + akhir.
//   - Tiap batch selesai langsung panggil kompilator lokal
//     (tools/build-domestic-broksum-and-accum.js + mapper fundamental) agar data baru
//     terwujud di UI.
//   - Idempoten + resumable: sel yang sudah terisi di disk dilewati tanpa memakai kuota,
//     sehingga cron estafet per jam dapat melanjutkan sisa hingga reserve floor.
//   - DILARANG print nilai .env/API key/token/SESSION_SECRET/*.key ke stdout/log.
//   - Istilah netral: "Kuota API data". Tanpa hardcode angka kuota.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const quotaState = require(path.join(ROOT, 'lib', 'quota-state'));
let wibHardStop = null;
try { wibHardStop = require(path.join(ROOT, 'lib', 'wib-hard-stop')); } catch (_) {}
let quotaTracker = null;
try { quotaTracker = require(path.join(ROOT, 'lib', 'arjum-quota-tracker')); } catch (_) {}
let arjumClient = null;
try { arjumClient = require(path.join(ROOT, 'lib', 'arjum-client')); } catch (_) {}

const QUEUE_PATH = path.join(ROOT, 'data', 'backfill-queue.json');
const HEARTBEAT_PATH = path.join(ROOT, 'data', 'job-heartbeat', 'quota-burn.json');
const PROGRESS_PATH = path.join(ROOT, 'data', 'quota-burn-state.json');
const ALL_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const F_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F');
const FIN_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');

function parseArgs(argv) {
  const o = {
    dryRun: false, maxRequests: null, batch: 25, floor: null,
    priorities: ['P1', 'P2', 'P3', 'P4'], tickers: null,
    queue: QUEUE_PATH, noCompile: false, jobType: 'quota-burn'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-compile') o.noCompile = true;
    else if (a === '--floor' && argv[i + 1] !== undefined) { const v = parseInt(argv[++i], 10); if (Number.isFinite(v) && v >= 0) o.floor = v; }
    else if (a.startsWith('--floor=')) { const v = parseInt(a.slice(8), 10); if (Number.isFinite(v) && v >= 0) o.floor = v; }
    else if ((a === '--max-requests' || a === '--limit') && argv[i + 1] !== undefined) { const v = parseInt(argv[++i], 10); if (Number.isFinite(v) && v > 0) o.maxRequests = v; }
    else if (a.startsWith('--max-requests=')) { const v = parseInt(a.slice(15), 10); if (Number.isFinite(v) && v > 0) o.maxRequests = v; }
    else if (a.startsWith('--limit=')) { const v = parseInt(a.slice(8), 10); if (Number.isFinite(v) && v > 0) o.maxRequests = v; }
    else if (a === '--batch' && argv[i + 1] !== undefined) { const v = parseInt(argv[++i], 10); if (Number.isFinite(v) && v > 0) o.batch = v; }
    else if (a.startsWith('--batch=')) { const v = parseInt(a.slice(8), 10); if (Number.isFinite(v) && v > 0) o.batch = v; }
    else if (a === '--priority' && argv[i + 1] !== undefined) { o.priorities = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^P[1-4]$/.test(s)); }
    else if (a.startsWith('--priority=')) { o.priorities = String(a.slice(11)).split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^P[1-4]$/.test(s)); }
    else if (a === '--tickers' && argv[i + 1] !== undefined) { o.tickers = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); }
    else if (a.startsWith('--tickers=')) { o.tickers = a.slice(10).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); }
    else if (a === '--queue' && argv[i + 1] !== undefined) { o.queue = path.resolve(argv[++i]); }
    else if (a.startsWith('--queue=')) { o.queue = path.resolve(a.slice(8)); }
  }
  if (!o.priorities.length) o.priorities = ['P1', 'P2', 'P3', 'P4'];
  return o;
}

function loadEnvApiKey() {
  if (process.env.ARJUM_API_KEY && String(process.env.ARJUM_API_KEY).trim()) return String(process.env.ARJUM_API_KEY).trim();
  const candidates = [
    path.join(ROOT, '.env'),
    path.join(ROOT, '.env.local'),
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*(?:export\s+)?ARJUM_API_KEY\s*=\s*["']?([^"'\r\n]+)/);
        if (m && m[1] && m[1].trim()) return m[1].trim();
      }
    } catch (_) {}
  }
  return '';
}

function hardStopNow() {
  try {
    if (wibHardStop && typeof wibHardStop.shouldStop === 'function') {
      if (wibHardStop.shouldStop()) return true;
      if (typeof wibHardStop.isForbiddenMidnightWindow === 'function' && wibHardStop.isForbiddenMidnightWindow()) return true;
    }
  } catch (_) {}
  try { return quotaState.isInForbiddenWindow(new Date()); } catch (_) { return false; }
}

function wibIsoNow() {
  try {
    const p = quotaState.getWibParts(new Date());
    const hh = String(p.hour).padStart(2, '0');
    const mm = String(p.minute).padStart(2, '0');
    const ss = String(p.second).padStart(2, '0');
    return p.dateKey + 'T' + hh + ':' + mm + ':' + ss + '+07:00';
  } catch (_) { return new Date().toISOString(); }
}

function writeHeartbeat(status, exitCode, requestsUsed, startIso, errSnippet) {
  try {
    const endIso = wibIsoNow();
    const hb = {
      jobName: 'quota-burn',
      lastStartWIB: startIso,
      lastEndWIB: endIso,
      durationMs: 0,
      exitCode,
      requestsUsed,
      status,
      lastErrorSnippet: String(errSnippet || '').slice(0, 300)
    };
    fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
    fs.writeFileSync(HEARTBEAT_PATH + '.tmp.' + process.pid, JSON.stringify(hb, null, 2));
    fs.renameSync(HEARTBEAT_PATH + '.tmp.' + process.pid, HEARTBEAT_PATH);
  } catch (_) {}
}

function writeProgress(obj) {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(obj, null, 2));
  } catch (_) {}
}

function isValidJsonFile(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size === 0) return false;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return false;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && (Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0);
  } catch (_) { return false; }
}

function extractFinItems(envelope) {
  if (!envelope || typeof envelope !== 'object') return [];
  if (envelope.data && Array.isArray(envelope.data.items)) return envelope.data.items;
  if (Array.isArray(envelope.items)) return envelope.items;
  if (envelope.data && envelope.data.data && Array.isArray(envelope.data.data.items)) return envelope.data.data.items;
  if (envelope.data && Array.isArray(envelope.data.data)) return envelope.data.data;
  if (Array.isArray(envelope.data)) return envelope.data;
  return [];
}

function finItemsHaveQ2(items) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '');
    const year = String(it.year || '');
    const q = String(it.quarter || '').toUpperCase();
    const blob = JSON.stringify([label, year, q, it.period || '', it.date || '', it.end_date || '']).toUpperCase();
    if (label.toUpperCase().includes('Q2 2026') || label.toUpperCase().includes('6M 2026') || blob.includes('2026-06-30')) return true;
    if (year === '2026' && (q === '2' || q === 'Q2' || q === '06' || q === 'H1' || q === '6M')) return true;
  }
  return false;
}

function finItemsHaveFY(items, targetYear) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '').toUpperCase();
    const year = String(it.year || '');
    const q = String(it.quarter || '').toUpperCase();
    if (year === String(targetYear) && (q === 'FY' || q === 'ANNUAL' || label.includes('FY ' + targetYear) || label.includes(String(targetYear)))) return true;
  }
  return false;
}

// Skip P1 yang sadar-kelengkapan: quarterly dilewati hanya bila sudah memuat Q2 2026,
// annually dilewati hanya bila sudah memuat FY target. Berkas basi/tanpa-Q2 tetap di-fetch.
function isP1FileFresh(fp, period) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size === 0) return false;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return false;
    const d = JSON.parse(raw);
    const items = extractFinItems(d && d.data !== undefined ? d : d);
    if (!items.length) return false;
    if (period === 'quarterly') return finItemsHaveQ2(items);
    return finItemsHaveFY(items, 2025);
  } catch (_) { return false; }
}

function writeJsonAtomic(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

function parseP1(item) {
  // "TICKER/REPORT-period"
  const m = String(item || '').match(/^([A-Z0-9.-]{2,12})\/([A-Z_]+)-(quarterly|annually)$/);
  if (!m) return null;
  return { ticker: m[1], report: m[2], period: m[3] };
}

function parseCell(item) {
  // "TICKER@YYYY-MM-DD"
  const m = String(item || '').match(/^([A-Z0-9.-]{2,12})@(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return { ticker: m[1], date: m[2] };
}

async function fetchFinancial(ticker, report, period, apiKey) {
  const qs = new URLSearchParams({ report_type: report, period, limit: '8' });
  const url = 'https://stock.arjum.com/api/financial-statements/' + encodeURIComponent(ticker) + '?' + qs.toString();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, 25000) : null;
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', 'User-Agent': 'AutoCuan-QuotaBurn/1.0' },
      signal: controller ? controller.signal : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'fetch-error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runLocalCompiler(batchTickers, hadBroksum, hadFundamental) {
  // Kompilator lokal tiap batch: domestik+akumulasi untuk broksum, mapper validasi untuk fundamental.
  const uniq = Array.from(new Set(batchTickers)).slice(0, 50);
  if (hadBroksum && uniq.length) {
    try {
      const r = spawnSync(process.execPath, [
        path.join(ROOT, 'tools', 'build-domestic-broksum-and-accum.js'),
        '--apply', '--tickers=' + uniq.join(','), '--skip-hunter'
      ], { cwd: ROOT, timeout: 120000, encoding: 'utf8' });
      if (r.status !== 0) console.log('[quota-burn] compiler domestic exit=' + r.status);
    } catch (e) {
      console.log('[quota-burn] compiler domestic error: ' + (e && e.message));
    }
  }
  if (hadFundamental && uniq.length) {
    try {
      const r = spawnSync(process.execPath, [
        path.join(ROOT, 'tools', 'import-financial-statements.js'),
        '--dry-run', '--ticker', uniq.slice(0, 10).join(',')
      ], { cwd: ROOT, timeout: 120000, encoding: 'utf8' });
      if (r.status !== 0) console.log('[quota-burn] mapper fundamental exit=' + r.status);
    } catch (e) {
      console.log('[quota-burn] mapper fundamental error: ' + (e && e.message));
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startIso = wibIsoNow();
  const startMs = Date.now();
  const now0 = new Date();
  const cfg = quotaState.loadConfig();
  const floor = opts.floor != null ? opts.floor : quotaState.reserveFloorFor(now0, cfg);
  const snap0 = quotaState.getQuotaSnapshot(now0);
  const spendable0 = Math.max(0, snap0.remaining - floor);
  let budget = spendable0;
  if (opts.maxRequests != null) budget = Math.min(budget, opts.maxRequests);
  console.log('[quota-burn] P4 start limit=' + snap0.limit + ' used=' + snap0.used + ' remaining=' + snap0.remaining + ' floor=' + floor + ' spendable=' + spendable0 + ' budget=' + budget + ' dryRun=' + opts.dryRun + ' priorities=' + opts.priorities.join(','));

  if (hardStopNow()) {
    console.log('[quota-burn] BERHENTI: jendela terlarang WIB (hard stop).');
    writeHeartbeat('FORBIDDEN_WINDOW_SKIP', 0, 0, startIso, 'hard stop 23:50-00:10');
    writeProgress({ startedAt: startIso, finishedAt: wibIsoNow(), spent: 0, stopped: 'FORBIDDEN_WINDOW', floor, limit: snap0.limit, usedBefore: snap0.used });
    return { spent: 0, stopped: 'FORBIDDEN_WINDOW' };
  }
  const gate0 = quotaState.canConsumeQuota(1, opts.jobType, { now: now0, reserveFloor: floor });
  if (!gate0.ok) {
    console.log('[quota-burn] SKIP: gate menolak (' + gate0.reason + ').');
    writeHeartbeat('SCHEDULED_SKIP', 0, 0, startIso, 'gate: ' + gate0.reason);
    writeProgress({ startedAt: startIso, finishedAt: wibIsoNow(), spent: 0, stopped: gate0.reason, floor, limit: snap0.limit, usedBefore: snap0.used });
    return { spent: 0, stopped: gate0.reason };
  }
  if (budget <= 0) {
    console.log('[quota-burn] SKIP: tidak ada budget tersisa di atas floor.');
    writeHeartbeat('SCHEDULED_SKIP', 0, 0, startIso, 'no budget above floor');
    writeProgress({ startedAt: startIso, finishedAt: wibIsoNow(), spent: 0, stopped: 'NO_BUDGET', floor, limit: snap0.limit, usedBefore: snap0.used });
    return { spent: 0, stopped: 'NO_BUDGET' };
  }

  let queue = null;
  try { queue = JSON.parse(fs.readFileSync(opts.queue, 'utf8')); } catch (e) {
    console.log('[quota-burn] FATAL: antrean tidak terbaca: ' + opts.queue);
    writeHeartbeat('ERROR', 1, 0, startIso, 'queue unreadable');
    return { spent: 0, stopped: 'QUEUE_MISSING' };
  }
  const itemsByP = (queue && queue.items) || {};
  const ordered = [];
  for (const p of opts.priorities) {
    const arr = Array.isArray(itemsByP[p]) ? itemsByP[p] : [];
    for (const it of arr) ordered.push({ priority: p, item: it });
  }
  const tickerFilter = opts.tickers && opts.tickers.length ? new Set(opts.tickers) : null;
  const apiKey = opts.dryRun ? '' : loadEnvApiKey();
  // Ekspor ke process.env agar lib/arjum-client.js (fetchBrokerSummary P2/P3) ikut memakai
  // kunci yang sama bila proses dijalankan langsung tanpa job-wrapper (cron memuat .env via source).
  if (apiKey && !process.env.ARJUM_API_KEY) process.env.ARJUM_API_KEY = apiKey;
  if (!opts.dryRun && !apiKey) {
    console.log('[quota-burn] FATAL: kunci API tidak tersedia (cek nama variabel ARJUM_API_KEY).');
    writeHeartbeat('ERROR', 1, 0, startIso, 'api key missing');
    return { spent: 0, stopped: 'NO_API_KEY' };
  }

  let spent = 0;
  let skipped = 0;
  let failed = 0;
  let stopped = null;
  let batchTickers = [];
  let batchHadBroksum = false;
  let batchHadFundamental = false;
  let batchCount = 0;

  async function flushBatch() {
    if (!batchTickers.length) return;
    if (!opts.dryRun && !opts.noCompile) runLocalCompiler(batchTickers, batchHadBroksum, batchHadFundamental);
    batchCount += 1;
    const snap = quotaState.getQuotaSnapshot(new Date());
    writeHeartbeat('OK', 0, spent, startIso, 'batch=' + batchCount + ' spent=' + spent);
    writeProgress({ startedAt: startIso, updatedAt: wibIsoNow(), spent, skipped, failed, stopped: stopped || ('RUNNING batch=' + batchCount), floor, limit: snap.limit, usedNow: snap.used, priorities: opts.priorities });
    batchTickers = [];
    batchHadBroksum = false;
    batchHadFundamental = false;
  }

  for (const entry of ordered) {
    if (spent >= budget) { stopped = 'BUDGET_REACHED'; break; }
    if (hardStopNow()) { stopped = 'FORBIDDEN_WINDOW'; break; }
    const gate = quotaState.canConsumeQuota(1, opts.jobType, { now: new Date(), reserveFloor: floor });
    if (!gate.ok) { stopped = gate.reason; break; }

    const { priority, item } = entry;
    if (priority === 'P1') {
      const p = parseP1(item);
      if (!p) { skipped += 1; continue; }
      if (tickerFilter && !tickerFilter.has(p.ticker)) { skipped += 1; continue; }
      const fp = path.join(FIN_DIR, p.ticker, p.report + '-' + p.period + '.json');
      if (isP1FileFresh(fp, p.period)) { skipped += 1; continue; }
      if (opts.dryRun) { spent += 1; batchTickers.push(p.ticker); batchHadFundamental = true; }
      else {
        const res = await fetchFinancial(p.ticker, p.report, p.period, apiKey);
        // Catat pemakaian kuota untuk tiap request jaringan (sukses/gagal terkirim).
        try {
          quotaState.syncFromUpstream({ cost: 1 });
          if (quotaTracker && typeof quotaTracker.recordUsage === 'function') quotaTracker.recordUsage(1);
        } catch (_) {}
        spent += 1;
        if (res && res.ok && res.data) {
          try {
            writeJsonAtomic(fp, { ticker: p.ticker, report_type: p.report, period: p.period, requested_limit: 8, collected_at: new Date().toISOString(), data: res.data });
          } catch (_) { failed += 1; }
        } else {
          failed += 1;
          const msg = String((res && (res.error || res.status)) || 'upstream-error');
          if (/429|quota|rate/i.test(msg)) {
            try { if (arjumClient && typeof arjumClient.tripCircuitBreaker === 'function') arjumClient.tripCircuitBreaker(msg); } catch (_) {}
            stopped = 'QUOTA_EXCEEDED';
            await flushBatch();
            break;
          }
        }
        batchTickers.push(p.ticker);
        batchHadFundamental = true;
      }
    } else {
      const c = parseCell(item);
      if (!c) { skipped += 1; continue; }
      if (tickerFilter && !tickerFilter.has(c.ticker)) { skipped += 1; continue; }
      const isF = priority === 'P3' || priority === 'P4';
      const dir = isF ? F_DIR : ALL_DIR;
      const flow = isF ? 'F' : 'all';
      const fp = path.join(dir, c.ticker, c.date + '.json');
      if (isValidJsonFile(fp)) { skipped += 1; continue; }
      if (opts.dryRun) { spent += 1; batchTickers.push(c.ticker); batchHadBroksum = true; }
      else {
        let res = null;
        try {
          res = await arjumClient.fetchBrokerSummary(c.ticker, c.date, flow, null, {
            allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true, jobType: opts.jobType
          });
        } catch (e) {
          res = { ok: false, error: (e && e.message) || 'client-error' };
        }
        // fetchBrokerSummary sudah mencatat kuota via fetchArjum; jangan catat ganda.
        // Hanya hitung spent bila request benar-benar terkirim (bukan gate lokal).
        if (res && res.quotaGate && res.quotaGate.ok === false) { stopped = res.quotaGate.reason || 'QUOTA_GATE'; await flushBatch(); break; }
        if (res && res.rateLimited && res.quotaGate) { stopped = 'QUOTA_EXCEEDED'; await flushBatch(); break; }
        spent += 1;
        if (res && res.ok && res.data) {
          try { writeJsonAtomic(fp, res.data); } catch (_) { failed += 1; }
        } else {
          failed += 1;
          const cls = arjumClient && typeof arjumClient.classifyFailure === 'function' ? arjumClient.classifyFailure(res) : { reason: 'api_error' };
          if (cls.reason === 'quota_exceeded') { stopped = 'QUOTA_EXCEEDED'; await flushBatch(); break; }
        }
        batchTickers.push(c.ticker);
        batchHadBroksum = true;
      }
    }

    if ((spent + skipped) % opts.batch === 0 || batchTickers.length >= opts.batch) await flushBatch();
  }
  await flushBatch();

  const snap1 = quotaState.getQuotaSnapshot(new Date());
  const durMs = Date.now() - startMs;
  const status = stopped ? (stopped === 'BUDGET_REACHED' || stopped === 'NO_BUDGET' ? 'OK' : 'OK') : 'OK';
  writeHeartbeat(status, 0, spent, startIso, stopped ? ('stopped=' + stopped) : ('done spent=' + spent));
  writeProgress({ startedAt: startIso, finishedAt: wibIsoNow(), durationMs: durMs, spent, skipped, failed, stopped: stopped || 'DONE', floor, limit: snap1.limit, usedBefore: snap0.used, usedNow: snap1.used, priorities: opts.priorities, budget });
  console.log('[quota-burn] DONE spent=' + spent + ' skipped=' + skipped + ' failed=' + failed + ' stopped=' + (stopped || 'DONE') + ' used=' + snap1.used + '/' + snap1.limit + ' remaining=' + snap1.remaining);
  return { spent, skipped, failed, stopped: stopped || 'DONE' };
}

if (require.main === module) {
  main().then(() => { process.exitCode = 0; }).catch((e) => { console.error('[quota-burn] Fatal:', e && e.message ? e.message : e); process.exitCode = 1; });
}

module.exports = { parseArgs, QUEUE_PATH, HEARTBEAT_PATH, PROGRESS_PATH };
