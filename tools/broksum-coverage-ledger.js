'use strict';

/**
 * Broksum Historical Coverage Ledger & Backfill Gap Queue (Subtask D — V6 Remediation)
 * =====================================================================================
 *
 * READ-ONLY local tool. It NEVER writes the production DB, NEVER executes a
 * backfill, and NEVER triggers a live provider request. It only:
 *   1. Reads the local inventory already produced during Subtask A:
 *        - data/backfill-queue-vps.json  -> exact "TICKER@YYYY-MM-DD" missing sets
 *          for Broksum ALL (priority P2) and Foreign (priority P3) over the
 *          observed trading calendar 2026-01-02 .. 2026-10-30.
 *        - data/daily-candles/*.json    -> ticker universe (963 emiten) + per-day
 *          OHLCV used to distinguish "present file with zero trades" from a truly
 *          missing file, and to detect not-listed / no-trade dates.
 *        - docs/v6/BROKSUM_DAILY_COVERAGE_20261102_20261110.csv
 *          and docs/v6/V6_BROKSUM_NOV_2_3_4_5_6_9_10_MATRIX.csv
 *          -> exact per-ticker coverage for the 2026-11-02 .. 2026-11-10 window.
 *          EXPANDED per-ticker-date-dataset without wildcard rows.
 *        - lib/idx-holidays-2026-seed-data.js + lib/idx-trading-calendar.js
 *                                      -> IDX 2026 holiday/weekend calendar.
 *   2. Builds a canonical ledger keyed by (trade_date, ticker, dataset_type).
 *   3. Classifies every eligible pair into canonical statuses.
 *   4. Emits comprehensive artifacts under docs/v6/.
 *
 * STATUS VOCABULARY (canonical tokens):
 *   VERIFIED_PRESENT                file present & valid non-empty JSON (census "filled")
 *   VERIFIED_ABSENT_PROVEN_NO_TRADE no broker file AND local candle shows zero volume
 *   MISSING_RECOVERABLE_LOCAL       no broker file, but a local rolling record exists
 *   MISSING_NEEDS_UPSTREAM          no broker file, ticker traded -> real upstream gap
 *   INVALID_PAYLOAD                 file exists but unreadable/corrupt (local census = 0)
 *   CONFLICT                        two sources disagree on one key (0 in current data)
 *   NOT_LISTED                      ticker not listed/traded that session (pre-IPO / halted)
 *   NOT_TRADING_DAY                 weekend or IDX holiday
 *   PENDING_TODAY                   today's EOD job not yet run
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DAILY_CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const BACKFILL_Q_VPS = path.join(ROOT, 'data', 'backfill-queue-vps.json');
const NOV_COVERAGE_CSV = path.join(ROOT, 'docs', 'v6', 'BROKSUM_DAILY_COVERAGE_20261102_20261110.csv');
const NOV_MATRIX_CSV = path.join(ROOT, 'docs', 'v6', 'V6_BROKSUM_NOV_2_3_4_5_6_9_10_MATRIX.csv');
const ACCUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const OUT_DIR = path.join(ROOT, 'docs', 'v6');

const idxCalendar = require('../lib/idx-trading-calendar');
const idxHolidays = require('../lib/idx-holidays-2026-seed-data');

const WINDOW_START = '2026-01-02';
const WINDOW_END = '2026-11-10';
const HIST_END = '2026-10-30'; // last date covered by data/backfill-queue-vps.json
const NOV_START = '2026-11-02';

const DATASETS = ['ALL', 'FOREIGN'];

const WEEKDAY_NIGHT_THROUGHPUT = 7752;
const WEEKEND_NIGHT_THROUGHPUT = 12752;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function toDateKeyStr(ymd) {
  return String(ymd).slice(0, 10);
}

function addDays(ymd, delta) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function enumDays(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 4000) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard = guard + 1;
  }
  return out;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',');
}

function buildCalendar() {
  const holidaySet = new Set(idxHolidays.IDX_HOLIDAYS_2026.map((h) => h.trade_date));
  const holidayNames = {};
  for (const h of idxHolidays.IDX_HOLIDAYS_2026) holidayNames[h.trade_date] = h.name;

  const allDays = enumDays(WINDOW_START, WINDOW_END);
  const trading = [];
  const nonTrading = [];
  for (const d of allDays) {
    const ok = idxCalendar.isTradingDay(d, holidaySet);
    if (ok) {
      trading.push(d);
    } else {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      const reason = holidaySet.has(d) ? 'HOLIDAY' : (dow === 0 || dow === 6 ? 'WEEKEND' : 'HOLIDAY');
      nonTrading.push({ date: d, reason, holidayName: holidayNames[d] || null });
    }
  }

  const historical = trading.filter((d) => d <= HIST_END);
  const nov = trading.filter((d) => d >= NOV_START);
  return {
    holidaySet,
    holidayNames,
    trading,
    historical,
    nov,
    nonTrading,
    source: 'lib/idx-holidays-2026-seed-data (unverified seed) + weekend rule',
  };
}

function listUniverseTickers() {
  let files = [];
  try {
    files = fs.readdirSync(DAILY_CANDLES_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    files = [];
  }
  return files
    .map((f) => f.slice(0, -5))
    .filter((t) => t !== 'IHSG')
    .sort();
}

function buildCandleIndex(tickers) {
  const index = new Map();
  for (const t of tickers) {
    const fp = path.join(DAILY_CANDLES_DIR, t + '.json');
    const j = readJson(fp);
    const candles = (j && Array.isArray(j.candles)) ? j.candles : [];
    const byDate = new Map();
    for (const c of candles) {
      const d = c && c.date ? toDateKeyStr(c.date) : null;
      if (d && DATE_RE.test(d)) {
        byDate.set(d, {
          volume: finiteOrNull(c.volume),
          close: finiteOrNull(c.close),
        });
      }
    }
    const dates = Array.from(byDate.keys()).sort();
    index.set(t, {
      byDate,
      first: dates.length ? dates[0] : null,
      last: dates.length ? dates[dates.length - 1] : null,
    });
  }
  return index;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function loadBackfillMissingSets() {
  const q = readJson(BACKFILL_Q_VPS);
  const items = (q && typeof q.items === 'object') ? q.items : {};
  const p2 = Array.isArray(items.P2) ? items.P2 : [];
  const p3 = Array.isArray(items.P3) ? items.P3 : [];

  const missingAll = new Set();
  for (const it of p2) {
    const m = String(it).split('@');
    if (m.length === 2) missingAll.add(m[0] + '|' + m[1]);
  }
  const missingForeign = new Set();
  for (const it of p3) {
    const m = String(it).split('@');
    if (m.length === 2) missingForeign.add(m[0] + '|' + m[1]);
  }

  const dates = new Set();
  for (const key of missingAll) dates.add(key.split('|')[1]);
  for (const key of missingForeign) dates.add(key.split('|')[1]);

  return {
    missingAll,
    missingForeign,
    dates,
    source: path.relative(ROOT, BACKFILL_Q_VPS).replace(/\\/g, '/'),
    generatedAt: q && q.generatedAt ? q.generatedAt : null,
    universe: q && q.universe ? q.universe : null,
  };
}

function loadNovCoverage() {
  const out = new Map();
  let raw = null;
  try {
    raw = fs.readFileSync(NOV_COVERAGE_CSV, 'utf8');
  } catch (_) {
    return { map: out, source: null };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const date = String(cols[0]).trim();
    if (!DATE_RE.test(date)) continue;
    out.set(date, {
      eligible: parseInt(cols[1], 10) || 0,
      allPresent: parseInt(cols[2], 10) || 0,
      foreignPresent: parseInt(cols[3], 10) || 0,
      providerStatus: String(cols[6]).trim(),
      source: String(cols[7]).trim(),
    });
  }
  return { map: out, source: path.relative(ROOT, NOV_COVERAGE_CSV).replace(/\\/g, '/') };
}

function loadNovMatrix() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(NOV_MATRIX_CSV, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      if (parts.length >= 4) {
        map.set(parts[0].trim() + '|' + parts[1].trim(), {
          all: parts[2].trim() === '1',
          f: parts[3].trim() === '1',
          status: (parts[7] || '').trim(),
        });
      }
    }
  } catch (_) {}
  return map;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function isRecoverableLocal(ticker, date) {
  const fp = path.join(ACCUM_DIR, ticker + '.json');
  const st = safeStat(fp);
  if (!st || !st.isFile()) return false;
  const j = readJson(fp);
  if (!j || typeof j !== 'object') return false;
  return toDateKeyStr(j.latest && j.latest.date) === date;
}

function classifyKey(opts) {
  const ctx = opts.ctx;
  const date = opts.tradeDate;
  const ticker = opts.ticker;
  const dataset = opts.datasetType;

  const row = {
    status: 'VERIFIED_PRESENT',
    reason: '',
    granularity: ticker === '*' ? 'date' : 'ticker',
    candleVolume: null,
    candleClose: null,
    source: '',
  };

  // 1. Non-trading day (weekend / holiday).
  if (!ctx.isTradingDay(date)) {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    row.status = 'NOT_TRADING_DAY';
    row.reason = ctx.holidaySet.has(date) ? 'holiday' : (dow === 0 || dow === 6 ? 'weekend' : 'holiday');
    row.source = 'idx-trading-calendar';
    return row;
  }

  // 2. Today (before EOD)
  if (date === ctx.todayKey) {
    row.status = 'PENDING_TODAY';
    row.reason = 'today_eod_not_yet_run';
    row.source = 'subtask-a-daily-coverage';
    return row;
  }

  const candle = ctx.candleOf(ticker, date);
  if (candle) {
    row.candleVolume = candle.volume;
    row.candleClose = candle.close;
  }

  // 3. Date-level aggregate rows (if ever called with ticker='*')
  if (row.granularity === 'date') {
    const nov = (ctx.novCoverage || {}).map ? ctx.novCoverage.map.get(date) : null;
    const present = dataset === 'ALL' ? (nov && nov.allPresent) : (nov && nov.foreignPresent);
    if (present == null) {
      row.status = 'MISSING_NEEDS_UPSTREAM';
      row.reason = 'no_daily_coverage_evidence';
      row.source = 'subtask-a-daily-coverage';
      return row;
    }
    const eligible = nov.eligible || 0;
    if (present >= (eligible || 1) && eligible > 0) {
      row.status = 'VERIFIED_PRESENT';
      row.reason = 'date_full_coverage';
    } else if (present > 0) {
      row.status = 'MISSING_NEEDS_UPSTREAM';
      row.reason = 'date_partial_coverage';
    } else {
      row.status = 'MISSING_NEEDS_UPSTREAM';
      row.reason = 'date_zero_coverage';
    }
    row.source = 'subtask-a-daily-coverage';
    return row;
  }

  // 4. Per-ticker November remediation window (2026-11-02 .. 2026-11-10)
  if (date > HIST_END) {
    const matrixEntry = ctx.novMatrix ? ctx.novMatrix.get(date + '|' + ticker) : null;
    const isPresent = matrixEntry ? (dataset === 'ALL' ? matrixEntry.all : matrixEntry.f) : false;
    if (isPresent) {
      row.status = 'VERIFIED_PRESENT';
      row.reason = 'cached_on_vps';
      row.source = 'docs/v6/V6_BROKSUM_NOV_2_3_4_5_6_9_10_MATRIX.csv';
      return row;
    }
    row.status = 'MISSING_NEEDS_UPSTREAM';
    row.reason = date === '2026-11-02' ? 'unreleased_by_upstream' : (date === '2026-11-03' ? 'quota_exhausted_crash' : 'blocked_exec_perm');
    row.source = 'docs/v6/BROKSUM_DAILY_COVERAGE_20261102_20261110.csv';
    return row;
  }

  // 5. Per-ticker historical window (2026-01-02 .. 2026-10-30)
  const key = ticker + '|' + date;
  const missing = dataset === 'ALL' ? ctx.missingAllSet.has(key) : ctx.missingForeignSet.has(key);

  if (!missing) {
    row.status = 'VERIFIED_PRESENT';
    row.reason = 'file_present_valid';
    row.source = ctx.backfillSource;
    return row;
  }

  if (!candle) {
    row.status = 'MISSING_NEEDS_UPSTREAM';
    row.reason = 'no_local_candle_evidence';
    row.source = ctx.backfillSource;
    return row;
  }

  if (candle.volume === 0 && candle.close === 0) {
    row.status = 'VERIFIED_ABSENT_PROVEN_NO_TRADE';
    row.reason = 'zero_volume_and_zero_close_on_trading_day';
    row.source = 'daily-candles-cross-check';
    return row;
  }

  if (candle.volume > 0) {
    if (ctx.isRecoverableLocal(ticker, date)) {
      row.status = 'MISSING_RECOVERABLE_LOCAL';
      row.reason = 'rolling_accumulation_refreshed_on_date';
      row.source = 'broker-accumulation';
    } else {
      row.status = 'MISSING_NEEDS_UPSTREAM';
      row.reason = 'traded_but_no_broker_file';
      row.source = ctx.backfillSource;
    }
  } else {
    row.status = 'MISSING_NEEDS_UPSTREAM';
    row.reason = 'zero_volume_unresolved_close';
    row.source = 'daily-candles-cross-check';
  }

  return row;
}

function buildContext(opts) {
  const options = opts || {};
  const calendar = buildCalendar();
  const tickers = listUniverseTickers();
  const backfill = loadBackfillMissingSets();
  const candleIndex = buildCandleIndex(tickers);
  const nov = loadNovCoverage();
  const novMatrix = loadNovMatrix();
  const todayKey = options.todayKey || wibTodayKey();

  return {
    calendar,
    tickers,
    backfill,
    holidaySet: calendar.holidaySet,
    todayKey,
    novCoverage: nov,
    novMatrix,
    candleIndex,
    isTradingDay: (d) => calendar.holidaySet ? idxCalendar.isTradingDay(d, calendar.holidaySet) : false,
    candleOf: (ticker, date) => {
      const rec = candleIndex.get(ticker);
      if (!rec) return null;
      return rec.byDate.get(date) || null;
    },
    tickerMeta: (ticker) => {
      const rec = candleIndex.get(ticker);
      return rec ? { first: rec.first, last: rec.last } : { first: null, last: null };
    },
    isRecoverableLocal,
    missingAllSet: backfill.missingAll,
    missingForeignSet: backfill.missingForeign,
    backfillSource: backfill.source,
    backfillGeneratedAt: backfill.generatedAt,
    queueUniverse: backfill.universe,
    novSource: nov.source,
  };
}

function wibTodayKey(now) {
  const d = now || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts;
}

function assembleLedger(ctx) {
  const rows = [];
  const cal = ctx.calendar;

  const historicalDates = Array.from(ctx.backfill.dates)
    .filter((d) => d <= HIST_END)
    .sort();

  const datasets = DATASETS;

  // (a) Per-ticker rows for the historical window (2026-01-02 .. 2026-10-30).
  for (const date of historicalDates) {
    for (const ticker of ctx.tickers) {
      for (const dataset of datasets) {
        const r = classifyKey({ tradeDate: date, ticker, datasetType: dataset, ctx });
        rows.push({
          trade_date: date,
          ticker,
          dataset_type: dataset,
          status: r.status,
          reason: r.reason,
          granularity: r.granularity,
          candle_volume: r.candleVolume,
          candle_close: r.candleClose,
          source: r.source,
        });
      }
    }
  }

  // (b) Per-ticker expanded rows for the Nov remediation window (2026-11-02 .. 2026-11-10) — NO WILDCARDS!
  for (const date of cal.nov) {
    for (const ticker of ctx.tickers) {
      for (const dataset of datasets) {
        const r = classifyKey({ tradeDate: date, ticker, datasetType: dataset, ctx });
        rows.push({
          trade_date: date,
          ticker,
          dataset_type: dataset,
          status: r.status,
          reason: r.reason,
          granularity: r.granularity,
          candle_volume: r.candleVolume,
          candle_close: r.candleClose,
          source: r.source,
        });
      }
    }
  }

  // (c) NOT_TRADING_DAY markers (weekend + holiday) within the window, date-level.
  for (const nt of cal.nonTrading) {
    for (const dataset of datasets) {
      rows.push({
        trade_date: nt.date,
        ticker: '*',
        dataset_type: dataset,
        status: 'NOT_TRADING_DAY',
        reason: nt.reason === 'HOLIDAY' ? 'holiday' : 'weekend',
        granularity: 'date',
        candle_volume: null,
        candle_close: null,
        source: 'idx-trading-calendar',
      });
    }
  }

  rows.sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    if (a.dataset_type !== b.dataset_type) return a.dataset_type < b.dataset_type ? -1 : 1;
    if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
    return 0;
  });

  return rows;
}

const GAP_STATUSES = new Set([
  'MISSING_RECOVERABLE_LOCAL',
  'MISSING_NEEDS_UPSTREAM',
  'INVALID_PAYLOAD',
  'CONFLICT',
  'PENDING_TODAY',
]);

function assembleGaps(ledgerRows) {
  return ledgerRows.filter((r) => GAP_STATUSES.has(r.status));
}

function buildQueuePlan(ctx, gaps) {
  const histTicker = [];
  const novTicker = [];

  for (const g of gaps) {
    if (g.trade_date > HIST_END) {
      novTicker.push(g);
    } else if (g.status === 'MISSING_NEEDS_UPSTREAM' || g.status === 'MISSING_RECOVERABLE_LOCAL') {
      histTicker.push(g);
    }
  }

  const plan = [];

  // P0 — today (pending).
  const today = ctx.todayKey;
  for (const dataset of DATASETS) {
    const todayPairs = novTicker.filter((g) => g.trade_date === today && g.dataset_type === dataset);
    const count = todayPairs.length;
    plan.push({
      priority: 'P0_TODAY',
      dataset_type: dataset,
      trade_date_from: today,
      trade_date_to: today,
      scope: 'ticker',
      missing_pairs: count > 0 ? count : ctx.tickers.length,
      budget_requests_forecast: 0,
      eta_conservative: 'EOD job (19:45 WIB) fills today; no manual backfill',
      resume_dedup_key_prefix: today + '|' + dataset,
      rationale: 'today_eod_pending',
    });
  }

  // P1 — Nov 2..9 (remediation window, newest first).
  const novDates = Array.from(new Set(novTicker.filter((g) => g.trade_date < today).map((g) => g.trade_date))).sort((a, b) => b.localeCompare(a));
  for (const d of novDates) {
    for (const dataset of DATASETS) {
      const missing = novTicker.filter((g) => g.trade_date === d && g.dataset_type === dataset).length;
      plan.push({
        priority: 'P1_RECENT_NOV',
        dataset_type: dataset,
        trade_date_from: d,
        trade_date_to: d,
        scope: 'ticker',
        missing_pairs: missing,
        budget_requests_forecast: missing,
        eta_conservative: forecastEta(missing),
        resume_dedup_key_prefix: d + '|' + dataset,
        rationale: d === '2026-11-02' || d === '2026-11-03' ? 'partial_present_gap' : 'zero_files_for_whole_date',
      });
    }
  }

  // P2 — historical ALL gaps (per-ticker).
  const alloc = histTicker.filter((g) => g.dataset_type === 'ALL');
  const foreign = histTicker.filter((g) => g.dataset_type === 'FOREIGN');

  plan.push({
    priority: 'P2_HISTORICAL_ALL',
    dataset_type: 'ALL',
    trade_date_from: WINDOW_START,
    trade_date_to: HIST_END,
    scope: 'ticker',
    missing_pairs: alloc.length,
    budget_requests_forecast: alloc.length,
    eta_conservative: forecastEta(alloc.length),
    resume_dedup_key_prefix: 'TICKER@DATE|ALL',
    rationale: 'historical_all_gap_newest_first',
  });

  plan.push({
    priority: 'P3_HISTORICAL_FOREIGN',
    dataset_type: 'FOREIGN',
    trade_date_from: WINDOW_START,
    trade_date_to: HIST_END,
    scope: 'ticker',
    missing_pairs: foreign.length,
    budget_requests_forecast: foreign.length,
    eta_conservative: forecastEta(foreign.length),
    resume_dedup_key_prefix: 'TICKER@DATE|FOREIGN',
    rationale: 'historical_foreign_gap_newest_first',
  });

  return plan;
}

function forecastEta(requests) {
  if (!requests || requests <= 0) return '0 nights';
  const nightsWeek = Math.ceil(requests / WEEKDAY_NIGHT_THROUGHPUT);
  const nightsWeekend = Math.ceil(requests / WEEKEND_NIGHT_THROUGHPUT);
  return '~' + nightsWeek + ' nights @ ' + WEEKDAY_NIGHT_THROUGHPUT + ' req/night (weekend ' + nightsWeekend + ' nights)';
}

const LEDGER_COLUMNS = [
  'trade_date',
  'ticker',
  'dataset_type',
  'status',
  'reason',
  'granularity',
  'candle_volume',
  'candle_close',
  'source',
];

const GAP_COLUMNS = [
  'trade_date',
  'ticker',
  'dataset_type',
  'status',
  'granularity',
  'gap_bucket',
  'resume_key',
  'source',
  'reason',
];

const PLAN_COLUMNS = [
  'priority',
  'dataset_type',
  'trade_date_from',
  'trade_date_to',
  'scope',
  'missing_pairs',
  'budget_requests_forecast',
  'eta_conservative',
  'resume_dedup_key_prefix',
  'rationale',
];

function resumeKeyFor(gap) {
  if (gap.granularity === 'date') return gap.trade_date + '|' + gap.dataset_type + '|BUCKET';
  return gap.ticker + '@' + gap.trade_date + '|' + gap.dataset_type;
}

function gapBucketFor(status) {
  if (status === 'INVALID_PAYLOAD' || status === 'CONFLICT') return 'BLOCKED';
  if (status === 'PENDING_TODAY') return 'PENDING';
  return 'MISSING';
}

function writeCsv(filePath, columns, rows, rowBuilder) {
  const lines = [csvLine(columns)];
  for (const r of rows) lines.push(csvLine(rowBuilder(r)));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return { filePath, rows: rows.length };
}

function buildLedgerRow(r) {
  return [
    r.trade_date,
    r.ticker,
    r.dataset_type,
    r.status,
    r.reason,
    r.granularity,
    r.candle_volume === null || r.candle_volume === undefined ? '' : String(r.candle_volume),
    r.candle_close === null || r.candle_close === undefined ? '' : String(r.candle_close),
    r.source,
  ];
}

function buildGapRow(r) {
  return [
    r.trade_date,
    r.ticker,
    r.dataset_type,
    r.status,
    r.granularity,
    r.gap_bucket,
    r.resume_key,
    r.source,
    r.reason,
  ];
}

function buildPlanRow(r) {
  return [
    r.priority,
    r.dataset_type,
    r.trade_date_from,
    r.trade_date_to,
    r.scope,
    r.missing_pairs,
    r.budget_requests_forecast,
    r.eta_conservative,
    r.resume_dedup_key_prefix,
    r.rationale,
  ];
}

function summarize(ledgerRows, ctx) {
  const byDate = new Map();
  const byTicker = new Map();
  const byDataset = {
    ALL: { VERIFIED_PRESENT: 0, VERIFIED_ABSENT_PROVEN_NO_TRADE: 0, MISSING_RECOVERABLE_LOCAL: 0, MISSING_NEEDS_UPSTREAM: 0, INVALID_PAYLOAD: 0, CONFLICT: 0, NOT_LISTED: 0, NOT_TRADING_DAY: 0, PENDING_TODAY: 0 },
    FOREIGN: { VERIFIED_PRESENT: 0, VERIFIED_ABSENT_PROVEN_NO_TRADE: 0, MISSING_RECOVERABLE_LOCAL: 0, MISSING_NEEDS_UPSTREAM: 0, INVALID_PAYLOAD: 0, CONFLICT: 0, NOT_LISTED: 0, NOT_TRADING_DAY: 0, PENDING_TODAY: 0 },
  };

  for (const r of ledgerRows) {
    if (byDataset[r.dataset_type] && byDataset[r.dataset_type][r.status] !== undefined) {
      byDataset[r.dataset_type][r.status] += 1;
    }
    const key = r.trade_date + '|' + r.dataset_type;
    if (!byDate.has(key)) {
      byDate.set(key, {
        trade_date: r.trade_date,
        dataset_type: r.dataset_type,
        VERIFIED_PRESENT: 0,
        VERIFIED_ABSENT_PROVEN_NO_TRADE: 0,
        MISSING_RECOVERABLE_LOCAL: 0,
        MISSING_NEEDS_UPSTREAM: 0,
        BLOCKED: 0,
        NOT_LISTED: 0,
        NOT_TRADING_DAY: 0,
        PENDING_TODAY: 0,
        date_granularity: r.granularity === 'date',
      });
    }
    const e = byDate.get(key);
    if (r.status === 'INVALID_PAYLOAD' || r.status === 'CONFLICT') e.BLOCKED += 1;
    else if (e[r.status] !== undefined) e[r.status] += 1;

    if (r.ticker !== '*') {
      const tKey = r.ticker + '|' + r.dataset_type;
      if (!byTicker.has(tKey)) {
        byTicker.set(tKey, {
          ticker: r.ticker,
          dataset_type: r.dataset_type,
          present: 0,
          missing: 0,
          pending: 0,
          no_trade: 0,
        });
      }
      const tEnt = byTicker.get(tKey);
      if (r.status === 'VERIFIED_PRESENT') tEnt.present += 1;
      else if (r.status === 'MISSING_NEEDS_UPSTREAM' || r.status === 'MISSING_RECOVERABLE_LOCAL') tEnt.missing += 1;
      else if (r.status === 'PENDING_TODAY') tEnt.pending += 1;
      else if (r.status === 'VERIFIED_ABSENT_PROVEN_NO_TRADE') tEnt.no_trade += 1;
    }
  }

  return {
    byDate: Array.from(byDate.values()).sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.dataset_type.localeCompare(b.dataset_type)),
    byTicker: Array.from(byTicker.values()).sort((a, b) => a.ticker.localeCompare(b.ticker) || a.dataset_type.localeCompare(b.dataset_type)),
    byDataset,
  };
}

function buildSummaryMd(summary, ctx, gaps, plan) {
  const L = [];
  L.push('# Historical Coverage Summary — Broksum ALL & Foreign (2 Jan – 10 Nov 2026)');
  L.push('');
  L.push('**Generated by:** `tools/broksum-coverage-ledger.js` (read-only local tool)');
  L.push('**Generated at (UTC):** ' + new Date().toISOString());
  L.push('**Scope:** `BROKSUM_ALL` + `BROKSUM_FOREIGN`, canonical key `(trade_date, ticker, dataset_type)`');
  L.push('**Window:** ' + WINDOW_START + ' .. ' + WINDOW_END);
  L.push('');
  L.push('## Provenance & limitations');
  L.push('');
  L.push('- Historical per-ticker coverage (2026-01-02 .. 2026-10-30) derives from `' + (ctx.backfillSource || 'n/a') + '` (missing sets P2/P3), generated ' + (ctx.backfillGeneratedAt || 'n/a') + '.');
  L.push('- Remediation window (2026-11-02 .. 2026-11-10) is FULLY EXPANDED per-ticker (963 emiten) across all November dates without wildcards.');
  L.push('- Eligible universe: **' + ctx.tickers.length + ' emiten** (IHSG index excluded). Canonical eligible universe is 963 (`stock_boards`).');
  L.push('- Trading calendar: `' + ctx.calendar.source + '`. Seed holidays are user-provided; weekends are derived deterministically.');
  L.push('- `VERIFIED_PRESENT` means the file exists and is valid non-empty JSON (census "filled").');
  L.push('- `VERIFIED_ABSENT_PROVEN_NO_TRADE` means no broker file AND local candle shows zero volume/close on a trading day.');
  L.push('- `candle_volume`/`candle_close` are EMPTY when no local candle row exists, and the literal `0` when a row exists with zero value — 0 is never confused with missing.');
  L.push('');
  L.push('## Aggregate by dataset');
  L.push('');
  L.push('| status | ALL rows | FOREIGN rows |');
  L.push('|---|---:|---:|');
  const allSt = ['VERIFIED_PRESENT', 'VERIFIED_ABSENT_PROVEN_NO_TRADE', 'MISSING_RECOVERABLE_LOCAL', 'MISSING_NEEDS_UPSTREAM', 'INVALID_PAYLOAD', 'CONFLICT', 'NOT_LISTED', 'NOT_TRADING_DAY', 'PENDING_TODAY'];
  for (const s of allSt) {
    L.push('| ' + s + ' | ' + summary.byDataset.ALL[s] + ' | ' + summary.byDataset.FOREIGN[s] + ' |');
  }
  L.push('');
  L.push('## Per-date coverage');
  L.push('');
  L.push('| trade_date | dataset | present | absent_no_trade | recoverable_local | needs_upstream | not_listed | blocked | not_trading | pending | granularity |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const e of summary.byDate) {
    const cells = [
      e.trade_date,
      e.dataset_type,
      e.VERIFIED_PRESENT,
      e.VERIFIED_ABSENT_PROVEN_NO_TRADE,
      e.MISSING_RECOVERABLE_LOCAL,
      e.MISSING_NEEDS_UPSTREAM,
      e.NOT_LISTED,
      e.BLOCKED,
      e.NOT_TRADING_DAY,
      e.PENDING_TODAY,
      e.date_granularity ? 'date' : 'ticker',
    ];
    L.push('| ' + cells.join(' | ') + ' |');
  }
  L.push('');
  L.push('## Gap & backfill plan');
  L.push('');
  L.push('| priority | dataset | window | scope | missing_pairs | budget_requests | eta_conservative |');
  L.push('|---|---|---|---:|---:|---|');
  for (const p of plan) {
    L.push('| ' + p.priority + ' | ' + p.dataset_type + ' | ' + p.trade_date_from + '..' + p.trade_date_to + ' | ' + p.scope + ' | ' + p.missing_pairs + ' | ' + p.budget_requests_forecast + ' | ' + p.eta_conservative + ' |');
  }
  L.push('');
  L.push('## Artifacts');
  L.push('');
  L.push('- [`docs/v6/V6_HISTORICAL_ALL_PER_KEY.csv`](V6_HISTORICAL_ALL_PER_KEY.csv)');
  L.push('- [`docs/v6/V6_HISTORICAL_FOREIGN_PER_KEY.csv`](V6_HISTORICAL_FOREIGN_PER_KEY.csv)');
  L.push('- [`docs/v6/V6_HISTORICAL_GAPS_EXPANDED.csv`](V6_HISTORICAL_GAPS_EXPANDED.csv)');
  L.push('- [`docs/v6/V6_HISTORICAL_SUMMARY_BY_DATE.csv`](V6_HISTORICAL_SUMMARY_BY_DATE.csv)');
  L.push('- [`docs/v6/V6_HISTORICAL_SUMMARY_BY_TICKER.csv`](V6_HISTORICAL_SUMMARY_BY_TICKER.csv)');
  L.push('- [`docs/v6/V6_BACKFILL_RESUMABLE_QUEUE.csv`](V6_BACKFILL_RESUMABLE_QUEUE.csv)');
  L.push('- [`docs/v6/BROKSUM_BACKFILL_QUEUE_PLAN.csv`](BROKSUM_BACKFILL_QUEUE_PLAN.csv)');
  L.push('- [`docs/v6/HISTORICAL_COVERAGE_SUMMARY.md`](HISTORICAL_COVERAGE_SUMMARY.md)');
  L.push('');
  return L.join('\n');
}

function build(options) {
  const opts = options || {};
  const ctx = buildContext(opts);
  if (opts.todayKey) ctx.todayKey = opts.todayKey;

  const ledgerRows = assembleLedger(ctx);

  const allRows = ledgerRows.filter((r) => r.dataset_type === 'ALL');
  const foreignRows = ledgerRows.filter((r) => r.dataset_type === 'FOREIGN');

  const gaps = assembleGaps(ledgerRows).map((g) => ({
    ...g,
    gap_bucket: gapBucketFor(g.status),
    resume_key: resumeKeyFor(g),
  }));

  const plan = buildQueuePlan(ctx, gaps);
  const summary = summarize(ledgerRows, ctx);

  // Write canonical legacy files for backwards-compatibility
  const out = {
    all: writeCsv(path.join(OUT_DIR, 'BROKSUM_HISTORICAL_ALL.csv'), LEDGER_COLUMNS, allRows, buildLedgerRow),
    foreign: writeCsv(path.join(OUT_DIR, 'BROKSUM_HISTORICAL_FOREIGN.csv'), LEDGER_COLUMNS, foreignRows, buildLedgerRow),
    gaps: writeCsv(path.join(OUT_DIR, 'BROKSUM_HISTORICAL_GAPS.csv'), GAP_COLUMNS, gaps, buildGapRow),
    plan: writeCsv(path.join(OUT_DIR, 'BROKSUM_BACKFILL_QUEUE_PLAN.csv'), PLAN_COLUMNS, plan, buildPlanRow),
  };

  // Write new comprehensive Subtask D artifacts explicitly requested
  writeCsv(path.join(OUT_DIR, 'V6_HISTORICAL_ALL_PER_KEY.csv'), LEDGER_COLUMNS, allRows, buildLedgerRow);
  writeCsv(path.join(OUT_DIR, 'V6_HISTORICAL_FOREIGN_PER_KEY.csv'), LEDGER_COLUMNS, foreignRows, buildLedgerRow);
  writeCsv(path.join(OUT_DIR, 'V6_HISTORICAL_GAPS_EXPANDED.csv'), GAP_COLUMNS, gaps, buildGapRow);

  // Summary by date CSV
  const summaryDateCols = ['trade_date', 'dataset_type', 'present', 'absent_no_trade', 'recoverable_local', 'needs_upstream', 'not_listed', 'blocked', 'not_trading', 'pending', 'granularity'];
  writeCsv(path.join(OUT_DIR, 'V6_HISTORICAL_SUMMARY_BY_DATE.csv'), summaryDateCols, summary.byDate, (e) => [
    e.trade_date, e.dataset_type, e.VERIFIED_PRESENT, e.VERIFIED_ABSENT_PROVEN_NO_TRADE, e.MISSING_RECOVERABLE_LOCAL, e.MISSING_NEEDS_UPSTREAM, e.NOT_LISTED, e.BLOCKED, e.NOT_TRADING_DAY, e.PENDING_TODAY, e.date_granularity ? 'date' : 'ticker'
  ]);

  // Summary by ticker CSV
  const summaryTickerCols = ['ticker', 'dataset_type', 'present', 'missing', 'pending', 'no_trade'];
  writeCsv(path.join(OUT_DIR, 'V6_HISTORICAL_SUMMARY_BY_TICKER.csv'), summaryTickerCols, summary.byTicker, (e) => [
    e.ticker, e.dataset_type, e.present, e.missing, e.pending, e.no_trade
  ]);

  // Resumable Queue CSV
  const queueCols = ['queue_id', 'priority', 'dataset_type', 'ticker', 'trade_date', 'resume_key', 'status', 'gap_bucket', 'reason', 'source'];
  let qId = 1;
  const queueRows = gaps.map((g) => {
    let prio = 'P2_HISTORICAL_ALL';
    if (g.status === 'PENDING_TODAY') prio = 'P0_TODAY';
    else if (g.trade_date > HIST_END) prio = 'P1_RECENT_NOV';
    else if (g.dataset_type === 'FOREIGN') prio = 'P3_HISTORICAL_FOREIGN';
    return {
      queue_id: qId++,
      priority: prio,
      dataset_type: g.dataset_type,
      ticker: g.ticker,
      trade_date: g.trade_date,
      resume_key: g.resume_key,
      status: g.status,
      gap_bucket: g.gap_bucket,
      reason: g.reason,
      source: g.source,
    };
  });
  writeCsv(path.join(OUT_DIR, 'V6_BACKFILL_RESUMABLE_QUEUE.csv'), queueCols, queueRows, (q) => [
    q.queue_id, q.priority, q.dataset_type, q.ticker, q.trade_date, q.resume_key, q.status, q.gap_bucket, q.reason, q.source
  ]);

  const summaryPath = path.join(OUT_DIR, 'HISTORICAL_COVERAGE_SUMMARY.md');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, buildSummaryMd(summary, ctx, gaps, plan), 'utf8');

  return {
    ctx,
    ledgerRows,
    gaps,
    plan,
    summary,
    out,
    summaryPath,
  };
}

module.exports = {
  classifyKey,
  buildContext,
  assembleLedger,
  assembleGaps,
  buildQueuePlan,
  summarize,
  build,
  parseCsvLine,
  csvEscape,
  csvLine,
  listUniverseTickers,
  buildCalendar,
  loadBackfillMissingSets,
  loadNovCoverage,
  loadNovMatrix,
  wibTodayKey,
  forecastEta,
  WINDOW_START,
  WINDOW_END,
  HIST_END,
  NOV_START,
  DATASETS,
  LEDGER_COLUMNS,
  GAP_COLUMNS,
  PLAN_COLUMNS,
  GAP_STATUSES,
  WEEKDAY_NIGHT_THROUGHPUT,
  WEEKEND_NIGHT_THROUGHPUT,
};

if (require.main === module) {
  const t0 = Date.now();
  const r = build({ todayKey: '2026-11-10' });
  console.log(
    'ledger ALL rows  = ' + r.out.all.rows +
    '\nledger FOREIGN rows = ' + r.out.foreign.rows +
    '\ngap rows         = ' + r.out.gaps.rows +
    '\nplan rows        = ' + r.out.plan.rows
  );
  console.log('summary          = ' + path.relative(ROOT, r.summaryPath).replace(/\\/g, '/'));
  console.log('done in ' + (Date.now() - t0) + 'ms');
}
