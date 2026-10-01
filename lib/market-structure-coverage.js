'use strict';

const marketStructureRisk = require('./market-structure-risk');

function safeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function buildCoverageReport(universeTickers, fundamentalsRows, options) {
  options = options || {};
  const expectedUniverse = Number.isFinite(Number(options.expectedUniverse))
    ? Number(options.expectedUniverse) : 800;

  const universe = Array.from(new Set((universeTickers || []).map(safeTicker).filter(Boolean))).sort();
  const byTicker = new Map();
  for (const row of fundamentalsRows || []) {
    const ticker = safeTicker(row && row.ticker);
    if (ticker) byTicker.set(ticker, row);
  }

  let freeFloatVerified = 0;
  let hscVerified = 0;
  let bothVerified = 0;
  let lowFreeFloat = 0;
  let hscFlagged = 0;
  let caution = 0;
  let normal = 0;
  let unknown = 0;
  const missingBoth = [];
  const missingFreeFloat = [];
  const missingHsc = [];
  const cautionTickers = [];
  const freeFloatSources = {};
  const hscSources = {};

  for (const ticker of universe) {
    const context = marketStructureRisk.buildMarketStructureContext(byTicker.get(ticker));
    if (context.free_float_available) {
      freeFloatVerified += 1;
      const source = String(context.free_float_source || 'UNKNOWN');
      freeFloatSources[source] = (freeFloatSources[source] || 0) + 1;
      if (context.low_free_float_risk === true) lowFreeFloat += 1;
    } else {
      missingFreeFloat.push(ticker);
    }

    if (context.hsc_available) {
      hscVerified += 1;
      const source = String(context.hsc_source || 'UNKNOWN');
      hscSources[source] = (hscSources[source] || 0) + 1;
      if (context.hsc_flag === true) hscFlagged += 1;
    } else {
      missingHsc.push(ticker);
    }

    if (context.free_float_available && context.hsc_available) bothVerified += 1;
    if (!context.free_float_available && !context.hsc_available) missingBoth.push(ticker);

    if (context.market_structure_guard === 'CAUTION') {
      caution += 1;
      cautionTickers.push(ticker);
    } else if (context.market_structure_guard === 'NORMAL') {
      normal += 1;
    } else {
      unknown += 1;
    }
  }

  const total = universe.length;
  function pct(count) {
    return total ? Math.round((count / total) * 10000) / 100 : 0;
  }

  return {
    generated_at: options.generatedAt || new Date().toISOString(),
    universe: {
      expected: expectedUniverse,
      actual: total,
      contract_ok: total === expectedUniverse
    },
    coverage: {
      free_float_verified: freeFloatVerified,
      free_float_verified_pct: pct(freeFloatVerified),
      hsc_verified: hscVerified,
      hsc_verified_pct: pct(hscVerified),
      both_verified: bothVerified,
      both_verified_pct: pct(bothVerified),
      missing_free_float: missingFreeFloat.length,
      missing_hsc: missingHsc.length,
      missing_both: missingBoth.length
    },
    risk_context: {
      low_free_float_risk: lowFreeFloat,
      low_free_float_reference_pct: marketStructureRisk.LOW_FREE_FLOAT_REFERENCE_PCT,
      regulatory_compliance_status: 'NOT_EVALUATED',
      hsc_flagged: hscFlagged,
      caution: caution,
      normal: normal,
      unknown: unknown
    },
    provenance: {
      free_float_sources: freeFloatSources,
      hsc_sources: hscSources
    },
    missing: {
      free_float: missingFreeFloat,
      hsc: missingHsc,
      both: missingBoth
    },
    caution_tickers: cautionTickers
  };
}

module.exports = {
  safeTicker,
  buildCoverageReport
};
