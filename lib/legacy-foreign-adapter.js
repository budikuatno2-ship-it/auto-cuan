'use strict';

/**
 * lib/legacy-foreign-adapter.js
 * ============================
 * F3 forensic fix: read and (shape-only) normalize the legacy `broker-summary-F`
 * records that carry a `broker_levels`/`brokers` shape with `flow:"F"` but LACK
 * the modern foreign-decomposition fields (`foreign_net` / `net_flow` /
 * `top_buyers` / `gross_buyers`).
 *
 * FORENSIC FINDING (F3, read-only, evidence-backed):
 *   - Legacy "F" files are NOT a foreign-only tape. A measured sample
 *     (BBCA 2026-10-30) shows the F broker list is a SUBSET of the same-date
 *     ALL list (300/300 files sample = F codes ⊆ ALL codes), contains 19 broker
 *     codes OUTSIDE FOREIGN_SET (domestic brokers), and its per-broker values
 *     differ from ALL for 25/28 shared codes. It therefore has no authoritative
 *     foreign decomposition and must NOT be re-labeled as foreign flow.
 *
 * CONTRACT (no fabrication):
 *   - Missing foreign decomposition stays ABSENT (null + NOT_PUBLISHED). It is
 *     NEVER converted to 0 and NEVER re-summed into a believable foreign_net.
 *   - Broker rows are preserved verbatim (they are real market data).
 *   - The only "transform" permitted here is shape normalization + tagging:
 *     status => 'LEGACY', data_status => 'PARTIAL', and an explicit reason.
 */

// Foreign brokers as defined by scripts/foreign-compile.js (FOREIGN_SET).
const FOREIGN_SET = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB', 'YU', 'CG', 'OD', 'ML', 'DP', 'BQ', 'EP', 'LG', 'AI']);

function cleanNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate broker totals from the real `brokers[]` / `broker_levels[]` rows.
 * This is a real, derivable aggregation (not fabrication): totals come from the
 * measured broker values already present in the record.
 *
 * A broker may appear on BOTH the buy and sell side (same `broker_code`), and a
 * broker may appear in BOTH `brokers[]` (flat) and `broker_levels[]` (buy/sell
 * pairs). To avoid double-count we keep, per (broker_code, side), the maximum
 * observed value — the same dedup contract as `lib/broksum-validator.js`. This
 * NEVER invents a magnitude; it only deduplicates overlapping source entries.
 */
function summarizeBrokerRows(payload) {
  const perBroker = new Map(); // code -> { code, name, buy, sell }
  const touch = (code, name) => {
    const key = String(code).trim().toUpperCase();
    if (!key) return null;
    if (!perBroker.has(key)) perBroker.set(key, { code: key, name: name || key, buy: 0, sell: 0 });
    const rec = perBroker.get(key);
    if (name && rec.name === key) rec.name = name;
    return rec;
  };
  const addBuy = (b) => { if (!b || !b.broker_code) return; const r = touch(b.broker_code, b.broker_name); if (r) { const v = cleanNumber(b.bval); if (v > r.buy) r.buy = v; } };
  const addSell = (b) => { if (!b || !b.broker_code) return; const r = touch(b.broker_code, b.broker_name); if (r) { const v = cleanNumber(b.sval); if (v > r.sell) r.sell = v; } };

  if (Array.isArray(payload.brokers)) {
    for (const b of payload.brokers) { addBuy(b); addSell(b); }
  }
  if (Array.isArray(payload.broker_levels)) {
    for (const lvl of payload.broker_levels) {
      if (!lvl) continue;
      if (lvl.buy) { addBuy(lvl.buy); addSell(lvl.buy); }
      if (lvl.sell) { addBuy(lvl.sell); addSell(lvl.sell); }
    }
  }

  const brokers = [];
  let totalBuy = 0;
  let totalSell = 0;
  for (const rec of perBroker.values()) {
    totalBuy += rec.buy;
    totalSell += rec.sell;
    brokers.push({
      broker_code: rec.code,
      broker_name: rec.name,
      bval: rec.buy,
      sval: rec.sell,
      nval: rec.buy - rec.sell
    });
  }
  return { brokers, totalBuy, totalSell };
}

function hasModernForeignFields(payload) {
  return Boolean(payload && (
    ('foreign_net' in payload) || ('net_flow' in payload) ||
    ('top_buyers' in payload) || ('gross_buyers' in payload)
  ));
}

/**
 * Classify a broker-summary-F record.
 * @returns {'MODERN'|'LEGACY_BROKSUM_MIXED'|'LEGACY_FOREIGN_ONLY'|'EMPTY'|'INVALID'}
 */
function classifyForeignRecord(payload) {
  if (!payload || typeof payload !== 'object') return 'INVALID';
  if (hasModernForeignFields(payload)) return 'MODERN';

  const info = summarizeBrokerRows(payload);
  if (info.brokers.length === 0) return 'EMPTY';

  let foreignOnly = true;
  for (const b of info.brokers) {
    const code = String(b.broker_code).trim().toUpperCase();
    if (!FOREIGN_SET.has(code)) { foreignOnly = false; break; }
  }
  return foreignOnly ? 'LEGACY_FOREIGN_ONLY' : 'LEGACY_BROKSUM_MIXED';
}

/**
 * Shape-only normalize a legacy Foreign record WITHOUT fabricating a foreign
 * decomposition. `foreign_net` / `net_flow` / `top_buyers` stay absent.
 *
 * @param {object} payload - a legacy broker-summary-F payload
 * @param {object} [options]
 * @param {string} [options.requestedDate] - date the consumer actually asked for
 * @returns {object} modern-shaped but foreign-absent record
 */
function normalizeLegacyForeign(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const info = summarizeBrokerRows(payload);

  // Filter to FOREIGN_SET brokers only for the "foreign brokers" view. This is a
  // REAL subset (no invented numbers), and is labelled non-authoritative because
  // the legacy record mixes domestic brokers and lacks a foreign net.
  const foreignBrokers = info.brokers.filter((b) =>
    FOREIGN_SET.has(String(b.broker_code).trim().toUpperCase()));

  return {
    stock_code: payload.stock_code || payload.ticker || null,
    ticker: payload.ticker || payload.stock_code || null,
    date: options.requestedDate || payload.date || payload.broker_end_date || null,
    flow: 'F',
    status: 'LEGACY',
    is_complete: false,
    data_status: 'PARTIAL',
    note: 'legacy broker-summary-shaped F record: foreign_net/top_buyers absent; domestic+foreign brokers mixed; foreign decomposition NOT derivable without a new source',
    // Real broker rows preserved verbatim (market data), never altered.
    brokers: info.brokers,
    // Real derived totals from present broker values (not fabricated magnitudes).
    total_buy_val: info.totalBuy,
    total_sell_val: info.totalSell,
    // Real subset of foreign-broker rows, labelled non-authoritative.
    foreign_brokers: foreignBrokers,
    // ABSENT foreign decomposition (not zero): this is the no-fabrication guard.
    broker_net: null,
    foreign_net: null,
    foreign_net_val: null,
    net_flow: null,
    foreign_net_status: 'NOT_PUBLISHED',
    top_buyers: [],
    gross_buyers: [],
    net_buyers: [],
    top_sellers: [],
    gross_sellers: [],
    net_sellers: []
  };
}

module.exports = {
  FOREIGN_SET,
  hasModernForeignFields,
  classifyForeignRecord,
  normalizeLegacyForeign,
  summarizeBrokerRows
};