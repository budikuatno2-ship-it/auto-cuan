'use strict';

const risk = require('./market-structure-risk');

function cleanTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function assertIsoDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(text + 'T00:00:00Z').getTime())) {
    throw new Error((label || 'date') + ' tidak valid: ' + (value || '(kosong)'));
  }
  return text;
}

function buildExistingMarketStructureRows(marketPayload, hscPayload, eligibleTickers) {
  marketPayload = marketPayload || {};
  hscPayload = hscPayload || {};

  if (!Array.isArray(marketPayload.stocks)) {
    throw new Error('market-structure/latest.json tidak memiliki stocks array.');
  }
  if (!Array.isArray(hscPayload.stocks)) {
    throw new Error('market-structure/hsc/current-2026.json tidak memiliki stocks array.');
  }

  const eligible = new Set((eligibleTickers || []).map(cleanTicker).filter(Boolean));
  if (!eligible.size) throw new Error('Universe eligible kosong; sync diblokir.');

  const marketByTicker = new Map();
  for (const stock of marketPayload.stocks) {
    const ticker = cleanTicker(stock && stock.ticker);
    if (!ticker) continue;
    if (marketByTicker.has(ticker)) throw new Error('Ticker duplikat di market-structure/latest.json: ' + ticker);
    marketByTicker.set(ticker, stock);
  }

  const hscByTicker = new Map();
  let hscActive = 0;
  let hscRevoked = 0;
  for (const stock of hscPayload.stocks) {
    const ticker = cleanTicker(stock && stock.ticker);
    if (!ticker) throw new Error('Ticker HSC kosong.');
    if (hscByTicker.has(ticker)) throw new Error('Ticker duplikat di HSC current: ' + ticker);

    const status = String(stock.official_status || '').trim().toUpperCase();
    if (!['ACTIVE', 'REVOKED'].includes(status)) {
      throw new Error('official_status HSC tidak valid untuk ' + ticker + ': ' + status);
    }
    if (!stock.last_event || !stock.last_event.event_date) {
      throw new Error('last_event.event_date HSC tidak ada untuk ' + ticker);
    }
    assertIsoDate(stock.last_event.event_date, 'HSC event_date ' + ticker);

    if (status === 'ACTIVE') hscActive += 1;
    else hscRevoked += 1;

    hscByTicker.set(ticker, stock);
  }

  if (Number.isFinite(Number(hscPayload.active_count)) && Number(hscPayload.active_count) !== hscActive) {
    throw new Error('HSC active_count tidak cocok: declared=' + hscPayload.active_count + ' actual=' + hscActive);
  }
  if (Number.isFinite(Number(hscPayload.revoked_count)) && Number(hscPayload.revoked_count) !== hscRevoked) {
    throw new Error('HSC revoked_count tidak cocok: declared=' + hscPayload.revoked_count + ' actual=' + hscRevoked);
  }

  const rows = [];
  let freeFloatCount = 0;
  let hscVerifiedCount = 0;
  let hscActiveInUniverse = 0;
  let hscRevokedInUniverse = 0;
  const missingFreeFloat = [];

  for (const ticker of Array.from(eligible).sort()) {
    const marketStock = marketByTicker.get(ticker);
    const ownership = marketStock && marketStock.ownership;
    const hscStock = hscByTicker.get(ticker);

    let freeFloatPct = null;
    let freeFloatAsOf = null;
    if (ownership) {
      freeFloatPct = risk.normalizeFreeFloatPct(ownership.derived_free_float_pct);
      if (freeFloatPct != null) {
        freeFloatAsOf = assertIsoDate(ownership.as_of, 'ownership.as_of ' + ticker);
        freeFloatCount += 1;
      }
    }
    if (freeFloatPct == null) missingFreeFloat.push(ticker);

    let hscFlag = null;
    let hscAsOf = null;
    if (hscStock) {
      hscFlag = String(hscStock.official_status).toUpperCase() === 'ACTIVE';
      hscAsOf = assertIsoDate(hscStock.last_event.event_date, 'HSC event_date ' + ticker);
      hscVerifiedCount += 1;
      if (hscFlag) hscActiveInUniverse += 1;
      else hscRevokedInUniverse += 1;
    }

    if (freeFloatPct == null && hscFlag == null) continue;

    rows.push({
      ticker,
      free_float_pct: freeFloatPct,
      free_float_source: freeFloatPct != null ? 'idx-stocks-ownership' : null,
      free_float_as_of: freeFloatPct != null ? freeFloatAsOf : null,
      hsc_flag: hscFlag,
      hsc_source: hscFlag != null ? 'IDX HSC 2026' : null,
      hsc_as_of: hscFlag != null ? hscAsOf : null,
      updated_at: new Date().toISOString()
    });
  }

  return {
    rows,
    summary: {
      eligible_count: eligible.size,
      market_stock_count: marketByTicker.size,
      free_float_verified: freeFloatCount,
      missing_free_float: missingFreeFloat,
      hsc_dataset_count: hscByTicker.size,
      hsc_verified_in_universe: hscVerifiedCount,
      hsc_active_in_universe: hscActiveInUniverse,
      hsc_revoked_in_universe: hscRevokedInUniverse
    }
  };
}

module.exports = {
  buildExistingMarketStructureRows,
  cleanTicker
};
