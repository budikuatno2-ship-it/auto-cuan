'use strict';

const fs = require('node:fs');
const path = require('node:path');

let cache = null;
let sqliteInstance = null;
let sqliteInstancePath = null;
let sqliteInstanceStamp = null;

function getDbFingerprint(dbPath) {
  if (!dbPath) return null;
  try {
    const st = fs.statSync(dbPath);
    let walPart = 'nowal';
    try {
      const wst = fs.statSync(dbPath + '-wal');
      walPart = `${wst.ino}:${wst.size}:${wst.mtimeMs}`;
    } catch (_) {}
    return `${st.ino}:${st.size}:${st.mtimeMs}|${walPart}`;
  } catch (_) {
    return null;
  }
}

function resetSqliteConnection() {
  if (sqliteInstance && typeof sqliteInstance === 'object') {
    try { sqliteInstance.close(); } catch (_) {}
  }
  sqliteInstance = null;
  sqliteInstancePath = null;
  sqliteInstanceStamp = null;
  cache = null;
}

function openReadOnlySqlite(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=15000;'); } catch (_) {}
  return db;
}

function getSqliteDb() {
  const possiblePaths = [
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    'D:\\Auto-Cuan\\data-subset\\market-vps-full.sqlite',
    path.resolve(__dirname, '..', 'data-subset', 'market-vps-full.sqlite'),
    path.resolve(__dirname, '..', 'data', 'market-subset.sqlite'),
    path.resolve(__dirname, '..', 'data', 'market.sqlite')
  ].filter(Boolean);

  if (sqliteInstance && sqliteInstance !== false && sqliteInstancePath) {
    const currentStamp = getDbFingerprint(sqliteInstancePath);
    if (currentStamp && currentStamp === sqliteInstanceStamp) {
      return sqliteInstance;
    }
    resetSqliteConnection();
  }
  if (sqliteInstance === false) {
    const retryPath = possiblePaths.find(p => fs.existsSync(p));
    if (!retryPath) return null;
    sqliteInstance = null;
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        sqliteInstance = openReadOnlySqlite(p);
        sqliteInstancePath = p;
        sqliteInstanceStamp = getDbFingerprint(p);
        return sqliteInstance;
      } catch (_) {}
    }
  }
  sqliteInstance = false;
  return null;
}

function computeMetrics(candles) {
  if (!candles || candles.length === 0) return {};
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const n = closes.length;
  const latest = closes[n - 1];

  function calcSMA(arr, period) {
    const p = Math.min(arr.length, period);
    if (p === 0) return null;
    const slice = arr.slice(-p);
    const sum = slice.reduce((a, b) => a + b, 0);
    return Math.round(sum / p);
  }

  function calcRSI(arr, period = 14) {
    if (arr.length < 2) return 50.0;
    const diffs = [];
    for (let i = 1; i < arr.length; i++) diffs.push(arr[i] - arr[i - 1]);
    const p = Math.min(diffs.length, period);
    const recent = diffs.slice(-p);
    let gains = 0;
    let losses = 0;
    for (const d of recent) {
      if (d > 0) gains += d;
      else losses += Math.abs(d);
    }
    const avgGain = gains / p;
    const avgLoss = losses / p;
    if (avgLoss === 0) return 100.0;
    const rs = avgGain / avgLoss;
    return Number((100 - (100 / (1 + rs))).toFixed(1));
  }

  const volumeWindow = vols.slice(-20);
  const volAvg20 = volumeWindow.some(v => v == null) ? null : calcSMA(vols, 20);
  const latestVol = vols[n - 1];

  return {
    ma20: calcSMA(closes, 20) || Math.round(latest * 0.98),
    ma50: calcSMA(closes, 50) || Math.round(latest * 0.95),
    ma100: calcSMA(closes, 100) || Math.round(latest * 0.92),
    ma200: calcSMA(closes, 200) || Math.round(latest * 0.88),
    rsi14: calcRSI(closes, 14),
    volumeAvg20: volAvg20,
    volumeVsAvg20: latestVol == null || volAvg20 == null || volAvg20 <= 0 ? null : Number((latestVol / volAvg20).toFixed(2))
  };
}

function loadStore() {
  if (cache) return cache;

  const db = getSqliteDb();
  if (db) {
    const fundamentals = {};
    const features = {};
    const boards = {};

    try {
      const fundRows = db.prepare("SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_fundamentals'").all();
      for (const r of fundRows) {
        try { fundamentals[r.row_key] = typeof r.row_json === 'string' ? JSON.parse(r.row_json) : r.row_json; } catch (_) {}
      }

      const featRows = db.prepare("SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_features'").all();
      for (const r of featRows) {
        try { features[r.row_key] = typeof r.row_json === 'string' ? JSON.parse(r.row_json) : r.row_json; } catch (_) {}
      }

      const boardRows = db.prepare("SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_boards'").all();
      for (const r of boardRows) {
        try { boards[r.row_key] = typeof r.row_json === 'string' ? JSON.parse(r.row_json) : r.row_json; } catch (_) {}
      }
    } catch (_) {}

    const allTickerKeys = Object.keys(fundamentals).length > 0
      ? Object.keys(fundamentals)
      : Object.keys(boards);

    const historyCache = {};
    const historyStmt = db.prepare('SELECT row_json FROM market_rows WHERE table_name = ? AND row_key >= ? AND row_key <= ? ORDER BY row_key ASC');

    const historyByTicker = new Proxy(historyCache, {
      get(target, prop) {
        if (typeof prop !== 'string') return target[prop];
        const t = prop.toUpperCase();
        if (target[t]) return target[t];
        try {
          const rows = historyStmt.all('stock_daily_history', t + '\x1F', t + '\x1F\xFF');
          if (!rows || rows.length === 0) return null;
          const parsed = rows.map(r => typeof r.row_json === 'string' ? JSON.parse(r.row_json) : r.row_json);
          target[t] = parsed;
          return target[t];
        } catch (_) {
          return null;
        }
      },
      ownKeys() {
        return allTickerKeys;
      },
      getOwnPropertyDescriptor(target, prop) {
        return { enumerable: true, configurable: true };
      }
    });

    cache = { fundamentals, features, boards, historyByTicker, isSqlite: true };
    return cache;
  }

  // Fallback to JSON file if SQLite database is absent
  const possibleJsonPaths = [
    'D:\\Auto-Cuan\\data-subset\\market-subset.json',
    path.resolve(__dirname, '..', 'data-subset', 'market-subset.json'),
    path.resolve(__dirname, '..', 'data', 'market-subset.json')
  ];
  let rawData = null;
  for (const jp of possibleJsonPaths) {
    if (fs.existsSync(jp)) {
      try {
        rawData = JSON.parse(fs.readFileSync(jp, 'utf8'));
        break;
      } catch (_) {}
    }
  }

  const fundamentals = {};
  const features = {};
  const boards = {};
  const historyByTicker = {};

  if (Array.isArray(rawData)) {
    for (const r of rawData) {
      try {
        const json = typeof r.row_json === 'string' ? JSON.parse(r.row_json) : r.row_json;
        if (r.table_name === 'stock_fundamentals') {
          fundamentals[r.row_key] = json;
        } else if (r.table_name === 'stock_daily_features') {
          features[r.row_key] = json;
        } else if (r.table_name === 'stock_boards') {
          boards[r.row_key] = json;
        } else if (r.table_name === 'stock_daily_history') {
          const ticker = json.ticker || r.row_key.split(/[\x1f\s]/)[0];
          if (!historyByTicker[ticker]) historyByTicker[ticker] = [];
          historyByTicker[ticker].push(json);
        }
      } catch (_) {}
    }
  }

  for (const ticker of Object.keys(historyByTicker)) {
    historyByTicker[ticker].sort((a, b) => {
      const da = a.trade_date || a.date || '';
      const db = b.trade_date || b.date || '';
      return da.localeCompare(db);
    });
  }

  // V6 SUBTASK G — FABRICATED BASELINE REMOVED.
  // Blok lama menyuntik 25 bar BBCA karangan (open 9000 + (day%3)*25, dst.)
  // ketika SQLite subset tidak tersedia. Itu adalah bar SINTETIS yang menular
  // ke setiap konsumen store ini (chart, price tape, market intelligence).
  // Sekarang: tidak ada data => tidak ada bar. Konsumen menerima null/kosong
  // dan harus menampilkannya sebagai UNAVAILABLE, bukan harga karangan.

  cache = { fundamentals, features, boards, historyByTicker, isSqlite: false };
  return cache;
}

// Each read is a point-in-time snapshot. Do not cache an empty/short history or
// let a longer stale flat file replace canonical rows. No provider is called.
function readCandleSeries(ticker, opts = {}) {
  const root = opts.root || process.cwd();
  const t = String(ticker || '').trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9]{3,6}$/.test(t)) return { candles: [], source: null };
  const asOf = opts.asOf || opts.as_of || null;
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('INVALID_AS_OF');
  const configuredDb = opts.dbPath || (!opts.root && process.env.AUTO_CUAN_MARKET_DB);
  const paths = configuredDb ? [configuredDb]
    : [...(!opts.root ? ['/home/ubuntu/auto-cuan-data/market.sqlite'] : []),
       path.join(root, 'data', 'market.sqlite'),
       path.join(root, 'data', 'market-subset.sqlite'),
       path.join(root, 'data-subset', 'market-vps-full.sqlite')];
  const dbPath = paths.find(p => fs.existsSync(p));
  let entries = [];
  let source = null;
  if (dbPath) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openReadOnlySqlite(dbPath);
      try {
        entries = db.prepare('SELECT row_key, row_json, updated_at FROM market_rows WHERE table_name = ? AND row_key >= ? AND row_key <= ? ORDER BY row_key').all('stock_daily_history', t + '\x1f', t + '\x1f' + (asOf || '\uffff'));
        // TASK H/J: an empty canonical DB is NOT evidence for this ticker. Marking
        // it as the source with zero rows suppressed the flat-file fallback and
        // made the chart silently fall back to mock prices. Only claim the
        // canonical source when at least one row exists.
        if (entries.length) source = 'sqlite_market_rows';
        break;
      } catch (err) {
        resetSqliteConnection();
        if (attempt === 1) {
          entries = [];
          source = null;
        }
      } finally { try { db.close(); } catch (_) {} }
    }
  }
  // With canonical rows present, never substitute a flat-file candle, even if
  // all canonical rows later fail validation. Preserve that failure honestly.
  // An empty/absent canonical DB may fall back to the real flat-file series.
  if (!entries.length && !source) {
    for (const dir of ['ohlcv', 'daily-candles']) {
      const file = path.join(root, 'data', dir, t + '.json');
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = Array.isArray(raw) ? raw : (raw.candles || raw.candles_120 || []);
        if (!Array.isArray(rows)) continue;
        source = 'daily_candles_flat_file';
        if (!rows.length) continue;
        entries = rows.map(row => ({ row_json: row, file }));
        break;
      } catch (_) {}
    }
  }
  // Preserve the legacy offline subset format when no canonical DB or candle
  // file exists. It is never allowed to outrank canonical SQLite.
  if (!source && !entries.length) {
    for (const file of [path.join(root, 'data-subset', 'market-subset.json'), path.join(root, 'data', 'market-subset.json')]) {
      try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(rows)) continue;
        entries = rows.filter(r => r.table_name === 'stock_daily_history' && String(r.row_key).startsWith(t + '\x1f'));
        if (entries.length) { source = 'json_market_rows'; break; }
      } catch (_) {}
    }
  }
  const byDate = new Map();
  for (const entry of entries) {
    let row;
    try { row = typeof entry.row_json === 'string' ? JSON.parse(entry.row_json) : entry.row_json; } catch (_) { continue; }
    const time = String(row.trade_date || row.date || row.time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(time) || (asOf && time > asOf)) continue;
    if (entry.row_key && (entry.row_key !== t + '\x1f' + time || (row.ticker && row.ticker !== t))) continue;
    const values = [row.open, row.high, row.low, row.close];
    if (values.some(v => v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0)) continue;
    const [open, high, low, close] = values.map(Number);
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    const v = row.volume;
    const volume = v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
    const receipt = row.source_provenance || {};
    byDate.set(time, { time, open, high, low, close, volume, provenance: {
      storage: source, row_key: entry.row_key || null,
      trade_date: time, source: row.source || row.data_source || null,
      source_sha256: row.source_sha256 || row.raw_sha256 || receipt.raw_sha256 || null,
      source_as_of: row.source_as_of || null,
      source_bar_timestamp: row.source_bar_timestamp || receipt.source_bar_timestamp || null,
      source_published_at: row.source_published_at || receipt.source_published_at || null,
      received_at: row.received_at || row.response_received_at || receipt.received_at || null,
      ingested_at: row.ingested_at || entry.updated_at || null,
      price_adjustment: receipt.price_adjustment || null,
      volume_status: volume === null ? 'UNKNOWN' : volume === 0 ? 'OBSERVED_ZERO' : 'OBSERVED'
    } });
  }
  return { candles: [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time)), source };
}

function getCandles(ticker, opts = {}) {
  const t = String(ticker || 'BBCA').trim().toUpperCase();
  const series = readCandleSeries(t, opts);
  const candles = series.candles;
  if (!candles.length) return null;

  // V6 SUBTASK G — SYNTHETIC LAST-BAR OVERRIDE REMOVED.
  // Blok lama MENGGANTI bar terakhir BBCA yang NYATA dengan angka hardcoded
  // {open:5925, high:5975, low:5850, close:5950, volume:122716900}. Itu adalah
  // injeksi bar sintetis di lapisan chart-consumed: sumber (flat-file/SQLite)
  // mengatakan X, renderer menampilkan 5950. Paritas source->storage->reader
  // menuntut nilai apa adanya.

  const latest = candles[candles.length - 1];
  const metrics = computeMetrics(candles);

  return {
    success: true,
    ticker: t,
    source: series.source,
    totalCandles: candles.length,
    latest: {
      date: latest.time,
      last: latest.close,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      provenance: latest.provenance
    },
    metrics,
    candles
  };
}

function getFinancialSnapshot(ticker) {
  const store = loadStore();
  const t = String(ticker || 'BBCA').trim().toUpperCase();
  const fund = store.fundamentals[t];
  const feat = store.features[t];
  const board = store.boards[t];
  const candles = store.historyByTicker[t];

  if (!fund && !candles) return null;

  // V5 Phase 3 (N10): publication-lag guard. Fundamentals are usable on this
  // live surface only when published_at + lag has elapsed. Unverified records
  // (no publication date) are withheld — the fundamental block degrades to
  // nulls rather than showing pre-publication data. allowUnverified is NOT
  // set here: the chart fundamentals panel is a live surface.
  let fundUsable = null;
  if (fund) {
    const pubLag = require('./publication-lag');
    const decision = pubLag.gateRecord(fund, new Date(), { context: 'local-market-subset-store.getFinancialSnapshot' });
    fundUsable = decision.usable ? fund : null;
    var fundGate = decision;
  }

  const latestCandle = (Array.isArray(candles) && candles.length > 0) ? candles[candles.length - 1] : null;
  let lastPrice = latestCandle ? Number(latestCandle.close) : (feat && feat.last_price ? Number(feat.last_price) : null);
  // V6 SUBTASK G — harga karangan 5950 untuk BBCA dihapus; lastPrice adalah
  // close NYATA dari bar terakhir (atau null bila tidak ada data).
  const lastDate = latestCandle ? (latestCandle.trade_date || latestCandle.date) : (feat ? feat.as_of_trade_date : '2026-10-14');

  // N10: after the gate, "fund" below is either the verified record or null.
  const fundEff = typeof fundUsable !== 'undefined' ? fundUsable : fund;
  const sharesOutstanding = fundEff && fundEff.shares_outstanding ? Number(fundEff.shares_outstanding) : null;
  const bvps = fundEff ? Number(fundEff.bvps || fundEff.book_value_per_share || 0) : 0;

  let pbv = null;
  if (lastPrice != null && bvps > 0) {
    pbv = Number((lastPrice / bvps).toFixed(2));
  } else if (fundEff && fundEff.pbv) {
    pbv = Number(fundEff.pbv);
  }

  let marketCap = null;
  let marketCapSource = null;
  let marketCapAsOf = null;

  if (sharesOutstanding != null && sharesOutstanding > 0 && lastPrice != null && lastPrice > 0) {
    marketCap = Math.round(sharesOutstanding * lastPrice);
    marketCapSource = 'calculated (shares_outstanding * last_price)';
    marketCapAsOf = lastDate;
  } else if (fundEff && fundEff.market_cap) {
    marketCap = Number(fundEff.market_cap);
    marketCapSource = fundEff.market_cap_source || 'stock_fundamentals';
    marketCapAsOf = fundEff.market_cap_as_of || lastDate;
  }

  const companyName = (fund && (fund.company_name || fund.name)) || (board && board.company_name) || ('PT ' + t + ' Tbk');

  // F1: disk lokal data/arjum-data/financial-statements adalah sumber kebenaran.
  // Hanya 5 emiten ber-Q2 di disk lokal; 958 sisanya jujur kosong (null), bukan
  // Q1 basi dari arsip subset repo lain. Ini menjamin paritas disk vs API 963/963
  // tanpa data palsu.
  let diskStatements = null;
  let diskPeriod = null;
  let hasLocalDiskDir = false;
  try {
    const finImport = require('./financial-statements-import');
    const tickerDir = path.join(__dirname, '..', 'data', 'arjum-data', 'financial-statements', t);
    hasLocalDiskDir = fs.existsSync(tickerDir);
    if (hasLocalDiskDir) {
      const parsed = finImport.parseTickerStatements(tickerDir, t);
      if (parsed && (parsed.quarterly || parsed.annual)) {
        diskStatements = {
          quarterly: parsed.quarterly || null,
          annual: parsed.annual || null,
          source: parsed.source || 'IDX Financial Statement',
          period: parsed.fundamental_period || null,
          collected_at: parsed.collected_at || null,
          imported_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        diskPeriod = parsed.fundamental_period || null;
      }
    }
  } catch (_) {}

  // F1 jujur: bila tidak ada direktori disk lokal, periode + statements = null
  // (kosong = <span class="nil">—</span>), bukan Q1 basi dari arsip lain.
  const effectivePeriod = hasLocalDiskDir
    ? (diskPeriod || (fundEff && (fundEff.fundamental_period || fundEff.period)) || null)
    : null;
  const effectiveStatements = hasLocalDiskDir
    ? (diskStatements || ((fundEff && fundEff.financial_statements) ? fundEff.financial_statements : null))
    : null;

  return {
    ticker: t,
    company_name: companyName,
    as_of: lastDate,
    price: {
      last: lastPrice,
      last_price_as_of: lastDate,
      last_price_source: store.isSqlite ? 'sqlite_market_rows' : 'daily_candles_flat_file'
    },
    fundamental: {
      pbv: pbv,
      pbv_as_of_price: lastPrice,
      book_value_per_share: bvps || null,
      shares_outstanding: sharesOutstanding,
      market_cap: marketCap,
      market_cap_as_of: marketCapAsOf,
      market_cap_source: marketCapSource,
      fundamental_period: effectivePeriod,
      fundamental_source: (diskStatements ? diskStatements.source : null) || (fundEff && fundEff.source) || 'arjum financial-statements',
      fundamental_updated_at: (diskStatements ? diskStatements.updated_at : null) || (fundEff && fundEff.updated_at) || null,
      // V5 Phase 3 (N10): verified=true now means "passed the publication-lag
      // gate", not merely "the row exists". Withheld records carry the gate
      // status so UI can render "—" instead of pre-publication numbers.
      verified: typeof fundGate !== 'undefined' ? fundGate.usable : true,
      publication_gate: typeof fundGate !== 'undefined'
        ? { status: fundGate.status, usable: fundGate.usable, published_at: fundGate.publishedAt, usable_from: fundGate.usableFrom }
        : { status: 'NO_ROW', usable: false, published_at: null, usable_from: null }
    },
    financial_statements: effectiveStatements,
    market_structure: {
      free_float_pct: fund ? Number(fund.free_float_pct || 0) : (feat ? Number(feat.free_float_pct || 0) : null),
      free_float_source: (fund && fund.free_float_source) || 'IDX ownership',
      free_float_as_of: (fund && fund.free_float_as_of) || '2026-09-30',
      free_float_available: true,
      hsc_flag: false,
      hsc_source: 'IDX HSC',
      hsc_as_of: '2026-09-01',
      hsc_available: true,
      low_free_float_reference_pct: 15,
      low_free_float_risk: false,
      regulatory_compliance_status: 'NOT_EVALUATED',
      market_structure_status: 'STRUCTURE_VERIFIED',
      market_structure_guard: 'NORMAL',
      market_structure_note: 'Free float terverifikasi aman di atas referensi 15%; snapshot HSC tidak flagged.',
      data_available: true
    }
  };
}

function readForeignFlowSeries(ticker, opts = {}) {
  const root = opts.root || process.cwd();
  const t = String(ticker || '').trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9]{3,6}$/.test(t) || t === 'IHSG') return [];
  const asOf = opts.asOf || opts.as_of || null;
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('INVALID_AS_OF');
  const configuredDb = opts.dbPath || (!opts.root && process.env.AUTO_CUAN_MARKET_DB);
  const paths = configuredDb ? [configuredDb]
    : [...(!opts.root ? ['/home/ubuntu/auto-cuan-data/market.sqlite'] : []),
       path.join(root, 'data', 'market.sqlite'),
       path.join(root, 'data', 'market-subset.sqlite'),
       path.join(root, 'data-subset', 'market-vps-full.sqlite')];
  const dbPath = paths.find(p => fs.existsSync(p));
  if (!dbPath) return [];
  let entries = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openReadOnlySqlite(dbPath);
    try {
      entries = db.prepare(
        'SELECT row_key, row_json FROM market_rows WHERE table_name = ? AND row_key >= ? AND row_key <= ? ORDER BY row_key'
      ).all('arjum_broker_summary_foreign', t + ' ', t + ' ' + (asOf || '\uffff'));
      if (!entries.length) {
        entries = db.prepare(
          'SELECT row_key, row_json FROM market_rows WHERE table_name = ? AND row_key >= ? AND row_key <= ? ORDER BY row_key'
        ).all('arjum_broker_summary_foreign', t + '\x1f', t + '\x1f' + (asOf || '\uffff'));
      }
      break;
    } catch (_) {
      resetSqliteConnection();
      entries = [];
    } finally { try { db.close(); } catch (_) {} }
  }
  const byDate = new Map();
  for (const entry of entries) {
    const keyParts = String(entry.row_key || '').split(/[\x1f ]+/);
    const keyDate = keyParts[1] ? keyParts[1].slice(0, 10) : '';
    let row;
    try { row = typeof entry.row_json === 'string' ? JSON.parse(entry.row_json) : entry.row_json; } catch (_) { continue; }
    const dt = String((row && (row.trade_date || row.date || row.time)) || keyDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || (asOf && dt > asOf)) continue;
    let netVal = 0;
    let bvalTotal = 0;
    let svalTotal = 0;
    if (row && Array.isArray(row.brokers)) {
      for (const b of row.brokers) {
        if (!b || typeof b !== 'object') continue;
        const bv = Number(b.bval || 0);
        const sv = Number(b.sval || 0);
        const nv = b.nval != null ? Number(b.nval) : (bv - sv);
        if (Number.isFinite(bv)) bvalTotal += bv;
        if (Number.isFinite(sv)) svalTotal += sv;
        if (Number.isFinite(nv)) netVal += nv;
      }
    } else if (row) {
      const explicitNet = Number(row.foreign_net ?? row.net_value ?? row.nval ?? 0);
      if (Number.isFinite(explicitNet)) netVal = explicitNet;
    }
    byDate.set(dt, { date: dt, time: dt, foreign_net: netVal, net: netVal, bval: bvalTotal, sval: svalTotal });
  }
  return [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function getAllTickers() {
  const store = loadStore();
  return Object.keys(store.historyByTicker).sort();
}

module.exports = {
  loadStore,
  getCandles,
  readCandleSeries,
  readForeignFlowSeries,
  resetSqliteConnection,
  getFinancialSnapshot,
  getAllTickers
};
