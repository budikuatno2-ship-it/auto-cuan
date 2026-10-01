#!/usr/bin/env node
'use strict';

/**
 * Add the 1 Oct 2026 HSC entrants BIKE + MSJA to the VPS-local canonical HSC
 * dataset and enrich them from the already-existing ownership/free-float
 * snapshot.
 *
 * Source split is intentional:
 *   - IDX HSC announcement/page => official HSC membership/status.
 *   - data/market-structure/latest.json => ownership detail + derived free float.
 *
 * Safe by default: validate/dry-run only. Use --apply to write.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MARKET_PATH = path.join(ROOT, 'data', 'market-structure', 'latest.json');
const DEFAULT_HSC_PATH = path.join(ROOT, 'data', 'market-structure', 'hsc', 'current-2026.json');

const HSC_ADDITIONS = Object.freeze([
  Object.freeze({
    ticker: 'BIKE',
    hsc_2026_status: 'IMPOSED',
    hsc_as_of: '2026-10-01',
    official_concentration_pct: 93.08,
    concentration_basis_as_of: '2026-09-28'
  }),
  Object.freeze({
    ticker: 'MSJA',
    hsc_2026_status: 'IMPOSED',
    hsc_as_of: '2026-10-01',
    official_concentration_pct: 98.62,
    concentration_basis_as_of: '2026-09-25'
  })
]);

function cleanTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assertIsoDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text + 'T00:00:00Z'))) {
    throw new Error((label || 'date') + ' tidak valid: ' + String(value || '(kosong)'));
  }
  return text;
}

function buildMarketLookup(marketPayload) {
  if (!marketPayload || !Array.isArray(marketPayload.stocks)) {
    throw new Error('market-structure/latest.json tidak memiliki stocks array.');
  }
  const byTicker = new Map();
  for (const stock of marketPayload.stocks) {
    const ticker = cleanTicker(stock && stock.ticker);
    if (!ticker) continue;
    if (byTicker.has(ticker)) throw new Error('Ticker duplikat di market-structure/latest.json: ' + ticker);
    byTicker.set(ticker, stock);
  }
  return byTicker;
}

function buildEnrichedEntry(marketStock, meta) {
  const ticker = cleanTicker(meta && meta.ticker);
  if (!ticker) throw new Error('Ticker HSC tambahan kosong.');

  if (!marketStock) {
    throw new Error('Ticker ' + ticker + ' tidak ditemukan di canonical market-structure/latest.json.');
  }

  const ownership = marketStock.ownership;
  if (!ownership || typeof ownership !== 'object') {
    throw new Error('Ownership snapshot tidak tersedia untuk ' + ticker + '; apply diblokir.');
  }

  const freeFloat = finiteOrNull(ownership.derived_free_float_pct);
  if (freeFloat == null) {
    throw new Error('derived_free_float_pct tidak tersedia untuk ' + ticker + '; apply diblokir.');
  }

  const ownershipAsOf = assertIsoDate(ownership.as_of, 'ownership.as_of ' + ticker);
  const concentration = ownership.concentration || {};
  const investors = Array.isArray(ownership.investors) ? ownership.investors : [];

  return {
    ticker,
    hsc_2026_status: 'IMPOSED',
    hsc_as_of: assertIsoDate(meta.hsc_as_of, 'HSC as_of ' + ticker),
    official_concentration_pct: finiteOrNull(meta.official_concentration_pct),
    concentration_basis_as_of: assertIsoDate(
      meta.concentration_basis_as_of,
      'HSC concentration basis as_of ' + ticker
    ),
    ownership_as_of: ownershipAsOf,
    recorded_ownership_pct: finiteOrNull(ownership.recorded_ownership_pct),
    derived_free_float_pct: freeFloat,
    investor_count: finiteOrNull(ownership.investor_count) != null
      ? Number(ownership.investor_count)
      : investors.length,
    top1_pct: finiteOrNull(concentration.top1_pct),
    top3_pct: finiteOrNull(concentration.top3_pct),
    top5_pct: finiteOrNull(concentration.top5_pct),
    investors,
    market_cap: finiteOrNull(marketStock.market && marketStock.market.market_cap),
    listed_shares: finiteOrNull(marketStock.market && marketStock.market.listed_shares),
    close: finiteOrNull(marketStock.market && marketStock.market.close),
    hsc_source: 'IDX HSC official page / 2026-10-01 announcement',
    ownership_source: 'idx-stocks-ownership'
  };
}

function updateHscPayload(hscPayload, marketPayload, additions) {
  if (!hscPayload || !Array.isArray(hscPayload.active) || !Array.isArray(hscPayload.revoked)) {
    throw new Error('HSC current dataset harus memakai canonical active[] + revoked[] format.');
  }

  const marketByTicker = buildMarketLookup(marketPayload);
  const activeByTicker = new Map();
  for (const row of hscPayload.active) {
    const ticker = cleanTicker(row && row.ticker);
    if (!ticker) throw new Error('Ticker kosong di HSC active[].');
    if (activeByTicker.has(ticker)) throw new Error('Ticker duplikat di HSC active[]: ' + ticker);
    activeByTicker.set(ticker, row);
  }

  const revoked = new Set();
  for (const row of hscPayload.revoked) {
    const ticker = cleanTicker(row && row.ticker);
    if (!ticker) throw new Error('Ticker kosong di HSC revoked[].');
    if (revoked.has(ticker)) throw new Error('Ticker duplikat di HSC revoked[]: ' + ticker);
    revoked.add(ticker);
  }

  const changed = [];
  for (const meta of additions || HSC_ADDITIONS) {
    const ticker = cleanTicker(meta.ticker);
    if (revoked.has(ticker)) {
      throw new Error(ticker + ' ada di revoked[]; tidak boleh diaktifkan otomatis tanpa review manual.');
    }
    const enriched = buildEnrichedEntry(marketByTicker.get(ticker), meta);
    activeByTicker.set(ticker, enriched);
    changed.push(enriched);
  }

  const active = Array.from(activeByTicker.values())
    .sort((a, b) => cleanTicker(a.ticker).localeCompare(cleanTicker(b.ticker)));

  const next = Object.assign({}, hscPayload, {
    generated_at: new Date().toISOString(),
    active_count: active.length,
    revoked_count: hscPayload.revoked.length,
    active
  });

  return { payload: next, changed };
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    marketPath: process.env.AUTO_CUAN_MARKET_STRUCTURE_PATH || DEFAULT_MARKET_PATH,
    hscPath: process.env.AUTO_CUAN_HSC_PATH || DEFAULT_HSC_PATH
  };
}

function main(options) {
  options = options || parseArgs();
  if (!fs.existsSync(options.marketPath)) {
    throw new Error('Market structure source tidak ditemukan: ' + options.marketPath);
  }
  if (!fs.existsSync(options.hscPath)) {
    throw new Error('HSC current source tidak ditemukan: ' + options.hscPath);
  }

  const market = JSON.parse(fs.readFileSync(options.marketPath, 'utf8'));
  const hsc = JSON.parse(fs.readFileSync(options.hscPath, 'utf8'));
  const updated = updateHscPayload(hsc, market, HSC_ADDITIONS);

  console.log('=== HSC 2026 ADDITIONS: BIKE + MSJA ===');
  console.log('Mode: ' + (options.apply ? 'APPLY' : 'VALIDATE_ONLY'));
  console.log('Before active/revoked: ' + hsc.active.length + '/' + hsc.revoked.length);
  console.log('After active/revoked:  ' + updated.payload.active.length + '/' + updated.payload.revoked.length);

  for (const row of updated.changed) {
    console.log(
      row.ticker +
      ' | HSC=ACTIVE' +
      ' | official_concentration=' + row.official_concentration_pct + '%' +
      ' | HSC_as_of=' + row.hsc_as_of +
      ' | ownership_as_of=' + row.ownership_as_of +
      ' | derived_free_float=' + row.derived_free_float_pct + '%' +
      ' | top1=' + (row.top1_pct == null ? 'NA' : row.top1_pct + '%') +
      ' | top3=' + (row.top3_pct == null ? 'NA' : row.top3_pct + '%') +
      ' | top5=' + (row.top5_pct == null ? 'NA' : row.top5_pct + '%') +
      ' | investors=' + row.investor_count
    );
  }

  if (!options.apply) {
    console.log('Validation passed. No writes performed.');
    console.log('Run again with --apply, then sync-existing-market-structure.js.');
    return updated;
  }

  atomicWriteJson(options.hscPath, updated.payload);
  console.log('Written: ' + options.hscPath);
  console.log('HSC update complete.');
  return updated;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[update-hsc-current-2026] Error:', error && error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  HSC_ADDITIONS,
  cleanTicker,
  finiteOrNull,
  buildMarketLookup,
  buildEnrichedEntry,
  updateHscPayload,
  atomicWriteJson,
  parseArgs,
  main
};
