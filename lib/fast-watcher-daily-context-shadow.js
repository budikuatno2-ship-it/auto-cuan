/**
 * Fast Watcher Daily Context — SHADOW integration only.
 *
 * The Fast Watcher persistence/confirmation candidate is FROZEN at commit
 * 680ec37c92c9f9275a54cc81fe24c6549c2c1eca (persistence publish threshold
 * >= 70, minimum normalized impulse >= -0.20). This module must NEVER change
 * that candidate's scoring, thresholds, or output.
 *
 * Gated by FAST_WATCHER_DAILY_CONTEXT_ENABLED (default false, see
 * lib/daily-market-context-constants.js). When disabled, `attachShadowContext`
 * returns the exact same array reference it was given — it does not even
 * allocate new objects — so it is provably a no-op on the frozen path.
 *
 * When enabled (research/shadow use only), it returns NEW candidate objects
 * with the original fields copied verbatim plus one additional namespaced
 * key, `_shadowDailyContext`, so nothing existing is overwritten.
 */

'use strict';

const { FAST_WATCHER_DAILY_CONTEXT_ENABLED } = require('./daily-market-context-constants');
const { buildFeatureSnapshotsForTickers } = require('./daily-market-context-builder');

/**
 * candidates: array of Fast Watcher candidate objects, each with a `ticker`
 * field (matching existing candidate shape).
 * Returns { candidates, enabled } — candidates is the SAME array reference
 * when disabled.
 */
async function attachShadowContext(supabase, candidates, options) {
  options = options || {};
  var enabled = options.forceEnabled != null ? !!options.forceEnabled : FAST_WATCHER_DAILY_CONTEXT_ENABLED;

  if (!enabled || !Array.isArray(candidates) || !candidates.length) {
    return { candidates: candidates, enabled: false };
  }

  var tickers = candidates.map(function(c) { return c && c.ticker; }).filter(Boolean);
  var snapshotResult = await buildFeatureSnapshotsForTickers(supabase, tickers, options);
  var byTicker = new Map(snapshotResult.rows.map(function(s) { return [s.ticker, s]; }));

  var withContext = candidates.map(function(candidate) {
    var ticker = candidate && candidate.ticker ? String(candidate.ticker).toUpperCase() : null;
    var snapshot = ticker ? byTicker.get(ticker) : null;
    return Object.assign({}, candidate, { _shadowDailyContext: snapshot || null });
  });

  return { candidates: withContext, enabled: true };
}

module.exports = {
  attachShadowContext
};
