'use strict';

/**
 * FASE 3 audit fixture — stub VPS Data Bridge with switchable failure modes.
 *
 * Must run as a SEPARATE PROCESS: lib/vps-data-fetcher.js performs its sync
 * bridge call through execFileSync, which blocks the caller's event loop, so an
 * in-process server could never answer. Keeping it out of process means the
 * production code path stays completely real while remaining offline.
 *
 * Prints the bound port on stdout as:  BRIDGE_PORT=<port>
 *
 * Modes (env FASE3_STUB_MODE):
 *   ok            (default) — 200 with a broker summary whose VWAP is FASE3_STUB_VWAP
 *   rate_limited            — 429 for every /api/broker-summary request
 *   gateway_down            — 503 for every /api/available-dates request
 *
 * Every request is echoed on stdout as "REQ <method> <path>" so a test can
 * count real upstream traffic without patching the production client.
 */

const http = require('node:http');

const MODE = String(process.env.FASE3_STUB_MODE || 'ok').trim().toLowerCase();
const VWAP = Number(process.env.FASE3_STUB_VWAP || 914);
const TRADE_DATE = String(process.env.FASE3_STUB_DATE || '2026-09-23');

/**
 * Broker rows whose volume-weighted average price is exactly VWAP, using two
 * rows so the result is a genuine weighted average rather than a single value.
 */
function brokerSummaryPayload(ticker, date) {
  return {
    stock_code: ticker,
    broker_start_date: date,
    broker_end_date: date,
    brokers: [
      { broker_code: 'YP', broker_name: 'Mirae', bval: VWAP * 1000, bvol: 1000, sval: 0, svol: 0, bfrq: 5, sfrq: 1 },
      { broker_code: 'CC', broker_name: 'Mandiri', bval: VWAP * 100, bvol: 100, sval: 0, svol: 0, bfrq: 2, sfrq: 0 }
    ]
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  process.stdout.write(`REQ ${req.method} ${url.pathname}\n`);
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/api/available-dates') {
    if (MODE === 'gateway_down') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'service unavailable' }));
    }
    const ticker = String(url.searchParams.get('ticker') || '').toUpperCase();
    return res.end(JSON.stringify({ ticker, dates: [TRADE_DATE, '2026-09-22'] }));
  }

  if (url.pathname === '/api/broker-summary') {
    if (MODE === 'rate_limited') {
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    }
    const ticker = String(url.searchParams.get('ticker') || '').toUpperCase();
    const requested = String(url.searchParams.get('date') || 'latest');
    const effective = requested === 'latest' ? TRADE_DATE : requested;
    return res.end(JSON.stringify(brokerSummaryPayload(ticker, effective)));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`BRIDGE_PORT=${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
