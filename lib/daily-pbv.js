/**
 * PBV (Price-to-Book-Value) — computed only from verified fundamental data.
 *
 * Per repository audit, no PBV/book-value source exists anywhere in this
 * codebase. This module reads from the new `stock_fundamentals` table
 * (empty until populated by a future admin tool — never fabricated here).
 *
 * PBV = last_price / book_value_per_share
 * book_value_per_share = row.book_value_per_share, or
 *                         row.equity / row.shares_outstanding if both present.
 *
 * If the necessary fundamental data is missing, every field is null — this
 * module never invents a PBV value.
 */

'use strict';

function numOrNull(v) {
  if (v == null) return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveBookValuePerShare(fundamentalsRow) {
  if (!fundamentalsRow) return null;
  var direct = numOrNull(fundamentalsRow.book_value_per_share);
  if (direct != null && direct > 0) return direct;

  var equity = numOrNull(fundamentalsRow.equity);
  var shares = numOrNull(fundamentalsRow.shares_outstanding);
  if (equity != null && shares != null && shares > 0) return equity / shares;

  return null;
}

/**
 * Build the PBV context. `lastPrice` is the current trustworthy price (or
 * null if unavailable). `fundamentalsRow` comes from stock_fundamentals.
 */
function buildPbvContext(lastPrice, fundamentalsRow) {
  var price = numOrNull(lastPrice);
  var bvps = resolveBookValuePerShare(fundamentalsRow);

  if (price == null || bvps == null) {
    return {
      pbv: null,
      pbv_as_of_price: price,
      book_value_per_share: bvps,
      fundamental_period: fundamentalsRow ? fundamentalsRow.fundamental_period || null : null,
      fundamental_source: fundamentalsRow ? fundamentalsRow.source || null : null,
      fundamental_updated_at: fundamentalsRow ? fundamentalsRow.updated_at || null : null,
      data_available: false
    };
  }

  return {
    pbv: Math.round((price / bvps) * 100) / 100,
    pbv_as_of_price: price,
    book_value_per_share: Math.round(bvps * 100) / 100,
    fundamental_period: fundamentalsRow.fundamental_period || null,
    fundamental_source: fundamentalsRow.source || null,
    fundamental_updated_at: fundamentalsRow.updated_at || null,
    data_available: true
  };
}

module.exports = {
  buildPbvContext,
  resolveBookValuePerShare
};
