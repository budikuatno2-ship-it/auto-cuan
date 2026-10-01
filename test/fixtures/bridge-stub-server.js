'use strict';

/**
 * Stub VPS Data Bridge for offline integration tests (BATCH 2).
 *
 * Must run as a SEPARATE PROCESS from the test runner: the production client
 * issues its sync bridge call via execFileSync, which blocks the caller's event
 * loop. An in-process stub could therefore never answer. Running this out of
 * process keeps the production code path 100% real while staying offline.
 *
 * Prints the bound port on stdout as:  BRIDGE_PORT=<port>
 *
 * Fixture truth values are intentionally different from any committed baked
 * index so a stale source can never accidentally satisfy an assertion.
 */

const http = require('node:http');

const LATEST_DATE = '2026-09-14';
const LIVE_VWAP = 914;
const TICKER = 'AUDITB2';
const DATE_COUNT = 172;

function buildTradingDates(fromDate, count) {
  const out = [];
  const d = new Date(fromDate + 'T00:00:00Z');
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const BRIDGE_DATES = buildTradingDates(LATEST_DATE, DATE_COUNT);

/** Broker rows whose volume-weighted average price is exactly LIVE_VWAP. */
function brokerSummaryPayload(ticker, date) {
  return {
    stock_code: ticker,
    broker_start_date: date,
    broker_end_date: date,
    brokers: [
      { broker_code: 'YP', broker_name: 'Mirae', bval: 914000, bvol: 1000, sval: 0, svol: 0, bfrq: 5, sfrq: 1 },
      { broker_code: 'CC', broker_name: 'Mandiri', bval: 91400, bvol: 100, sval: 0, svol: 0, bfrq: 2, sfrq: 0 }
    ]
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/api/available-dates') {
    const ticker = String(url.searchParams.get('ticker') || '').toUpperCase();
    return res.end(JSON.stringify({ ticker, dates: BRIDGE_DATES }));
  }

  if (url.pathname === '/api/broker-summary') {
    const ticker = String(url.searchParams.get('ticker') || '').toUpperCase();
    const date = String(url.searchParams.get('date') || 'latest');
    const effective = date === 'latest' ? LATEST_DATE : date;
    if (!BRIDGE_DATES.includes(effective)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'Data not found', ticker, date }));
    }
    return res.end(JSON.stringify(brokerSummaryPayload(ticker, effective)));
  }

  // Pre-aggregated live intel index (no local write on the consumer side).
  if (url.pathname === '/api/bandarmologi-intel') {
    const range = String(url.searchParams.get('range') || '7d').toLowerCase();
    return res.end(JSON.stringify({
      updated_at: LATEST_DATE + 'T10:00:00.000Z',
      effective_date: LATEST_DATE,
      date: LATEST_DATE,
      range,
      total_evaluated: 1,
      indexes: {
        harga_di_bawah_modal_bandar: [{
          ticker: TICKER,
          current_price: LIVE_VWAP,
          bandar_avg_buy: LIVE_VWAP + 100,
          discount_pct: 8.5,
          top_3_brokers: []
        }],
        silent_foreign_accumulation: [],
        ritel_cutloss_bandar_nampung: [],
        distribusi_ke_ritel: [],
        cr3_massive: []
      }
    }));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`BRIDGE_PORT=${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
