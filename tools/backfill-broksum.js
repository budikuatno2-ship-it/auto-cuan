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
const quotaTracker = require('../lib/arjum-quota-tracker');
const broksumValidator = require('../lib/broksum-validator');

// Default pacing: 8 req/sec (125ms delay) as verified in benchmark
const DEFAULT_DELAY_MS = 125;
const SLOWDOWN_DELAY_MS = 200; // 5 req/sec on rate burst
const WEEKDAY_RESERVE = Math.max(800, Number(process.env.BACKFILL_RESERVE_AFTER_EOD) || 800);
const WEEKEND_RESERVE = 300;
// B1: Cadangan backfill sebelum .done = maks(5.000, (kebutuhan sore tertinggi 7 hari + live website) * 1.12).
// Puncak 7 hari: J1 All (962) + F (834) + Accum (834) + Ins (834) + J2 Candle (962) = 4.426 req.
// (4.426 EOD peak + 100 live web) * 1.12 = 5.069,12 -> di-floor ke minimal 5.100 req.
const DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD = 5100;
const WEEKDAY_RESERVE_BEFORE_EOD = Math.max(5000, Number(process.env.BACKFILL_RESERVE_BEFORE_EOD) || DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD);

// 2c: read the EOD completion sentinel written by run-daily-market-update.js.
function eodDoneExists(baseDir, wibDateKey) {
  try {
    return fs.existsSync(path.join(baseDir, '_eod', wibDateKey + '.done'));
  } catch (_) { return false; }
}

// WIB date key (YYYY-MM-DD) with no external deps.
function wibDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts;
}

// Holiday/weekend detection without throwing when the calendar is unavailable.
function isTradingDaySafe(dateKey) {
  try {
    const cal = require('../lib/idx-trading-calendar');
    if (typeof cal.isTradingDay === 'function') {
      return cal.isTradingDay(dateKey, cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : undefined);
    }
    const holidays = cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : new Set();
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(dateKey);
  } catch (_) {
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function brokerSummaryHasTrades(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.derived === 'no-trade') return false;
  if (Array.isArray(data.brokers) && data.brokers.length > 0) {
    if (data.brokers.some(b => Number(b.bval || b.sval || b.bvol || b.svol || 0) > 0)) return true;
  }
  if (Array.isArray(data.broker_levels) && data.broker_levels.length > 0) {
    if (data.broker_levels.some(l => (l.buy && Number(l.buy.bval || l.buy.bvol || 0) > 0) || (l.sell && Number(l.sell.sval || l.sell.svol || 0) > 0))) return true;
  }
  if (Number(data.total_turnover || 0) > 0 || Number(data.total_volume || 0) > 0) return true;
  return false;
}

function resolveDynamicReserveQuota(baseDir, explicitMode = null, now = new Date()) {
  const todayKey = wibDateKey(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', weekday: 'short'
  }).format(now);
  const isWeekendDay = parts === 'Sun' || parts === 'Sat';

  let currentMode = explicitMode;
  if (!currentMode) {
    currentMode = isWeekendDay ? 'weekend' : 'weekday';
  }

  if (currentMode === 'weekday' && !isTradingDaySafe(todayKey)) {
    currentMode = 'weekend';
  }

  if (currentMode === 'weekend') {
    return WEEKEND_RESERVE;
  }

  const doneExists = eodDoneExists(baseDir, todayKey);
  return doneExists ? WEEKDAY_RESERVE : WEEKDAY_RESERVE_BEFORE_EOD;
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

// Candle lookup cache: Map<ticker, Map<date, {close,volume,value}>>
const candleCache = new Map();
function getCandleReference(candlesDir, ticker, date) {
  let map = candleCache.get(ticker);
  if (!map) {
    map = new Map();
    try {
      const f = path.join(candlesDir, `${ticker}.json`);
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const c of (d.candles || [])) {
          const dd = String(c.date || c.time || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) {
            map.set(dd, {
              close: Number(c.close),
              volume: Number(c.volume),
              value: c.value != null ? Number(c.value) : (c.turnover != null ? Number(c.turnover) : null)
            });
          }
        }
      }
    } catch (_) {}
    candleCache.set(ticker, map);
  }
  return map.get(date) || null;
}

/**
 * Validasi permanen: payload baru harus wajar sebelum dianggap selesai.
 * Mengembalikan { valid, flags, ratio }.
 */
function validateFetchedBroksum(payload, candlesDir, ticker, date) {
  try {
    const candle = getCandleReference(candlesDir, ticker, date);
    return broksumValidator.validateBroksumAgainstCandle(payload, candle);
  } catch (e) {
    return { valid: false, flags: ['validator_error:' + e.message], ratio: null };
  }
}

function quarantineInvalidBroksum(baseDir, ticker, date, content) {
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const qDir = path.join(baseDir, `_quarantine-tidakwajar-${stamp}`, ticker);
    const qFile = path.join(qDir, `${date}.json`);
    if (!fs.existsSync(qFile)) {
      fs.mkdirSync(qDir, { recursive: true });
      fs.writeFileSync(qFile, content, 'utf8');
    }
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
  const candidates = ['IHSG.json', 'BBCA.json', 'BRPT.json', 'BMRI.json', 'BBRI.json'];
  for (const f of candidates) {
    const p = path.join(candlesDir, f);
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = (data.candles || []).filter(c => c && c.date >= '2026-01-02' && c.date <= '2026-10-16').map(c => c.date);
        if (list.length > 0) {
          const unique = Array.from(new Set(list));
          return unique.sort().reverse(); // newest to oldest
        }
      } catch (_) {}
    }
  }

  // Fallback: inspect any .json in candlesDir
  try {
    const files = fs.readdirSync(candlesDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const p = path.join(candlesDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = (data.candles || []).filter(c => c && c.date >= '2026-01-02' && c.date <= '2026-10-16').map(c => c.date);
        if (list.length > 0) {
          const unique = Array.from(new Set(list));
          return unique.sort().reverse();
        }
      } catch (_) {}
    }
  } catch (_) {}

  return [];
}

const tickerCandleCache = new Map();

function getTickerCandleMap(candlesDir, ticker) {
  if (tickerCandleCache.has(ticker)) return tickerCandleCache.get(ticker);
  const map = new Map();
  try {
    const cFile = path.join(candlesDir, `${ticker}.json`);
    if (fs.existsSync(cFile)) {
      const data = JSON.parse(fs.readFileSync(cFile, 'utf8'));
      if (Array.isArray(data.candles)) {
        for (const c of data.candles) {
          if (c && c.date) {
            map.set(c.date, Number(c.volume != null ? c.volume : 0));
          }
        }
      }
    }
  } catch (_) {}
  tickerCandleCache.set(ticker, map);
  return map;
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

  const baseDir = getBaseDir(overrideTargetDir);

  // 2c: holiday fallback. On a non-trading weekday, behave like weekend.
  const todayKey = wibDateKey();
  if (mode === 'weekday' && !isTradingDaySafe(todayKey)) {
    console.log('[MODE] ' + todayKey + ' bukan hari bursa -> beralih ke mode weekend.');
    mode = 'weekend';
  }

  const explicitModeArg = modeIdx >= 0 ? mode : null;
  let reserveQuota = resolveDynamicReserveQuota(baseDir, explicitModeArg);
  let candlesDir = null;
  for (const a of args) {
    if (a.startsWith('--candles-dir=')) candlesDir = a.slice(14);
  }
  const candlesDirIdx = args.indexOf('--candles-dir');
  if (candlesDirIdx >= 0 && args[candlesDirIdx + 1]) candlesDir = args[candlesDirIdx + 1];

  if (!candlesDir) {
    const defaultCandles = path.join(__dirname, '..', 'data', 'daily-candles');
    candlesDir = fs.existsSync(defaultCandles) ? defaultCandles : path.join(process.cwd(), 'data', 'daily-candles');
  }

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
  let syntheticCount = 0;
  let quotaHalted = false;
  let consecutive429 = 0;
  const invalidAfterRetry = [];

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
      if (quotaHalted || arjumClient.isCircuitBreakerTripped()) break;
      let tickerCompletedDays = 0;

      for (const date of tradingDays) {
        if (requestsSent >= limit) {
          console.log(`[LIMIT-REACHED] Batas request ${limit} tercapai. Berhenti rapi.`);
          break;
        }

        if (arjumClient.isCircuitBreakerTripped()) {
          console.log(`[CIRCUIT-BREAKER] Circuit breaker aktif. Berhenti total.`);
          quotaHalted = true;
          break;
        }

        const taskKeyAll = `${ticker}_${date}_all`;
        const taskKeyF = `${ticker}_${date}_F`;

        // Check All file status (skipped if onlyForeign is true)
        // Fase validasi permanen: file lama juga diuji kewajarannya terhadap candle.
        // File tidak wajar (kosong/subset/imbalance) masuk kembali ke antrean.
        const allFile = path.join(baseDir, 'broker-summary', ticker, `${date}.json`);
        let needsAll = false;
        let allNeedsValidationQuarantine = false;
        if (!onlyForeign) {
          if (!fs.existsSync(allFile)) {
            needsAll = true;
          } else {
            try {
              const raw = fs.readFileSync(allFile, 'utf8');
              const parsed = JSON.parse(raw);
              if (parsed.derived === 'no-trade') {
                // derived no-trade sah hanya bila candle benar-benar tanpa volume
                const candle = getCandleReference(candlesDir, ticker, date);
                const v = broksumValidator.validateBroksumAgainstCandle(parsed, candle);
                if (v.valid) {
                  needsAll = false;
                } else {
                  needsAll = true;
                  allNeedsValidationQuarantine = true;
                }
              } else if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
                needsAll = true;
                backupClippedBroksum(baseDir, ticker, date, raw);
              } else {
                // Sudah lolos cek 25-level: apakah panjangnya kurang dari volume candle?
                const trimmed = raw.trim();
                if (trimmed.length < 512) {
                  // File sangat kecil (kemungkinan kosong/rusak)
                  const candle = getCandleReference(candlesDir, ticker, date);
                  if (candle && Number(candle.volume || 0) > 0) {
                    needsAll = true;
                    allNeedsValidationQuarantine = true;
                  }
                } else {
                  // Uji kewajaran penuh (rasio vs candle + keseimbangan)
                  const candle = getCandleReference(candlesDir, ticker, date);
                  const v = validateFetchedBroksum(parsed, candlesDir, ticker, date);
                  if (!v.valid && candle && (v.flags.includes('unclipped_ratio_below') || v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('parse_error'))) {
                    needsAll = true;
                    allNeedsValidationQuarantine = true;
                  }
                }
              }
            } catch (_) {
              needsAll = true;
              allNeedsValidationQuarantine = true;
            }
          }
        }

        // Check Foreign file status
        const fFile = path.join(baseDir, 'broker-summary-F', ticker, `${date}.json`);
        let needsF = false;
        if (!fs.existsSync(fFile)) {
          needsF = true;
        } else {
          try {
            const raw = fs.readFileSync(fFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || (parsed.flow !== 'F' && parsed.derived !== 'no-trade')) {
              needsF = true;
            }
          } catch (_) {
            needsF = true;
          }
        }

        if (!needsAll && !needsF) {
          skippedCount += onlyForeign ? 1 : 2;
          tickerCompletedDays++;
          continue;
        }

        // Re-evaluate dynamic reserve quota before checking limits (handles 00:00 WIB rollover)
        reserveQuota = resolveDynamicReserveQuota(baseDir, explicitModeArg);

        // Check Candle Volume & All File for Zero-Trade Session Optimization
        // Syarat lewat: volume candle 0 DAN file all kosong / tidak ada transaksi
        const candleMap = getTickerCandleMap(candlesDir, ticker);
        const hasCandleInfo = candleMap.has(date);
        const sessionVolume = hasCandleInfo ? candleMap.get(date) : null;

        let allFileHasTrades = false;
        let allFileExists = fs.existsSync(allFile);
        if (allFileExists) {
          try {
            const rawAll = fs.readFileSync(allFile, 'utf8');
            const parsedAll = JSON.parse(rawAll);
            allFileHasTrades = brokerSummaryHasTrades(parsedAll);
          } catch (_) {}
        }

        if (hasCandleInfo && sessionVolume === 0 && allFileExists && !allFileHasTrades) {
          // Zero trading volume session & All file confirms no trades: Do NOT call Arjum API! (Quota savings)
          if (dryRun) {
            console.log(`[DRY-RUN] [NO-TRADE] ${ticker} ${date} volume=0 & all=empty -> synthetic no-trade (0 quota)`);
          } else {
            if (needsAll && !onlyForeign) {
              const targetDirAll = path.join(baseDir, 'broker-summary', ticker);
              if (!fs.existsSync(targetDirAll)) fs.mkdirSync(targetDirAll, { recursive: true });
              fs.writeFileSync(allFile, JSON.stringify({
                stock_code: ticker,
                broker_start_date: date,
                broker_end_date: date,
                flow: 'all',
                brokers: [],
                broker_levels: [],
                derived: 'no-trade'
              }, null, 2), 'utf8');
              state.completedTasks[taskKeyAll] = true;
            }

            if (needsF) {
              const targetDirF = path.join(baseDir, 'broker-summary-F', ticker);
              if (!fs.existsSync(targetDirF)) fs.mkdirSync(targetDirF, { recursive: true });
              fs.writeFileSync(fFile, JSON.stringify({
                stock_code: ticker,
                broker_start_date: date,
                broker_end_date: date,
                flow: 'F',
                brokers: [],
                derived: 'no-trade'
              }, null, 2), 'utf8');
              state.completedTasks[taskKeyF] = true;
            }
          }
          syntheticCount++;
          tickerCompletedDays++;
          continue;
        }

        // 1. Fetch All if needed (and not only-foreign)
        if (needsAll && requestsSent < limit) {
          if (dryRun) {
            console.log(`[DRY-RUN] Fetch ALL: ${ticker} ${date} (all_data=true)`);
            requestsSent++;
          } else {
            const resAll = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, {
              allData: true,
              fresh: true,
              forceLive: true,
              noFallback: true,
              bypassMarketGuard: true
            });
            requestsSent++;
            state.totalSent = (state.totalSent || 0) + 1;

            const isAll200 = resAll && resAll.status === 200;
            const isAllLive = resAll && !resAll.from_cache && !resAll.fallback;
            const hasAllData = resAll && resAll.data && typeof resAll.data === 'object';
            const isFlowAll = hasAllData && resAll.data.flow === 'all';
            const isMatchingTickerAll = hasAllData && String(resAll.data.stock_code || resAll.data.code || '').trim().toUpperCase() === ticker.toUpperCase();

            if (resAll.ok && isAll200 && isAllLive && isFlowAll && isMatchingTickerAll) {
              consecutive429 = 0;

              // Fase 5: validasi permanen sebelum disimpan. Retry sekali.
              let payloadToWrite = resAll.data;
              let v = validateFetchedBroksum(payloadToWrite, candlesDir, ticker, date);
              if (!v.valid && (v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('unclipped_ratio_below') || v.flags.includes('unclipped_imbalance'))) {
                console.warn(`[VALIDASI-RETRY] ${ticker} ${date} hasil tidak wajar (${v.flags.join(',')} ratio=${v.ratio}). Mengulang sekali.`);
                try {
                  const retry = await arjumClient.fetchBrokerSummary(ticker, date, 'all', null, {
                    allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true
                  });
                  requestsSent++;
                  state.totalSent = (state.totalSent || 0) + 1;
                  const retryOk = retry && retry.ok && retry.status === 200 && retry.data
                    && !retry.from_cache && !retry.fallback && retry.data.flow === 'all'
                    && String(retry.data.stock_code || '').trim().toUpperCase() === ticker.toUpperCase();
                  if (retryOk) {
                    const v2 = validateFetchedBroksum(retry.data, candlesDir, ticker, date);
                    if (v2.valid) {
                      payloadToWrite = retry.data;
                      v = v2;
                    } else {
                      v = v2;
                    }
                  }
                } catch (e) {
                  console.warn(`[VALIDASI-RETRY-ERR] ${ticker} ${date}: ${e.message}`);
                }
              }

              if (!v.valid && (v.flags.includes('empty_broksum_but_candle_has_volume') || v.flags.includes('unclipped_ratio_below') || v.flags.includes('unclipped_imbalance'))) {
                console.error(`[VALIDASI-REJECT] ${ticker} ${date}: masih tidak wajar setelah retry (${v.flags.join(',')} ratio=${v.ratio}). Tidak disimpan sebagai selesai.`);
                invalidAfterRetry.push({ ticker, date, flags: v.flags, ratio: v.ratio });
                if (fs.existsSync(allFile)) {
                  try { quarantineInvalidBroksum(baseDir, ticker, date, fs.readFileSync(allFile, 'utf8')); } catch (_) {}
                  try { fs.unlinkSync(allFile); } catch (_) {}
                }
                needsAll = false; // biarkan antrean memungut di run berikutnya
              } else {
                const targetDir = path.join(baseDir, 'broker-summary', ticker);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                if (allNeedsValidationQuarantine && fs.existsSync(allFile)) {
                  try { quarantineInvalidBroksum(baseDir, ticker, date, fs.readFileSync(allFile, 'utf8')); } catch (_) {}
                }
                fs.writeFileSync(allFile, JSON.stringify(Object.assign({}, payloadToWrite, {
                  _validated: { at: new Date().toISOString(), ratio: v.ratio, flags: v.flags, validator: 'broksum-validator' }
                }), null, 2), 'utf8');
                state.completedTasks[taskKeyAll] = true;
                if (requestsSent % 5 === 0 || requestsSent <= 10) {
                  console.log(`[BACKFILL] Req ${requestsSent} | Saved ALL ${ticker} ${date} | ratio=${v.ratio} | Total Sent: ${state.totalSent}`);
                  saveState();
                }
              }
            } else {
              console.error(`[BACKFILL-STOP] Respon tidak valid untuk ALL ${ticker} ${date}: status=${resAll.status}, ok=${resAll.ok}, fallback=${resAll.fallback}, flow=${resAll.data && resAll.data.flow}, error=${resAll.error}`);
              quotaHalted = true;
              break;
            }

            // Quota remaining check
            let remaining;
            if (resAll.headers && resAll.headers['x-ratelimit-remaining'] != null) {
              remaining = parseInt(resAll.headers['x-ratelimit-remaining'], 10);
            } else {
              remaining = quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota());
            }

            if (!Number.isFinite(remaining)) {
              console.log(`[BUDGET-GUARD] Kuota sisa tidak dapat ditentukan. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (remaining <= reserveQuota) {
              console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
              quotaHalted = true;
              break;
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
            const resF = await arjumClient.fetchBrokerSummary(ticker, date, 'F', null, {
              allData: true,
              fresh: true,
              forceLive: true,
              noFallback: true,
              bypassMarketGuard: true
            });
            requestsSent++;
            state.totalSent = (state.totalSent || 0) + 1;

            const isF200 = resF && resF.status === 200;
            const isFLive = resF && !resF.from_cache && !resF.fallback;
            const hasFData = resF && resF.data && typeof resF.data === 'object';
            const isFlowF = hasFData && resF.data.flow === 'F';
            const isMatchingTickerF = hasFData && String(resF.data.stock_code || resF.data.code || '').trim().toUpperCase() === ticker.toUpperCase();

            if (resF.ok && isF200 && isFLive && isFlowF && isMatchingTickerF) {
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
            } else {
              console.error(`[BACKFILL-STOP] Respon tidak valid untuk FOREIGN ${ticker} ${date}: status=${resF.status}, ok=${resF.ok}, fallback=${resF.fallback}, flow=${resF.data && resF.data.flow}, error=${resF.error}`);
              quotaHalted = true;
              break;
            }

            // Quota remaining check
            let remaining;
            if (resF.headers && resF.headers['x-ratelimit-remaining'] != null) {
              remaining = parseInt(resF.headers['x-ratelimit-remaining'], 10);
            } else {
              remaining = quotaTracker.getRemainingToday(arjumClient.getConfiguredDailyQuota());
            }

            if (!Number.isFinite(remaining)) {
              console.log(`[BUDGET-GUARD] Kuota sisa tidak dapat ditentukan. Berhenti.`);
              quotaHalted = true;
              break;
            }

            if (remaining <= reserveQuota) {
              console.log(`[BUDGET-GUARD] Kuota sisa (${remaining}) <= cadangan (${reserveQuota}). Berhenti.`);
              quotaHalted = true;
              break;
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
  console.log(`Requests Sent:       ${requestsSent}`);
  console.log(`Tasks Skipped:      ${skippedCount}`);
  console.log(`Synthetic No-Trade: ${syntheticCount}`);
  console.log(`Invalid After Retry: ${invalidAfterRetry.length}`);
  console.log(`Status:              ${quotaHalted ? 'HALTED_BY_BUDGET_OR_QUOTA' : 'COMPLETED_OR_LIMITED'}`);
  if (invalidAfterRetry.length > 0) {
    console.log('Daftar periksa (perlu investigasi manual):');
    for (const it of invalidAfterRetry.slice(0, 50)) {
      console.log(`  - ${it.ticker} ${it.date} flags=${it.flags.join(',')} ratio=${it.ratio}`);
    }
  }
  return { success: true, requestsSent, skippedCount, syntheticCount, invalidAfterRetry, quotaHalted };
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
  loadTradingDays,
  getTickerCandleMap,
  brokerSummaryHasTrades,
  resolveDynamicReserveQuota
};
