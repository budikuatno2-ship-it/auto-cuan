'use strict';

/**
 * Collector Done Details — Order Flow & Transaction-Level LPM (Tahap 1)
 * =====================================================================
 * CLI Usage:
 *   node collect-done.js --date 2026-10-16 --codes BRPT,MEDC --budget 400 [--dry-run]
 *   node collect-done.js --date 2026-10-16 --auto --budget 1500 [--dry-run]
 *
 * Strict Compliance:
 * - Built-in Node modules only (https, zlib, fs, path, child_process).
 * - GET requests only, max 2 req/sec (min 650ms delay).
 * - Never logs or prints API keys.
 * - Stops automatically if x-ratelimit-remaining drops below 1,500.
 * - Max budget capped at 50% of starting remaining quota.
 * - Resumable state per date in state/<date>.json.
 * - Raw data gzipped in raw/<date>/<CODE>.jsonl.gz.
 * - Daily RG aggregate saved in agg/<date>.json.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { aggregateDoneDetails } = require('./aggregate');

const BASE_DIR = __dirname;
const STATE_DIR = path.join(BASE_DIR, 'state');
const RAW_DIR = path.join(BASE_DIR, 'raw');
const AGG_DIR = path.join(BASE_DIR, 'agg');

[STATE_DIR, RAW_DIR, AGG_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const BASE_URL = 'https://stock.arjum.com';
const MIN_REMAINING_SAFETY = 1500;
const RATE_LIMIT_DELAY_MS = 650;

let memoryApiKey = null;

function getApiKey() {
  if (memoryApiKey) return memoryApiKey;
  // Securely fetch active authentic key into memory from VPS via SSH
  try {
    const remoteCmd = `node -e "const fs=require('fs');for(const f of ['/home/ubuntu/auto-cuan-runner/.env','/home/ubuntu/auto-cuan/.env']){if(fs.existsSync(f)){const m=fs.readFileSync(f,'utf8').match(/^ARJUM_API_KEY=(.*)$/m);if(m){process.stdout.write(m[1].trim().replace(/^['\\\"]|['\\\"]$/g,''));break;}}}"`;
    const key = execFileSync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-i', SSH_KEY_PATH,
      VPS_HOST,
      remoteCmd
    ], { encoding: 'utf8' }).trim();
    if (key && key.length > 20) memoryApiKey = key;
  } catch (_) {}

  // Fallback to local .env if SSH failed
  if (!memoryApiKey) {
    try {
      const envPath = path.join(BASE_DIR, '..', '..', '.env');
      if (fs.existsSync(envPath)) {
        const m = fs.readFileSync(envPath, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
        if (m && m[1].trim()) memoryApiKey = m[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch (_) {}
  }

  if (!memoryApiKey) {
    throw new Error('ARJUM_API_KEY could not be loaded into memory');
  }
  return memoryApiKey;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    date: '2026-10-16',
    codes: [],
    auto: false,
    budget: null,
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--date' && args[i + 1]) {
      options.date = args[++i];
    } else if (a === '--codes' && args[i + 1]) {
      options.codes = args[++i].split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    } else if (a === '--auto') {
      options.auto = true;
    } else if (a === '--budget' && args[i + 1]) {
      options.budget = parseInt(args[++i], 10);
    } else if (a === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function loadPriorityList() {
  const pPath = path.join(BASE_DIR, 'priority.txt');
  if (fs.existsSync(pPath)) {
    return fs.readFileSync(pPath, 'utf8')
      .split('\n')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0 && !s.startsWith('#'));
  }
  return ['BRPT', 'MEDC'];
}

function loadState(date) {
  const sPath = path.join(STATE_DIR, `${date}.json`);
  if (fs.existsSync(sPath)) {
    try {
      return JSON.parse(fs.readFileSync(sPath, 'utf8'));
    } catch (_) {}
  }
  return {
    date,
    updatedAt: new Date().toISOString(),
    completedCodes: [],
    inProgress: {}
  };
}

function saveState(date, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(STATE_DIR, `${date}.json`), JSON.stringify(state, null, 2));
}

function loadAggregates(date) {
  const aPath = path.join(AGG_DIR, `${date}.json`);
  if (fs.existsSync(aPath)) {
    try {
      return JSON.parse(fs.readFileSync(aPath, 'utf8'));
    } catch (_) {}
  }
  return {};
}

function saveAggregates(date, aggMap) {
  fs.writeFileSync(path.join(AGG_DIR, `${date}.json`), JSON.stringify(aggMap, null, 2));
}

// Fetch 1 page with retry & backoff
async function fetchDoneDetailsPage(code, date, page, apiKey, maxRetries = 3) {
  const url = `${BASE_URL}/api/done-details?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}&page=${page}&per_page=100`;

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-API-Key': apiKey
        }
      });
      const elapsed = Date.now() - t0;
      const rem = parseInt(res.headers.get('x-ratelimit-remaining'), 10);
      const limit = parseInt(res.headers.get('x-ratelimit-limit'), 10);

      if (res.status === 429 || res.status >= 500) {
        console.warn(`    [Retry ${attempt}/${maxRetries}] HTTP ${res.status} on ${code} p.${page}. Backoff...`);
        await sleep(1500 * attempt);
        continue;
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }

      const body = await res.json();
      await sleep(RATE_LIMIT_DELAY_MS);

      return {
        ok: true,
        status: res.status,
        elapsedMs: elapsed,
        remaining: Number.isFinite(rem) ? rem : null,
        limit: Number.isFinite(limit) ? limit : null,
        data: body
      };
    } catch (err) {
      if (attempt >= maxRetries) {
        return { ok: false, status: 0, error: err.message };
      }
      await sleep(1000 * attempt);
    }
  }

  return { ok: false, status: 0, error: 'Max retries exhausted' };
}

// Estimate pages from turnover or daily candles cache if available
function estimatePages(code, date) {
  // Check if we have page 1 state or raw cache
  const candlePath = path.join(BASE_DIR, '..', 'dua-skenario', 'data', 'all', `${code}.json`);
  if (fs.existsSync(candlePath)) {
    try {
      const candles = JSON.parse(fs.readFileSync(candlePath, 'utf8'));
      const c = candles.find(x => x.date === date);
      if (c && c.volume && c.close) {
        const turn = c.volume * c.close;
        // Estimated transactions: roughly turnover / 25M
        const estTrx = Math.max(10, Math.round(turn / 25000000));
        return {
          turnover: turn,
          estTransactions: estTrx,
          estPages: Math.max(1, Math.ceil(estTrx / 100))
        };
      }
    } catch (_) {}
  }
  return { turnover: 0, estTransactions: 1000, estPages: 10 };
}

async function main() {
  const opts = parseCliArgs();
  console.log('====================================================');
  console.log(`COLLECT DONE DETAILS — DATE: ${opts.date}`);
  console.log(`MODE: ${opts.auto ? 'AUTO (Prioritized Universe)' : 'SPECIFIC CODES'}`);
  console.log(`DRY-RUN: ${opts.dryRun ? 'YES (No downloads)' : 'NO (Live collection)'}`);
  console.log('====================================================\n');

  // 1. Initial probe to check quota window & starting remaining
  console.log('[1/4] Checking live quota status...');
  let startingRemaining = 4400;
  let startingLimit = 6328;
  const key = getApiKey();

  if (!opts.dryRun) {
    const probe = await fetchDoneDetailsPage('BRPT', opts.date, 1, key);
    if (probe.ok) {
      startingRemaining = probe.remaining || startingRemaining;
      startingLimit = probe.limit || startingLimit;
    }
  }

  const safeBudgetCeiling = Math.floor(startingRemaining * 0.50);
  let effectiveBudget = opts.budget ? Math.min(opts.budget, safeBudgetCeiling) : safeBudgetCeiling;

  console.log(`  Live Quota Limit:     ${startingLimit}`);
  console.log(`  Current Remaining:    ${startingRemaining}`);
  console.log(`  Max 50% Safe Budget:  ${safeBudgetCeiling} requests`);
  console.log(`  Effective Budget:     ${effectiveBudget} requests\n`);

  if (startingRemaining < MIN_REMAINING_SAFETY) {
    console.warn(`[SAFETY TRIGGERED] Sisa kuota ${startingRemaining} < ${MIN_REMAINING_SAFETY}. Pengumpulan dibatalkan untuk menjaga operasional produksi.`);
    process.exit(0);
  }

  // 2. Build target codes list
  let targetCodes = [];
  if (opts.codes && opts.codes.length > 0) {
    targetCodes = opts.codes;
  } else if (opts.auto) {
    const priorityList = loadPriorityList();
    const allDir = path.join(BASE_DIR, '..', 'dua-skenario', 'data', 'all');
    let liquidCandidates = [];

    if (fs.existsSync(allDir)) {
      const files = fs.readdirSync(allDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
      for (const f of files) {
        const tk = f.replace('.json', '');
        const est = estimatePages(tk, opts.date);
        if (est.turnover >= 1e9) { // >= Rp 1 Miliar
          liquidCandidates.push({ ticker: tk, turnover: est.turnover, estPages: est.estPages });
        }
      }
      // Sort liquid candidates: fewest pages first (most cost-effective)
      liquidCandidates.sort((a, b) => a.estPages - b.estPages);
    }

    // Merge: Priority first, then liquid candidates (excluding duplicates and BBCA unless explicitly requested)
    const seen = new Set();
    for (const p of priorityList) {
      if (!seen.has(p)) {
        seen.add(p);
        targetCodes.push(p);
      }
    }
    for (const l of liquidCandidates) {
      if (!seen.has(l.ticker) && l.ticker !== 'BBCA') { // rule: omit BBCA from auto refill due to 1850 pages
        seen.add(l.ticker);
        targetCodes.push(l.ticker);
      }
    }
  }

  console.log(`[2/4] Target Universe: ${targetCodes.length} tickers.`);

  // 3. Prepare Queue and Plan (Dry-Run or Execution)
  const state = loadState(opts.date);
  const aggregates = loadAggregates(opts.date);

  const plan = [];
  let plannedRequests = 0;

  for (const code of targetCodes) {
    if (state.completedCodes.includes(code)) {
      continue; // already collected
    }
    const est = estimatePages(code, opts.date);
    let neededPages = est.estPages;

    if (state.inProgress[code] && state.inProgress[code].totalPages) {
      neededPages = state.inProgress[code].totalPages - (state.inProgress[code].downloadedPages?.length || 0);
    }

    if (plannedRequests + neededPages > effectiveBudget) {
      if (plannedRequests === 0) {
        plan.push({ code, estPages: neededPages, fits: false });
      }
      break;
    }

    plan.push({ code, estPages: neededPages, fits: true });
    plannedRequests += neededPages;
  }

  console.log('\n--- COLLECTION PLAN ---');
  console.log(`Planned Stocks to Process: ${plan.filter(p => p.fits).length}`);
  console.log(`Total Planned Requests:    ${plannedRequests}`);
  console.log(`Estimated Download Time:   ${Math.round(plannedRequests * 0.65)}s (~${(plannedRequests * 0.65 / 60).toFixed(1)} mins)`);
  console.log('List of Stocks:');
  plan.forEach((p, idx) => {
    console.log(`  ${idx + 1}. ${p.code} (est. ${p.estPages} pages) [${p.fits ? 'WILL COLLECT' : 'SKIPPED: OVER BUDGET'}]`);
  });

  if (opts.dryRun) {
    console.log('\n[DRY RUN COMPLETE] No requests made or files saved.');
    return;
  }

  // 4. Live Collection Execution
  console.log('\n[3/4] Starting live collection...');
  let usedInRun = 0;
  let currentRemaining = startingRemaining;

  const dateRawDir = path.join(RAW_DIR, opts.date);
  if (!fs.existsSync(dateRawDir)) fs.mkdirSync(dateRawDir, { recursive: true });

  for (const item of plan) {
    if (!item.fits) continue;
    const code = item.code;

    if (usedInRun >= effectiveBudget || currentRemaining < MIN_REMAINING_SAFETY) {
      console.warn(`[BUDGET STOP] Reached budget limit (${usedInRun}/${effectiveBudget}) or safety threshold (${currentRemaining}).`);
      break;
    }

    console.log(`\n>>> Collecting ${code} on ${opts.date}...`);

    // Initialize or load inProgress state
    if (!state.inProgress[code]) {
      state.inProgress[code] = {
        totalRecords: null,
        totalPages: null,
        downloadedPages: [],
        rowsCount: 0
      };
    }
    const prog = state.inProgress[code];

    // Read existing rows if resuming
    const rawGzPath = path.join(dateRawDir, `${code}.jsonl.gz`);
    let collectedRows = [];
    if (fs.existsSync(rawGzPath)) {
      try {
        const decomp = zlib.gunzipSync(fs.readFileSync(rawGzPath)).toString('utf8');
        collectedRows = decomp.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      } catch (_) {
        collectedRows = [];
      }
    }

    // Fetch page 1 first to determine totalPages if not known
    let startPage = 1;
    if (!prog.totalPages) {
      const p1Res = await fetchDoneDetailsPage(code, opts.date, 1, key);
      usedInRun++;
      if (p1Res.remaining != null) currentRemaining = p1Res.remaining;

      if (!p1Res.ok) {
        console.error(`  Failed to fetch ${code} page 1: ${p1Res.error}`);
        continue;
      }

      prog.totalRecords = p1Res.data.total;
      prog.totalPages = p1Res.data.total_pages;
      if (!prog.downloadedPages.includes(1)) {
        prog.downloadedPages.push(1);
        collectedRows.push(...(p1Res.data.data || []));
      }
      saveState(opts.date, state);
      startPage = 2;
    }

    console.log(`  Total pages: ${prog.totalPages} (${prog.totalRecords} records). Starting from page ${startPage}...`);

    for (let p = startPage; p <= prog.totalPages; p++) {
      if (prog.downloadedPages.includes(p)) continue;
      if (usedInRun >= effectiveBudget || currentRemaining < MIN_REMAINING_SAFETY) {
        console.warn(`  [BUDGET PAUSE] Stopping mid-download at page ${p}. State saved for resume.`);
        break;
      }

      const pageRes = await fetchDoneDetailsPage(code, opts.date, p, key);
      usedInRun++;
      if (pageRes.remaining != null) currentRemaining = pageRes.remaining;

      if (!pageRes.ok) {
        console.error(`  Error on page ${p}: ${pageRes.error}`);
        break;
      }

      const rows = pageRes.data.data || [];
      collectedRows.push(...rows);
      prog.downloadedPages.push(p);

      if (p % 10 === 0 || p === prog.totalPages) {
        console.log(`    Page ${p}/${prog.totalPages} collected (${collectedRows.length} rows so far). Remaining quota: ${currentRemaining}`);
        // Save intermediate raw gzip
        const jsonl = collectedRows.map(r => JSON.stringify(r)).join('\n');
        fs.writeFileSync(rawGzPath, zlib.gzipSync(Buffer.from(jsonl, 'utf8')));
        saveState(opts.date, state);
      }
    }

    // Finalize ticker collection if all pages downloaded
    if (prog.downloadedPages.length === prog.totalPages) {
      console.log(`  Validating ${code}: ${collectedRows.length} rows collected vs ${prog.totalRecords} total reported.`);
      // Compress and save final raw data
      const jsonl = collectedRows.map(r => JSON.stringify(r)).join('\n');
      fs.writeFileSync(rawGzPath, zlib.gzipSync(Buffer.from(jsonl, 'utf8')));

      // Calculate daily aggregate and save to agg/<date>.json
      const agg = aggregateDoneDetails(collectedRows);
      if (agg) {
        aggregates[code] = agg;
        saveAggregates(opts.date, aggregates);
        console.log(`  Saved daily aggregate for ${code}: ${agg.n} RG trx, val Rp ${(agg.val/1e9).toFixed(2)}M, vwap ${agg.vwap}, buyAgg ${(agg.buyAggVal/agg.val*100).toFixed(1)}%`);
      }

      state.completedCodes.push(code);
      delete state.inProgress[code];
      saveState(opts.date, state);
    }
  }

  console.log('\n====================================================');
  console.log('COLLECTION BATCH FINISHED');
  console.log(`Total Requests Used in Run: ${usedInRun}`);
  console.log(`Final Remaining Quota:      ${currentRemaining}`);
  console.log(`Completed Codes on ${opts.date}: ${state.completedCodes.join(', ')}`);
  console.log('====================================================\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  fetchDoneDetailsPage,
  parseCliArgs,
  estimatePages
};
