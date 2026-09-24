'use strict';

/**
 * FASE 6 — Forensic audit: Foreign Flow Engine, Foreign Watchlist Daily,
 * Insider / Big Money Tracking.
 *
 * Every test below is a REPRODUCTION of a defect verified directly against the
 * current source tree (zero-trust: no historical audit claim is trusted).
 * Each one fails on the pre-fix code and passes after the minimal patch.
 *
 *   F6-01  foreign_watchlist_daily consumers select `open/high/low`, columns the
 *          schema never defines -> PostgREST HTTP 400 silently degrades the
 *          chart OHLC fallback and the 4th watchlist price source.
 *   F6-02  A row whose `foreign_net` is NULL is reported as "Foreign Neutral"
 *          instead of "Foreign Data Unavailable" (missing != zero).
 *   F6-03  `CC` (Mandiri Sekuritas — DOMESTIC) is counted as a foreign
 *          institutional broker, contradicting FOREIGN_BROKERS in
 *          lib/foreign-flow-recap.js and its own regression test.
 *   F6-04  toNumericOrNull() cannot parse Indonesian thousands-separated feed
 *          strings ("3.200.142.830") -> share balances silently become null.
 *   F6-05  aggregateInsiderHoldings() uses the TOTAL BALANCE (`shares`) as the
 *          transaction delta when `shares_change` is absent -> fabricated
 *          accumulation of billions of shares.
 *   F6-06  Insider trade date and OJK/BEI filing date are not distinguished,
 *          so no consumer can tell when the signal actually became public
 *          (time-leak / provenance loss).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bandarmologiService = require('../lib/bandarmologi-service');
const insiderNetworkService = require('../lib/insider-network-service');
const watchlistService = require('../lib/user-watchlist-service');
const adminForeignUpload = require('../lib/admin-foreign-upload');
const sectorHot = require('../api/sector-hot');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sectorHotTest = sectorHot.__test;

// ---------------------------------------------------------------------------
// F6-01 — schema/field mapping integrity (BUG-FASE1-001 class)
// ---------------------------------------------------------------------------

const FOREIGN_MIGRATION = 'supabase/foreign-watchlist-daily-migration.sql';

/**
 * Derive the authoritative column set of foreign_watchlist_daily straight from
 * the migration that creates it. A column that is not declared here does not
 * exist, and selecting it makes PostgREST answer HTTP 400.
 */
function declaredForeignColumns() {
  const sql = read(FOREIGN_MIGRATION);
  const columns = new Set();

  const createMatch = /CREATE TABLE IF NOT EXISTS\s+foreign_watchlist_daily\s*\(([\s\S]*?)\n\);/i.exec(sql);
  if (createMatch) {
    for (const rawLine of createMatch[1].split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(line)) continue;
      const name = /^([a-z_][a-z0-9_]*)\s/i.exec(line);
      if (name) columns.add(name[1].toLowerCase());
    }
  }

  const addRe = /ALTER TABLE\s+foreign_watchlist_daily\s+ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi;
  let add;
  while ((add = addRe.exec(sql)) !== null) columns.add(add[1].toLowerCase());

  return columns;
}

function selectColumnsForForeignTable(relPath) {
  const src = read(relPath);
  const out = [];
  const re = /from\(\s*'foreign_watchlist_daily'\s*\)[\s\S]{0,200}?\.select\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ file: relPath, columns: m[1].split(',').map((c) => c.trim()).filter(Boolean) });
  }
  return out;
}

test('F6-01a: every column selected from foreign_watchlist_daily is declared in the migration', () => {
  const declared = declaredForeignColumns();
  assert.ok(declared.has('trade_date'), 'sanity: migration parser must see trade_date');
  assert.ok(declared.has('ticker'), 'sanity: migration parser must see ticker');
  assert.ok(declared.has('foreign_net'), 'sanity: migration parser must see foreign_net');

  const consumers = [
    'lib/foreign-flow-store.js',
    'lib/user-watchlist-service.js',
    'lib/chart-image-renderer.js',
    'lib/daytrade-screener-engine.js',
    'api/sector-hot.js'
  ];

  const offenders = [];
  for (const rel of consumers) {
    for (const sel of selectColumnsForForeignTable(rel)) {
      for (const col of sel.columns) {
        if (col === '*') continue;
        if (!declared.has(col.toLowerCase())) {
          offenders.push(`${sel.file} selects "${col}" (not in ${FOREIGN_MIGRATION})`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'PostgREST returns HTTP 400 for an unknown column, so these selects fail silently:\n' + offenders.join('\n')
  );
});

test('F6-01b: foreign CSV upload persists open/high/low instead of dropping the parsed values', () => {
  const csv = [
    'date,ticker,open,high,low,close,volume,freq,valuasi,nbsa',
    '2026-09-23,BBCA,8500,8600,8450,8575,1000,20,8575000,10'
  ].join('\n');

  const parsed = adminForeignUpload.parseForeignCsv(csv);
  const row = parsed.rows[0];

  assert.equal(row.open, 8500, 'open must survive the parser');
  assert.equal(row.high, 8600, 'high must survive the parser');
  assert.equal(row.low, 8450, 'low must survive the parser');
});

// ---------------------------------------------------------------------------
// F6-02 — missing foreign data must never be labelled "Foreign Neutral"
// ---------------------------------------------------------------------------

test('F6-02: rows whose foreign_net is NULL report "Foreign Data Unavailable", not "Foreign Neutral"', () => {
  assert.ok(sectorHotTest, 'api/sector-hot must expose its __test surface');
  const derive = sectorHotTest.deriveForeignConfluenceFromRows;
  assert.equal(typeof derive, 'function', 'deriveForeignConfluenceFromRows must be testable');

  const allNull = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: null, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: null, close: 990 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: null, close: 980 }
  ]);

  assert.equal(allNull.foreign_label, 'Foreign Data Unavailable');
  assert.equal(allNull.foreign_1d, null, 'a missing 1D value is null, never 0');
  assert.equal(allNull.foreign_3d, null, 'a missing 3D sum is null, never 0');
  assert.equal(allNull.foreign_7d, null, 'a missing 7D sum is null, never 0');

  // A genuine zero (real row, real 0 net) is still a real observation and must
  // keep the neutral classification rather than being reported as missing.
  const realZero = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: 0, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: 0, close: 1000 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: 0, close: 1000 }
  ]);
  assert.equal(realZero.foreign_label, 'Foreign Neutral');
  assert.equal(realZero.foreign_1d, 0);
});

test('F6-02b: a partially-null window only sums observed sessions and flags the gap', () => {
  const derive = sectorHotTest.deriveForeignConfluenceFromRows;
  const partial = derive([
    { trade_date: '2026-09-23', ticker: 'X', foreign_net: null, close: 1000 },
    { trade_date: '2026-09-22', ticker: 'X', foreign_net: 500, close: 990 },
    { trade_date: '2026-09-21', ticker: 'X', foreign_net: 700, close: 980 }
  ]);

  assert.equal(partial.foreign_1d, null, 'the newest session has no data, so 1D is null');
  assert.equal(partial.foreign_3d, 1200, '3D must sum only the observed sessions');
  assert.equal(partial.foreign_7d, 1200);
  assert.equal(partial.foreign_sessions_missing, 1);
  assert.notEqual(partial.foreign_label, 'Foreign Neutral');
});

// ---------------------------------------------------------------------------
// F6-03 — domestic broker CC must not inflate foreign buy
// ---------------------------------------------------------------------------

test('F6-03: CC (Mandiri Sekuritas) is domestic and must never count as foreign buy', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-f6-foreign-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const ticker = 'F6FOREIGN';
    bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', {
      stock_code: ticker,
      date: '2026-09-23',
      gross_buyers: [
        { broker_code: 'CC', bval: 9000000000, bvol: 9000000 }, // domestic
        { broker_code: 'AK', bval: 5000000000, bvol: 5000000 }  // foreign (UBS)
      ],
      gross_sellers: [
        { broker_code: 'YP', sval: 1000000000, svol: 1000000 }  // domestic
      ],
      brokers: [
        { broker_code: 'CC', bval: 9000000000, sval: 0, nval: 9000000000 },
        { broker_code: 'AK', bval: 5000000000, sval: 0, nval: 5000000000 },
        { broker_code: 'YP', bval: 0, sval: 1000000000, nval: -1000000000 }
      ]
    });

    const flow = bandarmologiService.getNetForeignFlow(ticker);
    assert.ok(flow, 'foreign flow object expected');
    assert.equal(flow.has_data, true);
    assert.equal(
      flow.foreign_buy,
      5000000000,
      'only AK is foreign; CC (Mandiri) is a domestic broker'
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
  }
});

// ---------------------------------------------------------------------------
// F6-04 — Indonesian thousands-separated feed strings
// ---------------------------------------------------------------------------

test('F6-04: normalizeInsiders parses thousands-separated share values instead of dropping them', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    {
      name: 'ADARO STRATEGIC INVESTMENTS',
      action_type: 'BUY',
      broker: 'AK',
      current_value: '3.200.142.830',
      changes_value: '12.500.000',
      current_percentage: '41,1%'
    }
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(
    normalized[0].shares_after,
    3200142830,
    '"3.200.142.830" is 3,200,142,830 shares, not an unparseable value'
  );
  assert.equal(normalized[0].shares_change, 12500000, '"12.500.000" is 12,500,000 shares');
  assert.equal(normalized[0].last_change, 12500000);
});

test('F6-04b: plain numeric and dot-decimal feeds keep working after the loose parse', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    { name: 'A', action_type: 'BUY', broker: 'AK', current_value: 3200142830, changes_value: 12500000 },
    { name: 'B', action_type: 'SELL', broker: 'BK', current_value: '1,500,000', changes_value: '-250,000' }
  ]);

  assert.equal(normalized[0].shares_after, 3200142830);
  assert.equal(normalized[0].shares_change, 12500000);
  assert.equal(normalized[1].shares_after, 1500000);
  assert.equal(normalized[1].shares_change, -250000);
});

// ---------------------------------------------------------------------------
// F6-05 — balance is not a transaction delta
// ---------------------------------------------------------------------------

test('F6-05: aggregateInsiderHoldings never treats a holding balance as a purchase', () => {
  const balanceOnly = [
    {
      ticker: 'AADI',
      insider_name: 'ADARO STRATEGIC INVESTMENTS',
      action_type: 'BUY',
      // Feed carried the absolute balance but no transaction delta at all.
      shares: 3200142830,
      shares_change: null
    }
  ];

  const aggregated = insiderNetworkService.aggregateInsiderHoldings(balanceOnly);
  assert.equal(aggregated.length, 1);
  const holding = aggregated[0].holdings[0];

  assert.equal(holding.total_bought, 0, 'a balance with no delta is NOT a purchase');
  assert.equal(holding.net_shares_change, 0, 'no delta means no net change');
  assert.equal(holding.shares, 3200142830, 'the balance itself is still reported');
});

test('F6-05b: a real shares_change still accumulates normally', () => {
  const withDelta = [
    { ticker: 'TEST', insider_name: 'Buyer', action_type: 'BUY', shares_change: 1000000, shares: 5000000 },
    { ticker: 'TEST', insider_name: 'Buyer', action_type: 'SELL', shares_change: 250000, shares: 4750000 }
  ];

  const holding = insiderNetworkService.aggregateInsiderHoldings(withDelta)[0].holdings[0];
  assert.equal(holding.total_bought, 1000000);
  assert.equal(holding.total_sold, 250000);
  assert.equal(holding.net_shares_change, 750000);
});

// ---------------------------------------------------------------------------
// F6-06 — trade date vs filing date
// ---------------------------------------------------------------------------

test('F6-06: normalizeInsiders preserves the filing date so signals are not backdated', () => {
  const normalized = bandarmologiService.normalizeInsiders([
    {
      name: 'Dir Filing',
      action_type: 'BUY',
      broker: 'AK',
      transaction_date: '2026-09-10',
      filing_date: '2026-09-15',
      current_value: 1000000
    },
    {
      name: 'Dir Legacy',
      action_type: 'BUY',
      broker: 'AK',
      date: '2026-09-12',
      current_value: 1000000
    }
  ]);

  assert.equal(normalized[0].date, '2026-09-10', 'the trade date stays the trade date');
  assert.equal(normalized[0].filing_date, '2026-09-15', 'the filing date must be preserved');
  assert.equal(
    normalized[0].signal_available_date,
    '2026-09-15',
    'a signal may only be considered available once it was filed'
  );

  assert.equal(normalized[1].date, '2026-09-12');
  assert.equal(
    normalized[1].filing_date,
    null,
    'an unknown filing date must stay unknown, never be assumed equal to the trade date'
  );
  assert.equal(
    normalized[1].signal_available_date,
    null,
    'without a filing date there is no verified availability date'
  );
});
