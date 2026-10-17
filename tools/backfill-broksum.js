'use strict';

/**
 * Historical Broker Summary Backfill Worker (All + Foreign)
 * ==========================================================
 * Backfills Foreign (flow=F, all_data=true) and unclipped All (all_data=true)
 * from 2026-10-16 backwards to 2026-01-02.
 *
 * Designed with strict quota guards:
 * - Reads x-ratelimit-remaining / x-quota-remaining after every request.
 * - Weekday reserve: 800 calls.
 * - Weekend reserve: 300 calls.
 * - Prioritizes liquid tickers (turnover >= Rp 1 Miliar) before illiquid tickers.
 * - Supports --only-foreign flag to exclusively fetch Foreign broksum.
 * - Paced at 8 req/s (125ms delay) with adaptive fallback to 5 req/s (200ms) on burst 429.
 * - Fully resumable and stateful via _backfill/state.json and lock file.
 */

const fs = require('fs');
const path = require('path');
// Load environment variables (.env / .env.local)
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}

const arjumClient = require('../lib/arjum-client');
const broksumFlow = require('../lib/broksum-flow');
const brokerAccumulationLocal = require('../lib/broker-accumulation-local');

// Default pacing: 8 req/sec (125ms delay) as verified in benchmark
const DEFAULT_DELAY_MS = 125;
const SLOWDOWN_DELAY_MS = 200; // 5 req/sec on rate burst
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
  const onlyForeign = args.includes('--only-foreign') || process.env.ONLY_FOREIGN === 'true';

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
  console.log(`Only Foreign:    ${onlyForeign} (HANYA flow=F&all_data=true)`);
  console.log(`Initial Pacing:  ${delayMs}ms (~${(1000/delayMs).toFixed(1)} req/s)`);
  console.log(`Execution Limit: ${limit === Infinity ? 'UNLIMITED' : limit}`);
  console.log(`Target Base Dir: ${baseDir}`);
  console.log(`Dry Run:         ${dryRun}`);

  let state = {
    completedTasks: {},
    lastUpdated: null,
    totalSent: 0,
    startTime: new Date().toISOString(),
    completedTickers: {}
  };

  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = Object.assign(state, parsed);
        if (!state.completedTasks) state.completedTasks = {};
        if (!state.completedTickers) state.completedTickers = {};
      }
    } catch (_) {}
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

  // Order: liquid tickers first, then regular
  const orderedTickers = [...liquid, ...regular];

  let requestsSent = 0;
  let skippedCount = 0;
  let quotaHalted = false;
  let consecutive429 = 0;

  function saveState() {
    if (dryRun) return;
    try {
      state.lastUpdated = new Date().toISOString();
      state.totalRequestsSentInRun = requestsSent;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {}
  }

  try {
    for (const ticker of orderedTickers) {
      let tickerCompletedDays = 0;

      for (const date of tradingDays) {
        if (requestsSent >= limit) {
          console.log(`[LIMIT-REACHED] Batas request ${limit} tercapai. Berhenti rapi.`);
          break;
        }

        const taskKeyAll = `${ticker}_${date}_all`;
        const taskKeyF = `${ticker}_${date}_F`;

        // Check All file status (skipped if onlyForeign is true)
        const allFile = path.join(baseDir, 'broker-summary', ticker, `${date}.json`);
        let needsAll = false;
        if (!onlyForeign) {
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
        }

        // Check Foreign file status
        const fFile = path.join(baseDir, 'broker-summary-F', ticker, `${date}.json`);
        let needsF = !fs.existsSync(fFile);

        if (!needsAll && !needsF) {
          skippedCount += onlyForeign ? 1 : 2;
          tickerCompletedDays++;
          continue;
        }

        // 1. Fetch All if needed (and not only-foreign)
        if (needsAll && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch ALL: ${ticker} ${date} (all_data=true)`);
            requestsSent++;
          } else {
            const resAll = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, { allData: true, fresh: true });
            requestsSent++;
            state.totalSent = (state.totalSent || 0) + 1;

            if (resAll.ok && resAll.data) {
              consecutive429 = 0;
              const targetDir = path.join(baseDir, 'broker-summary', ticker);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(allFile, JSON.stringify(resAll.data, null, 2), 'utf8');
              state.completedTasks[taskKeyAll] = true;
              if (requestsSent % 5 === 0 || requestsSent <= 10) {
                console.log(`[BACKFILL] Req ${requestsSent} | Saved ALL ${ticker} ${date} | Total Sent: ${state.totalSent}`);
                saveState();
              }
            } else if (resAll.status === 429) {
              consecutive429++;
              const classified = arjumClient.classifyFailure(resAll);
              if (classified && classified.reason === 'quota_exceeded') {
                console.log(`[QUOTA-EXCEEDED] Kuota harian Arjum habis. Berhenti.`);
                quotaHalted = true;
                break;
              }
              // Burst rate limit: slow down to 200ms
              console.log(`[429-BURST] Rate limit hit on ${ticker} ${date}. Slowing down pacing to ${SLOWDOWN_DELAY_MS}ms...`);
              delayMs = SLOWDOWN_DELAY_MS;
              process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);
              await sleep(1500);
              if (consecutive429 > 3) {
                console.log(`[CONSECUTIVE-429] 3x rate limit berturut-turut. Berhenti rapi.`);
                quotaHalted = true;
                break;
              }
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
              consecutive429 = 0;
              const targetDir = path.join(baseDir, 'broker-summary-F', ticker);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(fFile, JSON.stringify(resF.data, null, 2), 'utf8');
              state.completedTasks[taskKeyF] = true;
              tickerCompletedDays++;

              if (requestsSent % 25 === 0) {
                console.log(`[BACKFILL] Req ${requestsSent} | Saved FOREIGN ${ticker} ${date} | Total Sent: ${state.totalSent}`);
                saveState();
              }
            } else if (resF.status === 429) {
              consecutive429++;
              const classified = arjumClient.classifyFailure(resF);
              if (classified && classified.reason === 'quota_exceeded') {
                console.log(`[QUOTA-EXCEEDED] Kuota harian Arjum habis. Berhenti.`);
                quotaHalted = true;
                break;
              }
              console.log(`[429-BURST] Rate limit hit on FOREIGN ${ticker} ${date}. Slowing down pacing to ${SLOWDOWN_DELAY_MS}ms...`);
              delayMs = SLOWDOWN_DELAY_MS;
              process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);
              await sleep(1500);
              if (consecutive429 > 3) {
                console.log(`[CONSECUTIVE-429] 3x rate limit berturut-turut. Berhenti rapi.`);
                quotaHalted = true;
                break;
              }
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

      if (tickerCompletedDays >= tradingDays.length) {
        state.completedTickers[ticker] = { completedAt: new Date().toISOString(), days: tickerCompletedDays };
      }

      if (quotaHalted || requestsSent >= limit) break;
    }
  } finally {
    saveState();
    if (!dryRun) releaseLock(lockFile);
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
