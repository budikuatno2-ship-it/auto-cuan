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

function isoDateFromTimestamp(value, label) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return assertIsoDate(text, label);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(new Date(text).getTime())) {
    return assertIsoDate(text.slice(0, 10), label);
  }
  throw new Error((label || 'date') + ' tidak valid: ' + (value || '(kosong)'));
}

function extractHscAsOfDate(stock, ticker, hscPayload) {
  if (stock && stock.last_event && stock.last_event.event_date) {
    return assertIsoDate(stock.last_event.event_date, 'HSC event_date ' + ticker);
  }
  if (stock && stock.event_date) {
    return assertIsoDate(stock.event_date, 'HSC event_date ' + ticker);
  }
  if (stock && stock.hsc_as_of) {
    return isoDateFromTimestamp(stock.hsc_as_of, 'HSC hsc_as_of ' + ticker);
  }
  if (stock && Array.isArray(stock.events)) {
    const dates = stock.events
      .map((event) => event && event.event_date)
      .filter(Boolean)
      .map((date) => assertIsoDate(date, 'HSC event_date ' + ticker))
      .sort();
    if (dates.length) return dates[dates.length - 1];
  }

  // The canonical current-2026 dataset stores current ACTIVE/REVOKED state
  // without a per-ticker event date. In that case provenance is the snapshot
  // generation date, not ownership_as_of (which belongs to ownership/FF data).
  if (hscPayload && hscPayload.generated_at) {
    return isoDateFromTimestamp(hscPayload.generated_at, 'HSC generated_at');
  }

  throw new Error(
    'HSC as-of tidak tersedia untuk ' + ticker +
    '; butuh event date per ticker atau generated_at snapshot.'
  );
}

function normalizeHscDataset(hscPayload) {
  hscPayload = hscPayload || {};
  const hasStocks = Array.isArray(hscPayload.stocks);
  const hasActive = Array.isArray(hscPayload.active);
  const hasRevoked = Array.isArray(hscPayload.revoked);

  if (!hasStocks && !hasActive && !hasRevoked) {
    throw new Error(
      'market-structure/hsc/current-2026.json harus memiliki stocks[] atau active[]/revoked[].'
    );
  }

  const rawEntries = [];
  if (hasStocks) {
    for (const stock of hscPayload.stocks) rawEntries.push({ stock, bucketStatus: null });
  } else {
    for (const stock of hscPayload.active || []) rawEntries.push({ stock, bucketStatus: 'ACTIVE' });
    for (const stock of hscPayload.revoked || []) rawEntries.push({ stock, bucketStatus: 'REVOKED' });
  }

  return rawEntries.map(({ stock, bucketStatus }) => {
    const ticker = cleanTicker(stock && stock.ticker);
    if (!ticker) throw new Error('Ticker HSC kosong.');

    const explicitStatus = String(
      stock && (stock.official_status || stock.hsc_2026_status || stock.status) || ''
    ).trim().toUpperCase();

    let status = '';
    if (explicitStatus === 'ACTIVE' || explicitStatus === 'IMPOSED') status = 'ACTIVE';
    else if (explicitStatus === 'REVOKED') status = 'REVOKED';
    else if (!explicitStatus && bucketStatus) status = bucketStatus;

    if (!['ACTIVE', 'REVOKED'].includes(status)) {
      throw new Error('Status HSC tidak valid untuk ' + ticker + ': ' + (explicitStatus || '(kosong)'));
    }
    if (bucketStatus && status !== bucketStatus) {
      throw new Error(
        'Status HSC tidak cocok dengan bucket untuk ' + ticker +
        ': bucket=' + bucketStatus + ' raw_status=' + (explicitStatus || '(kosong)') +
        ' normalized=' + status
      );
    }

    const hscAsOf = extractHscAsOfDate(stock, ticker, hscPayload);
    return Object.assign({}, stock, {
      ticker,
      official_status: status,
      hsc_as_of: hscAsOf
    });
  });
}

function buildExistingMarketStructureRows(marketPayload, hscPayload, eligibleTickers) {
  marketPayload = marketPayload || {};
  hscPayload = hscPayload || {};

  if (!Array.isArray(marketPayload.stocks)) {
    throw new Error('market-structure/latest.json tidak memiliki stocks array.');
  }

  const hscRecords = normalizeHscDataset(hscPayload);

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
  for (const stock of hscRecords) {
    const ticker = cleanTicker(stock && stock.ticker);
    if (!ticker) throw new Error('Ticker HSC kosong.');
    if (hscByTicker.has(ticker)) throw new Error('Ticker duplikat di HSC current: ' + ticker);

    const status = String(stock.official_status || '').trim().toUpperCase();
    if (!['ACTIVE', 'REVOKED'].includes(status)) {
      throw new Error('official_status HSC tidak valid untuk ' + ticker + ': ' + status);
    }
    assertIsoDate(stock.hsc_as_of, 'HSC as_of ' + ticker);

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
      hscAsOf = assertIsoDate(hscStock.hsc_as_of, 'HSC as_of ' + ticker);
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
  normalizeHscDataset,
  cleanTicker
};
