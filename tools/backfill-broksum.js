'use strict';

/**
 * Historical Broker Summary Backfill Worker (All + Foreign)
 * ==========================================================
 * Backfills unclipped All (all_data=true) and Foreign (flow=F, all_data=true)
 * from 2026-10-16 backwards to 2026-01-02.
 *
 * Designed with strict quota guards:
 * - Reads x-ratelimit-remaining / x-quota-remaining after every request.
 * - Weekday reserve: 800 calls.
 * - Weekend reserve: 300 calls.
 * - Prioritizes liquid tickers (turnover >= Rp 1 Miliar) before illiquid tickers.
 * - Fully resumable and stateful via _backfill/state.json and lock file.
 */

const fs = require('fs');
const path = require('path');
const arjumClient = require('../lib/arjum-client');
const broksumFlow = require('../lib/broksum-flow');
const brokerAccumulationLocal = require('../lib/broker-accumulation-local');

// Pacing determined from Langkah 1 empirical speed test: 5.6 req/s (~180ms delay)
const DEFAULT_DELAY_MS = 180;
const WEEKDAY_RESERVE = 800;
const WEEKEND_RESERVE = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBaseDir(overrideDir) {
  if (overrideDir) return overrideDir;
  return process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
}

function getLockPath(baseDir) {
  const dir = path.join(baseDir, '_backfill');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'backfill.lock');
}

function getStatePath(baseDir) {
  const dir = path.join(baseDir, '_backfill');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'state.json');
}

function acquireLock(lockFile) {
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (info && info.pid) {
          try {
            process.kill(info.pid, 0);
            return false;
          } catch (_) {
            fs.unlinkSync(lockFile);
            return acquireLock(lockFile);
          }
        }
      } catch (_) {
        try { fs.unlinkSync(lockFile); } catch (_) {}
      }
    }
    return false;
  }
}

function releaseLock(lockFile) {
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {}
}

function backupClippedBroksum(baseDir, ticker, date, content) {
  try {
    const bkpDir = path.join(baseDir, '_backup-broksum-25', ticker);
    const bkpFile = path.join(bkpDir, `${date}.json`);
    if (!fs.existsSync(bkpFile)) {
      fs.mkdirSync(bkpDir, { recursive: true });
      fs.writeFileSync(bkpFile, content, 'utf8');
    }
  } catch (_) {}
}

function loadTradingDays(candlesDir) {
  try {
    const brptPath = path.join(candlesDir, 'BRPT.json');
    if (fs.existsSync(brptPath)) {
      const data = JSON.parse(fs.readFileSync(brptPath, 'utf8'));
      const list = (data.candles || []).filter(c => c.date >= '2026-01-02' && c.date <= '2026-10-16').map(c => c.date);
      if (list.length > 0) return list.sort().reverse(); // newest first
    }
  } catch (_) {}
  return [];
}

function categorizeTickersByLiquidity(baseDir, candlesDir, tickers) {
  const liquid = [];
  const regular = [];

  tickers.forEach(tk => {
    let avgTurnover = 0;
    try {
      const cFile = path.join(candlesDir, `${tk}.json`);
      if (fs.existsSync(cFile)) {
        const cd = JSON.parse(fs.readFileSync(cFile, 'utf8'));
        const inRange = (cd.candles || []).filter(c => c.date >= '2026-01-02' && c.date <= '2026-10-16');
        if (inRange.length > 0) {
          const sum = inRange.reduce((acc, c) => acc + (c.volume * c.close), 0);
          avgTurnover = sum / inRange.length;
        }
      }
    } catch (_) {}

    if (avgTurnover >= 1000000000) {
      liquid.push({ ticker: tk, avgTurnover });
    } else {
      regular.push({ ticker: tk, avgTurnover });
    }
  });

  liquid.sort((a, b) => b.avgTurnover - a.avgTurnover);
  return {
    liquid: liquid.map(x => x.ticker),
    regular: regular.map(x => x.ticker)
  };
}

async function run(argv) {
  const args = argv || process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  let limit = Infinity;
  for (const a of args) {
    if (a.startsWith('--limit=')) limit = parseInt(a.slice(8), 10) || Infinity;
  }
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) limit = parseInt(args[limitIdx + 1], 10) || Infinity;

  let delayMs = DEFAULT_DELAY_MS;
  for (const a of args) {
    if (a.startsWith('--delay=')) delayMs = parseInt(a.slice(8), 10) || DEFAULT_DELAY_MS;
  }
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) delayMs = parseInt(args[delayIdx + 1], 10) || DEFAULT_DELAY_MS;

  let overrideTargetDir = null;
  for (const a of args) {
    if (a.startsWith('--target-dir=')) overrideTargetDir = a.slice(13);
  }
  const targetDirIdx = args.indexOf('--target-dir');
  if (targetDirIdx >= 0 && args[targetDirIdx + 1]) overrideTargetDir = args[targetDirIdx + 1];

  let mode = null;
  for (const a of args) {
    if (a.startsWith('--mode=')) mode = a.slice(7);
  }
  const modeIdx = args.indexOf('--mode');
  if (modeIdx >= 0 && args[modeIdx + 1]) mode = args[modeIdx + 1];

  if (!mode) {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    mode = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
  }

  // Set Arjum throttle delay in process env so client throttle queue matches worker pacing
  process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);

  const reserveQuota = mode === 'weekend' ? WEEKEND_RESERVE : WEEKDAY_RESERVE;
  const baseDir = getBaseDir(overrideTargetDir);
  const candlesDir = path.join(process.cwd(), 'data', 'daily-candles');
  const lockFile = getLockPath(baseDir);
  const stateFile = getStatePath(baseDir);

  if (!dryRun) {
    if (!acquireLock(lockFile)) {
      console.log(`[BACKFILL-LOCKED] Worker backfill sedang berjalan di proses lain (lock: ${lockFile}). Keluar rapi.`);
      return { success: false, reason: 'locked' };
    }
  }

  console.log('=== AUTO-CUAN BROKER SUMMARY BACKFILL WORKER ===');
  console.log(`Mode:            ${mode.toUpperCase()} (Reserve Quota: ${reserveQuota})`);
  console.log(`Pacing Delay:    ${delayMs}ms`);
  console.log(`Execution Limit: ${limit === Infinity ? 'UNLIMITED' : limit}`);
  console.log(`Target Dir:      ${baseDir}`);
  console.log(`Dry Run:         ${dryRun}`);

  let state = { completedTasks: {}, lastUpdated: null, totalSent: 0 };
  if (fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  }

  const tradingDays = loadTradingDays(candlesDir);
  console.log(`Trading days in scope: ${tradingDays.length} days (${tradingDays[tradingDays.length - 1]} to ${tradingDays[0]})`);

  let universeTickers = [];
  for (const a of args) {
    if (a.startsWith('--tickers=')) {
      universeTickers = a.slice(10).split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }
  }
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    universeTickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  }

  if (universeTickers.length === 0) {
    try {
      const txt = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      if (fs.existsSync(txt)) {
        universeTickers = fs.readFileSync(txt, 'utf8').split(/\r?\n/).map(t => t.trim().toUpperCase()).filter(Boolean);
      }
    } catch (_) {}
  }

  const { liquid, regular } = categorizeTickersByLiquidity(baseDir, candlesDir, universeTickers);
  console.log(`Tickers: ${liquid.length} liquid (turnover >= 1M) + ${regular.length} regular = ${universeTickers.length} total.`);

  const orderedTickers = [...liquid, ...regular];

  let requestsSent = 0;
  let skippedCount = 0;
  let quotaHalted = false;

  try {
    for (const ticker of orderedTickers) {
      for (const date of tradingDays) {
        if (requestsSent >= limit) {
          console.log(`[LIMIT-REACHED] Batas request ${limit} tercapai. Berhenti rapi.`);
          break;
        }

        const taskKeyAll = `${ticker}_${date}_all`;
        const taskKeyF = `${ticker}_${date}_F`;

        // Check All file status
        const allFile = path.join(baseDir, 'broker-summary', ticker, `${date}.json`);
        let needsAll = false;
        if (!fs.existsSync(allFile)) {
          needsAll = true;
        } else {
          try {
            const raw = fs.readFileSync(allFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
              needsAll = true;
              backupClippedBroksum(baseDir, ticker, date, raw);
            }
          } catch (_) {
            needsAll = true;
          }
        }

        // Check Foreign file status
        const fFile = path.join(baseDir, 'broker-summary-F', ticker, `${date}.json`);
        let needsF = !fs.existsSync(fFile);

        if (!needsAll && !needsF) {
          skippedCount += 2;
          continue;
        }

        // 1. Fetch All if needed
        if (needsAll && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch ALL: ${ticker} ${date} (all_data=true)`);
            requestsSent++;
          } else {
            const resAll = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, { allData: true, fresh: true });
            requestsSent++;
            state.totalSent = (state.totalSent || 0) + 1;

            if (resAll.ok && resAll.data) {
              const targetDir = path.join(baseDir, 'broker-summary', ticker);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(allFile, JSON.stringify(resAll.data, null, 2), 'utf8');
              state.completedTasks[taskKeyAll] = true;
              if (requestsSent % 10 === 0) console.log(`[BACKFILL] Req ${requestsSent}/${limit}: Saved ${ticker} ${date} (ALL)`);
            } else if (resAll.status === 429) {
              console.log(`[429-RATE-LIMIT] Kena HTTP 429 pada ${ticker} ${date}. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (resAll.headers && resAll.headers['x-ratelimit-remaining'] != null) {
              const remaining = parseInt(resAll.headers['x-ratelimit-remaining'], 10);
              if (Number.isFinite(remaining) && remaining <= reserveQuota) {
                console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
                quotaHalted = true;
                break;
              }
            }

            await sleep(delayMs);
          }
        }

        if (quotaHalted) break;

        // 2. Fetch Foreign if needed
        if (needsF && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch FOREIGN: ${ticker} ${date} (flow=F, all_data=true)`);
            requestsSent++;
          } else {
            const resF = await arjumClient.fetchBrokerSummary(ticker, date, 'F', null, { allData: true, fresh: true });
            requestsSent++;
            state.totalSent = (state.totalSent || 0) + 1;

            if (resF.ok && resF.data) {
              const targetDir = path.join(baseDir, 'broker-summary-F', ticker);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(fFile, JSON.stringify(resF.data, null, 2), 'utf8');
              state.completedTasks[taskKeyF] = true;
              if (requestsSent % 10 === 0) console.log(`[BACKFILL] Req ${requestsSent}/${limit}: Saved ${ticker} ${date} (FOREIGN)`);
            } else if (resF.status === 429) {
              console.log(`[429-RATE-LIMIT] Kena HTTP 429 pada foreign ${ticker} ${date}. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (resF.headers && resF.headers['x-ratelimit-remaining'] != null) {
              const remaining = parseInt(resF.headers['x-ratelimit-remaining'], 10);
              if (Number.isFinite(remaining) && remaining <= reserveQuota) {
                console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
                quotaHalted = true;
                break;
              }
            }

            await sleep(delayMs);
          }
        }

        if (quotaHalted) break;
      }
      if (quotaHalted || requestsSent >= limit) break;
    }
  } finally {
    if (!dryRun) {
      state.lastUpdated = new Date().toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
      releaseLock(lockFile);
    }
  }

  console.log(`\n=== BACKFILL EXECUTION SUMMARY ===`);
  console.log(`Requests Sent: ${requestsSent}`);
  console.log(`Tasks Skipped: ${skippedCount}`);
  console.log(`Status:        ${quotaHalted ? 'HALTED_BY_BUDGET_OR_QUOTA' : 'COMPLETED_OR_LIMITED'}`);
  return { success: true, requestsSent, skippedCount, quotaHalted };
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal backfill error:', err);
    process.exit(1);
  });
}

module.exports = {
  run,
  categorizeTickersByLiquidity,
  loadTradingDays
};
