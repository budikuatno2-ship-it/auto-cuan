'use strict';

/**
 * EOD Session State — typed terminal-state taxonomy, retry policy and
 * effective per-session universe classification.
 *
 * Wave 2 repair (W2-04/W2-05/W2-06/W2-08):
 *
 * BEFORE this module, the daily broker worker used ONE ambiguous bucket
 * ("NO_DATA") for every empty broker-summary response. That conflated:
 *   - a genuinely non-traded session (candle volume = 0), and
 *   - a traded session whose broker provider simply had not published
 *     (or could not serve) data yet,
 * which then (a) mislabeled traded tickers such as TCID (volume 200,
 * close 2600 on 2026-10-01) as NO_DATA, and (b) kept terminal rows in the
 * 30-minute retry set, burning quota on every firing.
 *
 * The taxonomy is deliberately explicit and the policy tables are the single
 * source of truth for retry/auxiliary/terminal decisions. Everything here is
 * a pure function — no clock, no I/O — so tests can assert the contract
 * directly and production behavior cannot drift from it silently.
 */

const EOD_STATES = Object.freeze({
  // Broker-summary rows exist for the target date: obligation satisfied.
  COMPLETE: 'COMPLETE',
  // A valid target-date candle proves volume == 0: the session was a no-trade
  // session. This is a TERMINAL state — never retried, never given auxiliary
  // requests.
  NO_TRADE: 'NO_TRADE',
  // The ticker traded (or cannot be proven not to have traded) but the broker
  // provider returned an empty/unavailable response on the FINAL pass of the
  // night. Terminal for the day; must never be relabeled NO_TRADE.
  BROKER_DATA_UNAVAILABLE: 'BROKER_DATA_UNAVAILABLE',
  // Transport / server / parser / rate-limit failure. Retry follows the
  // existing bounded failure policy (the date stays pending for the evening
  // window and is NOT counted as a provider no-data).
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  // A traded ticker whose broker data may legitimately not yet be published.
  // Retry is allowed ONLY inside the bounded EOD window (18:00-23:30 WIB);
  // the coordinator's terminal --final pass converts this to
  // BROKER_DATA_UNAVAILABLE.
  PENDING_PROVIDER: 'PENDING_PROVIDER'
});

/**
 * Retry / auxiliary / terminal policy per state.
 *
 * auxiliary=true only for COMPLETE, and only for same-day targets: the
 * accumulation/insiders endpoints are current-snapshot-only (no historical
 * date parameter), so auxiliary requests are additionally forbidden whenever
 * the target date is historical (enforced by the worker, W2-07).
 */
const RETRY_POLICY = Object.freeze({
  [EOD_STATES.COMPLETE]: Object.freeze({ retry: false, auxiliary: true, terminal: true }),
  [EOD_STATES.NO_TRADE]: Object.freeze({ retry: false, auxiliary: false, terminal: true }),
  [EOD_STATES.BROKER_DATA_UNAVAILABLE]: Object.freeze({ retry: false, auxiliary: false, terminal: true }),
  [EOD_STATES.UPSTREAM_ERROR]: Object.freeze({ retry: true, auxiliary: false, terminal: false }),
  [EOD_STATES.PENDING_PROVIDER]: Object.freeze({ retry: true, auxiliary: false, terminal: false })
});

function isKnownState(state) {
  return Object.prototype.hasOwnProperty.call(RETRY_POLICY, String(state));
}

function shouldRetry(state) {
  const policy = RETRY_POLICY[String(state)];
  return Boolean(policy && policy.retry);
}

function isTerminal(state) {
  const policy = RETRY_POLICY[String(state)];
  return Boolean(policy && policy.terminal);
}

function auxiliaryAllowed(state) {
  const policy = RETRY_POLICY[String(state)];
  return Boolean(policy && policy.auxiliary);
}

/**
 * Classify the outcome of a broker-summary attempt.
 *
 * Contract (W2-04 §13):
 *   - rows present                          -> COMPLETE
 *   - empty response + candle volume == 0   -> NO_TRADE (terminal, proven)
 *   - empty response + candle volume  > 0   -> PENDING_PROVIDER (non-final)
 *                                              BROKER_DATA_UNAVAILABLE (final)
 *   - empty response + no candle evidence   -> PENDING_PROVIDER (non-final)
 *                                              BROKER_DATA_UNAVAILABLE (final)
 *
 * NEVER classify volume > 0 as NO_TRADE. NEVER classify a transport error
 * here — transport failures go through classifyTransportFailure().
 *
 * @param {{hasRows: boolean, candleAvailable: boolean, candleVolume: number|null, isFinal: boolean}} input
 * @returns {string} one of EOD_STATES
 */
function classifyBrokerOutcome(input) {
  const hasRows = Boolean(input && input.hasRows);
  if (hasRows) return EOD_STATES.COMPLETE;

  const candleAvailable = Boolean(input && input.candleAvailable);
  const volume = input && input.candleVolume != null ? Number(input.candleVolume) : null;
  const isFinal = Boolean(input && input.isFinal);

  if (candleAvailable && volume === 0) {
    // Deterministic evidence: valid target-date candle with zero volume.
    return EOD_STATES.NO_TRADE;
  }

  // Traded-but-empty (volume > 0) or unproven (no candle): the provider may
  // still publish later. Only the final pass may declare it terminal, and it
  // is terminal as BROKER_DATA_UNAVAILABLE — never as NO_TRADE.
  return isFinal ? EOD_STATES.BROKER_DATA_UNAVAILABLE : EOD_STATES.PENDING_PROVIDER;
}

/**
 * Transport/server/parser/quota failures are always UPSTREAM_ERROR, which the
 * existing bounded failure policy retries (date stays pending). A transport
 * error must never be recorded as NO_TRADE or as provider no-data.
 */
function classifyTransportFailure() {
  return EOD_STATES.UPSTREAM_ERROR;
}

/**
 * Effective per-session universe states (W2-08).
 *
 * The master universe (962 tickers) is NEVER mutated. For one trading date we
 * classify each ticker into an effective session state using existing
 * authoritative data only:
 *   - TRADED: valid target-date candle with volume > 0
 *   - NO_TRADE: valid target-date candle with volume == 0
 *   - UNKNOWN: no target-date candle on disk (cannot prove anything)
 *
 * SUSPENDED / INACTIVE / DELISTED are part of the vocabulary but are NOT
 * inferred here: a single zero-volume session cannot prove a permanent
 * delisting, and no reliably date-scoped suspension source is consumed by
 * this worker. They remain UNKNOWN until an authoritative, date-scoped
 * status source is wired in.
 */
const SESSION_STATES = Object.freeze({
  TRADED: 'TRADED',
  NO_TRADE: 'NO_TRADE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
  DELISTED: 'DELISTED',
  UNKNOWN: 'UNKNOWN'
});

function classifySessionActivity(input) {
  const candleAvailable = Boolean(input && input.candleAvailable);
  if (!candleAvailable) return SESSION_STATES.UNKNOWN;
  const volume = input.candleVolume != null ? Number(input.candleVolume) : null;
  if (volume === 0) return SESSION_STATES.NO_TRADE;
  return SESSION_STATES.TRADED;
}

module.exports = {
  EOD_STATES,
  RETRY_POLICY,
  SESSION_STATES,
  isKnownState,
  shouldRetry,
  isTerminal,
  auxiliaryAllowed,
  classifyBrokerOutcome,
  classifyTransportFailure,
  classifySessionActivity
};
