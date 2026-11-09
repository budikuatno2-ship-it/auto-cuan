'use strict';

/**
 * api/intel.js & api/signals.js
 * ============================================================================
 * Endpoint API Sinyal Intelijen Terpadu Auto-Cuan — V5 P0 hardened
 * ============================================================================
 *
 * WHAT CHANGED IN V5 P0 (BUG-V5-P0-003 / P0-001 class)
 *   BEFORE: this file was a *template*. Four hardcoded arrays held literal
 *   prices (`1550`, `380`, `1420`), literal change percentages (`9.93`,
 *   `8.57`), literal volume ratios (`2.71`, `3.42`), literal CR3/CR5
 *   (`74.2`, `86.5`) and literal net-buy rupiah amounts
 *   (`142500000000`). Every one of those numbers was invented — none of it was
 *   read from a market source. The endpoint then reported
 *   `summary.stale = false` beside `status: 'OPTIMAL_SPEED'`, so a consumer had
 *   no way to tell that nothing had been measured.
 *
 *   AFTER: every section is DERIVED from a real file on disk, and anything that
 *   cannot be derived is `null` and accompanied by an explicit `data_status`.
 *   An empty section is a correct, expected outcome.
 *
 * SOURCES (all read-only, no network, no quota)
 *   - `data/screener-v3f04-*.json`        → anomaly / divergence candidates
 *   - `data/foreign-flow-multi-day.json`  → foreign net flow per ticker
 *   - `data/daily-candles/<TICKER>.json`  → RSI(14) for the divergence axis
 *
 * CONTRACT
 *   - No numeric literal is ever substituted for a missing market datum.
 *   - `0` survives as a real value; unknown is `null` (never `0`, never a
 *     plausible-looking constant).
 *   - Every row carries `data_status` + `provenance`.
 *   - `summary.stale` reports the real freshness instead of a hardcoded `false`.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const contract = require('../lib/market-data-contract.js');
const { DATA_STATUS, pickNumber, pickText, isKnown, numberOrNull } = contract;

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const SCREENER_FILES = Object.freeze([
  Object.freeze({ key: 'konglo', label: 'Swing Konglo', file: 'screener-v3f04-konglo.json' }),
  Object.freeze({ key: 'nonkonglo', label: 'Swing Non-Konglo', file: 'screener-v3f04-nonkonglo.json' }),
  Object.freeze({ key: 'daytrade', label: 'Day Trade', file: 'screener-v3f04-daytrade.json' })
]);

const FOREIGN_FLOW_FILE = 'foreign-flow-multi-day.json';

/** Volume ratio at or above which an anomaly is reported (the contract's 2.0x). */
const MIN_ANOMALY_VOLUME_RATIO = 2.0;

/** RSI(14) bands used to label a divergence observation. Display only. */
const RSI_OVERSOLD = 40;
const RSI_OVERBOUGHT = 70;

let _cachedIntelData = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60000;

/* -------------------------------------------------------------------------- */
/* IO helpers                                                                 */
/* -------------------------------------------------------------------------- */

function readJsonSafe(p, def) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return def === undefined ? null : def;
  }
}

function wibDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/* -------------------------------------------------------------------------- */
/* Real-source readers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every published screener row, tagged with the file it came from.
 * Deliberately reads `.results` only — `radar` holds observations the producer
 * did not publish as candidates.
 */
function readScreenerRows() {
  const out = [];
  const fileStatus = {};

  for (const spec of SCREENER_FILES) {
    const relFile = 'data/' + spec.file;
    const doc = readJsonSafe(path.join(DATA_DIR, spec.file), null);

    if (!doc || typeof doc !== 'object') {
      fileStatus[spec.key] = { data_status: DATA_STATUS.SOURCE_UNAVAILABLE, source_file: relFile, rows: 0 };
      continue;
    }

    const rows = Array.isArray(doc.results) ? doc.results : [];
    const tradeDate = pickText(doc.trade_date, doc.market_date, doc.run_date);

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const ticker = pickText(row.ticker);
      if (!ticker) continue;
      out.push({ row, ticker: ticker.toUpperCase(), tradeDate, sourceFile: relFile, category: spec.label });
    }

    fileStatus[spec.key] = {
      data_status: rows.length > 0 ? DATA_STATUS.AVAILABLE : DATA_STATUS.NOT_PUBLISHED,
      source_file: relFile,
      trade_date: tradeDate,
      rows: rows.length
    };
  }

  return { rows: out, fileStatus };
}

/** The real foreign-flow dataset, keyed by upper-case ticker. */
function readForeignFlow() {
  const doc = readJsonSafe(path.join(DATA_DIR, FOREIGN_FLOW_FILE), null);
  if (!doc || typeof doc !== 'object') {
    return { byTicker: new Map(), dataStatus: DATA_STATUS.SOURCE_UNAVAILABLE, tradeDate: null };
  }
  const data = (doc.data && typeof doc.data === 'object') ? doc.data : null;
  if (!data) {
    return { byTicker: new Map(), dataStatus: DATA_STATUS.VALIDATION_FAILED, tradeDate: null };
  }
  const byTicker = new Map();
  for (const ticker of Object.keys(data)) {
    const row = data[ticker];
    if (row && typeof row === 'object') byTicker.set(String(ticker).toUpperCase(), row);
  }
  return {
    byTicker,
    dataStatus: byTicker.size > 0 ? DATA_STATUS.AVAILABLE : DATA_STATUS.NOT_PUBLISHED,
    tradeDate: pickText(doc.trade_date, doc.date, doc.as_of)
  };
}

/**
 * RSI(14) computed from the local daily candle file (Wilder smoothing).
 * Returns `null` when the file is absent or holds too few bars — never a
 * plausible default such as `56.4`.
 *
 * @param {string} ticker
 * @returns {number|null}
 */
function computeRsi14(ticker) {
  const doc = readJsonSafe(path.join(DATA_DIR, 'daily-candles', ticker + '.json'), null);
  if (!doc || typeof doc !== 'object') return null;
  const bars = Array.isArray(doc.candles) ? doc.candles : (Array.isArray(doc.data) ? doc.data : []);
  if (bars.length < 15) return null;

  const closes = [];
  for (const bar of bars) {
    const close = numberOrNull(bar && bar.close);
    if (close === null) return null; // a broken series is unknown, not zero
    closes.push(close);
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= 14; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / 14;
  let avgLoss = lossSum / 14;

  for (let i = 15; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = ((avgGain * 13) + gain) / 14;
    avgLoss = ((avgLoss * 13) + loss) / 14;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? Number(rsi.toFixed(2)) : null;
}

/* -------------------------------------------------------------------------- */
/* Row builders — real values or null, never a plausible constant             */
/* -------------------------------------------------------------------------- */

/** 1. Volume anomalies: real volume_ratio >= threshold. */
function buildVolumeAnomalies(rows) {
  const out = [];
  for (const item of rows) {
    const ratio = pickNumber(item.row.volume_ratio_20d, item.row.volume_ratio);
    if (ratio === null) continue;            // unknown ratio is not an anomaly
    if (!(ratio >= MIN_ANOMALY_VOLUME_RATIO)) continue;

    const lastPrice = pickNumber(item.row.last_price, item.row.close);
    const changePct = pickNumber(item.row.change_pct);

    const built = {
      ticker: item.ticker,
      name: pickText(item.row.company_name, item.row.stock_name) || item.ticker,
      last_price: lastPrice,
      change_pct: changePct,
      volume_ratio: ratio,
      volume_today: pickNumber(item.row.volume_today, item.row.volume),
      avg_vol20: pickNumber(item.row.avg_vol20, item.row.avg_volume_20d),
      status: 'VOLUME_ANOMALY',
      category: item.category,
      source_file: item.sourceFile
    };

    out.push(contract.attachProvenance(built, {
      source: item.sourceFile,
      tradeDate: item.tradeDate,
      status: item.tradeDate ? DATA_STATUS.AVAILABLE : DATA_STATUS.PARTIAL
    }));
  }
  return out;
}

/**
 * 2. Broker surges — built from REAL foreign-flow rows that the source marks as
 * a net buy. The previous version invented CR3/CR5 and net-buy rupiah amounts;
 * those are `null` here because no broker-level file is present on disk.
 */
function buildBrokerSurges(rows, foreignFlow) {
  const out = [];
  const seen = new Set();

  for (const item of rows) {
    if (seen.has(item.ticker)) continue;
    const flow = foreignFlow.byTicker.get(item.ticker);
    if (!flow) continue;

    const netToday = pickNumber(flow.foreign_net_today);
    if (netToday === null || !(netToday > 0)) continue;
    seen.add(item.ticker);

    const built = {
      ticker: item.ticker,
      top_buyer: null,                       // no broker-level source on disk
      net_buy_idr: netToday,
      net_1d: netToday,
      net_3d: pickNumber(flow.foreign_net_3d),
      net_7d: pickNumber(flow.foreign_net_7d),
      // No broker table exists locally, so concentration is genuinely unknown.
      cr3: null,
      cr5: null,
      avg_buy_price: null,
      last_price: pickNumber(item.row.last_price, item.row.close, flow.last_price),
      volume_today: pickNumber(flow.volume_today),
      flow: 'NET_FOREIGN_BUY',
      broker_action: null,
      category: item.category,
      source_file: item.sourceFile
    };

    out.push(contract.attachProvenance(built, {
      source: 'data/' + FOREIGN_FLOW_FILE,
      tradeDate: foreignFlow.tradeDate || item.tradeDate,
      status: foreignFlow.dataStatus
    }));
  }

  return out;
}

/**
 * 3. LPM / RSI divergences — RSI is computed from the local candle file. An
 * unknown RSI means the observation is not published, rather than defaulting to
 * the old literal `56.4`.
 */
function buildDivergences(rows) {
  const out = [];
  const seen = new Set();

  for (const item of rows) {
    if (seen.has(item.ticker)) continue;
    const rsi14 = computeRsi14(item.ticker);
    if (rsi14 === null) continue;            // no candle file => no claim
    seen.add(item.ticker);

    const lastPrice = pickNumber(item.row.last_price, item.row.close);
    let rsiStatus = 'NEUTRAL';
    if (rsi14 < RSI_OVERSOLD) rsiStatus = 'OVERSOLD';
    else if (rsi14 > RSI_OVERBOUGHT) rsiStatus = 'OVERBOUGHT';

    // LPM (a proprietary cumulative flow measure) has no local source. It is
    // reported as null rather than invented.
    const built = {
      ticker: item.ticker,
      last_price: lastPrice,
      rsi14,
      rsi_status: rsiStatus,
      lpm_value: null,
      lpm_trend: null,
      divergence: null,                      // requires LPM to be known
      category: item.category,
      source_file: item.sourceFile
    };

    out.push(contract.attachProvenance(built, {
      source: 'data/daily-candles/' + item.ticker + '.json',
      tradeDate: item.tradeDate,
      status: DATA_STATUS.PARTIAL,           // RSI known, LPM not
      extra: { rsiSource: 'computed_wilder_14', lpmSource: null }
    }));
  }

  return out;
}

/**
 * 4. Strategic bandarmologi signals — only the axes that have a real local
 * source are emitted. `below_bandar_price` needs a bandar average purchase
 * price and `retail_cutloss_bandar_absorb` needs broker-level seller/buyer
 * detail; neither exists on disk, so both arrays are honestly empty.
 */
function buildStrategicSignals(rows, foreignFlow) {
  const silentAccumulation = [];
  const belowBandarPrice = [];
  const retailAbsorb = [];
  const concentrationRatio = [];

  const seen = new Set();
  for (const item of rows) {
    if (seen.has(item.ticker)) continue;
    const flow = foreignFlow.byTicker.get(item.ticker);
    if (!flow) continue;

    const net1d = pickNumber(flow.foreign_net_today);
    const net3d = pickNumber(flow.foreign_net_3d);
    const net7d = pickNumber(flow.foreign_net_7d);

    // Silent accumulation: foreign net positive on all three horizons.
    if (net1d !== null && net3d !== null && net7d !== null &&
        net1d > 0 && net3d > 0 && net7d > 0) {
      seen.add(item.ticker);
      silentAccumulation.push(contract.attachProvenance({
        ticker: item.ticker,
        net_foreign_idr: net7d,
        net_1d: net1d,
        net_3d: net3d,
        net_7d: net7d,
        // The span in days and the intra-window price range are not derivable
        // from this dataset, so they are not asserted.
        days: null,
        price_range_pct: null
      }, {
        source: 'data/' + FOREIGN_FLOW_FILE,
        tradeDate: foreignFlow.tradeDate || item.tradeDate,
        status: foreignFlow.dataStatus
      }));
    }
  }

  return {
    silent_accumulation: silentAccumulation,
    below_bandar_price: belowBandarPrice,
    retail_cutloss_bandar_absorb: retailAbsorb,
    concentration_ratio: concentrationRatio
  };
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

function buildIntelPayload() {
  const now = Date.now();
  if (_cachedIntelData && now - _cachedAt < CACHE_TTL_MS) {
    return _cachedIntelData;
  }

  const today = wibDateString();
  const screener = readScreenerRows();
  const foreignFlow = readForeignFlow();

  const volumeAnomalies = buildVolumeAnomalies(screener.rows);
  const brokerSurges = buildBrokerSurges(screener.rows, foreignFlow);
  const divergences = buildDivergences(screener.rows);
  const strategicSignals = buildStrategicSignals(screener.rows, foreignFlow);

  // Freshness is reported, never asserted. A section is stale when its own
  // source trade date is not today.
  const tradeDates = screener.rows
    .map((item) => item.tradeDate)
    .filter((d) => isKnown(d))
    .sort();
  const dataTradeDate = tradeDates.length ? tradeDates[tradeDates.length - 1] : null;
  const anyRealRow = screener.rows.length > 0;
  const stale = anyRealRow && isKnown(dataTradeDate) ? dataTradeDate !== today : null;

  const totalRows = volumeAnomalies.length + brokerSurges.length + divergences.length;
  let dataStatus;
  if (!anyRealRow) dataStatus = DATA_STATUS.NOT_PUBLISHED;
  else if (totalRows === 0) dataStatus = DATA_STATUS.PARTIAL;
  else if (stale === true) dataStatus = DATA_STATUS.STALE;
  else dataStatus = DATA_STATUS.AVAILABLE;

  const payload = {
    success: true,

    // The market date the data describes, not the wall clock.
    trade_date: dataTradeDate,
    date: dataTradeDate,
    generated_at: new Date().toISOString(),

    data_status: dataStatus,
    stale,
    // Nothing in this payload is synthesised. Stated explicitly so a consumer
    // never has to infer it from the shape of the data.
    fabricated_count: 0,

    radar_anomalies: volumeAnomalies,
    volume_anomalies: volumeAnomalies,
    broker_surges: brokerSurges,
    broker_accumulation: brokerSurges,
    lpm_rsi_divergences: divergences,
    divergences: divergences,
    strategic_signals: strategicSignals,
    signals: [...volumeAnomalies, ...brokerSurges, ...divergences],
    indexes: strategicSignals,

    sources: screener.fileStatus,
    foreign_flow_status: foreignFlow.dataStatus,

    summary: {
      total_anomalies: volumeAnomalies.length,
      total_broker_surges: brokerSurges.length,
      total_divergences: divergences.length,
      // Replaces the old hardcoded 'OPTIMAL_SPEED' + `stale: false` pair, which
      // asserted a healthy state regardless of what had actually been read.
      source_rows_examined: screener.rows.length,
      data_status: dataStatus,
      stale,
      // Axes with no local source are named so the gap stays visible.
      unavailable_axes: {
        lpm: 'no local LPM series',
        cr3_cr5: 'no local broker concentration table',
        bandar_avg_price: 'no local bandar average purchase price'
      }
    }
  };

  _cachedIntelData = payload;
  _cachedAt = now;
  return payload;
}

module.exports = async function handler(req, res) {
  try {
    const payload = buildIntelPayload();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(payload);
    }
    return payload;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: err.message });
    }
    throw err;
  }
};

module.exports.buildIntelPayload = buildIntelPayload;
module.exports.computeRsi14 = computeRsi14;
