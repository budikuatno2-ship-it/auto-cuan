'use strict';

// Read-only validation universe. This deliberately starts from the official
// board master rather than published Day Trade result rows.
const engine = require('./daytrade-screener-engine');

const SOURCE = 'full_daytrade_eligible_universe';
const PAGE_SIZE = 1000;

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => Object.assign({}, row, {
    ticker: engine.normalizeUniverseTicker ? engine.normalizeUniverseTicker(row && row.ticker) : String(row && row.ticker || '').trim().toUpperCase(),
    universe_source: 'stock_boards'
  })).filter((row) => row.ticker);
}

function buildFullEligibleUniverse(boardRows, foreignRows) {
  // Foreign-only rows are supplied only for deterministic diagnostics/tests;
  // they cannot pass the strict official-board eligibility gate.
  const rows = normalizeRows(boardRows).concat(Array.isArray(foreignRows) ? foreignRows.map((row) => Object.assign({}, row, { universe_source: 'foreign_latest' })) : []);
  const filtered = engine.filterDayTradeUniverse(rows);
  return {
    source: SOURCE,
    tickers: filtered.tickers,
    excluded: filtered.diagnostics.sample_excluded || [],
    diagnostics: filtered.diagnostics
  };
}

function redactError(value) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return String(value && value.message ? value.message : value || '').split(key || '\u0000').join('[REDACTED_SUPABASE_SERVICE_ROLE_KEY]');
}

async function loadAllStockBoards(fetchFn) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const request = fetchFn || fetch;
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL('/rest/v1/stock_boards', base.replace(/\/+$/, '') + '/');
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'ticker.asc');
    let response;
    try {
      response = await request(url.toString(), { headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json', Range: `${offset}-${offset + PAGE_SIZE - 1}` } });
    } catch (error) { throw new Error('Supabase stock_boards fetch failed: ' + redactError(error)); }
    if (!response.ok) throw new Error('Supabase stock_boards fetch failed with HTTP ' + response.status + ': ' + redactError(await response.text()));
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Supabase stock_boards response was not an array');
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function loadFullEligibleUniverseFromSupabase(fetchFn) {
  return buildFullEligibleUniverse(await loadAllStockBoards(fetchFn));
}

module.exports = { SOURCE, PAGE_SIZE, buildFullEligibleUniverse, loadAllStockBoards, loadFullEligibleUniverseFromSupabase };
