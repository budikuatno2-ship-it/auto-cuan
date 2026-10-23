#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY audit for change request C (2026-10-20).
 *
 * Lists the UNKNOWN-board and PEMANTAUAN_KHUSUS tickers that the FAST DayTrade
 * universe admits, with their stock_boards metadata and the eligibility reason
 * that lets them through. Cross-checks the full (800) universe and reports
 * membership. Performs NO writes and prints NO credentials.
 *
 * Run with the repository .env loaded (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 */

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const env = {};
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  });
  return env;
}

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and a Supabase key are required in .env');

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const dtEngine = require('../../lib/daytrade-screener-engine');

  const { data: boards, error } = await supabase
    .from('stock_boards')
    .select('ticker,board,is_active,is_fca,note')
    .eq('is_active', true);
  if (error) throw new Error('stock_boards read failed: ' + error.message);

  const fast = await dtEngine.buildFastDayTradeUniverse(supabase, {});
  const full = await dtEngine.buildDayTradeUniverse(supabase, {});

  const fastTickers = new Set((fast.tickers || []).map((t) => t.ticker));
  const fullTickers = new Set((full.tickers || []).map((t) => t.ticker));
  const boardByTicker = {};
  (boards || []).forEach((b) => { boardByTicker[String(b.ticker).toUpperCase()] = b; });

  const rows = (fast.tickers || []).filter((t) => {
    const b = String((boardByTicker[t.ticker] && boardByTicker[t.ticker].board) || t.board || '').toUpperCase();
    return b === 'UNKNOWN' || b === 'PEMANTAUAN_KHUSUS';
  }).map((t) => {
    const b = boardByTicker[t.ticker] || {};
    const rowForReason = Object.assign({}, b, { ticker: t.ticker });
    return {
      ticker: t.ticker,
      board: b.board || t.board || null,
      listing_status: b.listing_status || null,
      universe_source: t.universe_source || 'stock_boards',
      is_fca: b.is_fca === undefined ? null : b.is_fca,
      note: b.note || null,
      eligibility_reason: dtEngine.dayTradeEligibilityReason(rowForReason, {}) || 'ADMITTED (no reason)',
      in_full_universe: fullTickers.has(t.ticker)
    };
  });

  const out = {
    generated_at: new Date().toISOString(),
    fast_universe_count: (fast.tickers || []).length,
    full_universe_count: (full.tickers || []).length,
    fast_diagnostics: fast.diagnostics || {},
    full_diagnostics: full.diagnostics || {},
    unknown_or_khusus_in_fast: rows,
    unknown_count: rows.filter((r) => String(r.board).toUpperCase() === 'UNKNOWN').length,
    khusus_count: rows.filter((r) => String(r.board).toUpperCase() === 'PEMANTAUAN_KHUSUS').length
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
}

module.exports = { loadEnv, main };
