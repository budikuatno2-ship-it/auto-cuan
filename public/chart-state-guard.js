/**
 * public/chart-state-guard.js
 * ============================================================================
 * V5 P0-009 / P1-024 — CHART / PLAN IDENTITY GUARD  (canonical implementation)
 * ============================================================================
 *
 * ROOT CAUSE THIS MODULE EXISTS TO REMOVE
 *   `public/unified-cockpit-runtime.js` wrote the whole chart payload into one
 *   mutable global (`root._chartPageData`) with no request sequence, no ticker
 *   stamp and no cancellation. `public/analisis-v2.js` derived the trading plan
 *   from whatever happened to be in that slot. A slow reply for a PREVIOUS
 *   ticker therefore overwrote the card of the ticker on screen: the observed
 *   BBCA chart at 9.860 beside a DSNG plan at 1.525 - 1.550.
 *
 * THE CONTRACT
 *   1. Every async read is tagged with a monotonic `seq` per category plus the
 *      identity `(ticker, category)` it was requested for.
 *   2. A write is accepted only when the token is still current AND the
 *      payload's own ticker agrees with the token AND its seq is newer than the
 *      newest write already stored for that category.
 *   3. A read returns an entry only when the stored identity matches the
 *      identity the caller is rendering for; otherwise it returns `null`.
 *   4. Identity comparison is strict on BOTH ticker and category (case and
 *      whitespace normalised). A chart snapshot can never satisfy a plan read,
 *      and the same ticker in two categories never collides.
 *
 * WHY THE SEQUENCE IS PER CATEGORY (not per ticker)
 *   Switching BBCA -> DSNG issues a higher `CHART` seq. The still-in-flight BBCA
 *   token therefore stops being current, which is exactly what makes a late
 *   BBCA response unpublishable. Per-ticker counters would leave the old token
 *   "current for BBCA" and the stale write would still land.
 *
 * SINGLE IMPLEMENTATION
 *   This file is the only implementation. `lib/chart-state-guard.js` re-exports
 *   it so Node code and `test/v5/chart-state-guard.test.js` exercise the exact
 *   bytes the browser runs (the identity is asserted in that test). The static
 *   asset responder (`lib/static-assets.js`) only serves `public/`, which is why
 *   the canonical copy lives here rather than in `lib/`.
 *
 * DESIGN NOTES
 *   - No I/O, no DOM, no timers, no dependencies. Safe in Node and in a browser.
 *   - Frozen vocabularies so a typo cannot invent a new state.
 *   - Loaded as a classic script it publishes `window.AutoCuanChartStateGuard`
 *     plus the shared singletons `AutoCuanChartGuard` / `AutoCuanChartBus`.
 * ============================================================================
 */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && root) {
    root.AutoCuanChartStateGuard = root.AutoCuanChartStateGuard || api;
    // Two page-wide singletons: the request guard (monotonic seq per category)
    // and the snapshot bus (one identity-checked snapshot per ticker+category).
    // Every module reads through these SAME objects, so a late response from a
    // previous ticker can never be published over the current one.
    root.AutoCuanChartGuard = root.AutoCuanChartGuard || api.createRequestGuard();
    root.AutoCuanChartBus = root.AutoCuanChartBus || api.createSnapshotBus();
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ------------------------------------------------------------------------ */
  /* Vocabulary                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Snapshot categories. A chart payload, a trading plan and a foreign-flow
   * series are three different things and never share a slot, even for one
   * ticker.
   */
  var CATEGORY = Object.freeze({
    CHART: 'chart',
    PLAN: 'plan',
    FOREIGN_FLOW: 'foreign-flow'
  });

  /** Why a write was refused. Machine-checkable, never free text. */
  var REJECT = Object.freeze({
    NOT_AN_ENTRY: 'NOT_AN_ENTRY',
    INCOMPLETE_IDENTITY: 'INCOMPLETE_IDENTITY',
    MISSING_SEQ: 'MISSING_SEQ',
    STALE_SEQ: 'STALE_SEQ',
    STALE_TOKEN: 'STALE_TOKEN',
    IDENTITY_MISMATCH: 'IDENTITY_MISMATCH'
  });

  /* ------------------------------------------------------------------------ */
  /* Normalisation                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * Canonical ticker form: `" bbca.jk "` -> `"BBCA"`.
   * Returns `''` when nothing usable was supplied (never a fabricated symbol).
   */
  function normalizeTicker(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .trim()
      .toUpperCase()
      .replace(/\.JK$/i, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Canonical category form. Keeps `-` and `_` because the front end uses
   * `foreign-flow` / `chart_page` style names; collapsing them would make two
   * different surfaces share one slot.
   */
  function normalizeCategory(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  }

  /** Extract the comparable identity of any record carrying ticker/category. */
  function identityOf(record) {
    var r = record && typeof record === 'object' ? record : {};
    return {
      ticker: normalizeTicker(r.ticker),
      category: normalizeCategory(r.category)
    };
  }

  /**
   * Strict identity comparison. Both `ticker` and `category` must be present and
   * equal after normalisation; a missing field never matches (so "unknown" is
   * not a wildcard).
   */
  function identityMatches(a, b) {
    var x = identityOf(a);
    var y = identityOf(b);
    if (!x.ticker || !y.ticker) return false;
    if (!x.category || !y.category) return false;
    return x.ticker === y.ticker && x.category === y.category;
  }

  /* ------------------------------------------------------------------------ */
  /* Request guard                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * Monotonic request sequencing, per category.
   *
   * @returns {{next:function(string,string):object,
   *            isCurrent:function(object|string):boolean,
   *            cancelAll:function(string=):void,
   *            peek:function(string=):object|null,
   *            lastSeq:function(string=):number}}
   */
  function createRequestGuard() {
    var seqByCategory = Object.create(null);
    var activeTokenByCategory = Object.create(null);

    function next(ticker, category) {
      var cat = normalizeCategory(category);
      var seq = (seqByCategory[cat] || 0) + 1;
      seqByCategory[cat] = seq;
      var token = {
        token: cat + '#' + seq,
        seq: seq,
        ticker: normalizeTicker(ticker),
        category: cat
      };
      activeTokenByCategory[cat] = token;
      return token;
    }

    /**
     * True only for the newest token of its own category AND a matching
     * identity. An older token is false even when its ticker is still active.
     * Accepts either the token object or the `token` string.
     */
    function isCurrent(candidate) {
      if (!candidate) return false;
      var cat = normalizeCategory(typeof candidate === 'object' ? candidate.category : '');
      if (!cat) return false;
      var active = activeTokenByCategory[cat];
      if (!active) return false;
      if (typeof candidate === 'object') {
        if (Number(candidate.seq) !== Number(active.seq)) return false;
        return identityMatches(candidate, active);
      }
      return String(candidate) === active.token;
    }

    /** Invalidate outstanding tokens (all categories, or just one). */
    function cancelAll(category) {
      if (category === undefined) {
        activeTokenByCategory = Object.create(null);
        return;
      }
      delete activeTokenByCategory[normalizeCategory(category)];
    }

    function peek(category) {
      if (category === undefined) return activeTokenByCategory;
      return activeTokenByCategory[normalizeCategory(category)] || null;
    }

    function lastSeq(category) {
      if (category === undefined) return seqByCategory;
      return seqByCategory[normalizeCategory(category)] || 0;
    }

    return {
      next: next,
      isCurrent: isCurrent,
      cancelAll: cancelAll,
      peek: peek,
      lastSeq: lastSeq
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Snapshot bus                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Stores at most ONE snapshot per `(ticker, category)` identity.
   *
   * `put(entry)` refuses:
   *   - an entry without a complete `(ticker, category)` identity,
   *   - an entry without a finite `seq`,
   *   - an entry whose `seq` is not newer than the watermark for its category
   *     (out-of-order async resolution, and a late reply for the ticker the user
   *     has just switched away from).
   *
   * `get(ticker, category)` returns the stored entry only when its identity
   * matches exactly AND it is the newest accepted write for that category;
   * otherwise `null`.
   */
  function createSnapshotBus() {
    var store = new Map();
    var watermarkByCategory = Object.create(null);

    function keyOf(ticker, category) {
      return normalizeTicker(ticker) + '|' + normalizeCategory(category);
    }

    function put(entry) {
      if (!entry || typeof entry !== 'object') {
        return { ok: false, reason: REJECT.NOT_AN_ENTRY, entry: null };
      }
      var id = identityOf(entry);
      if (!id.ticker || !id.category) {
        return { ok: false, reason: REJECT.INCOMPLETE_IDENTITY, entry: null };
      }
      var seq = Number(entry.seq);
      if (Number.isFinite(seq) === false) {
        return { ok: false, reason: REJECT.MISSING_SEQ, entry: null };
      }
      var watermark = watermarkByCategory[id.category] || 0;
      if (seq <= watermark) {
        return { ok: false, reason: REJECT.STALE_SEQ, entry: null, watermark: watermark };
      }

      var stored = Object.freeze({
        ticker: id.ticker,
        category: id.category,
        seq: seq,
        tradeDate: entry.tradeDate === undefined ? null : entry.tradeDate,
        sourceTimestamp: entry.sourceTimestamp === undefined ? null : entry.sourceTimestamp,
        payload: entry.payload === undefined ? null : entry.payload
      });
      store.set(keyOf(id.ticker, id.category), stored);
      watermarkByCategory[id.category] = seq;
      return { ok: true, reason: null, entry: stored };
    }

    function get(ticker, category) {
      var id = { ticker: ticker, category: category };
      var normalized = identityOf(id);
      if (!normalized.ticker || !normalized.category) return null;
      var stored = store.get(keyOf(normalized.ticker, normalized.category));
      if (!stored) return null;
      if (!identityMatches(stored, normalized)) return null;
      // A superseded snapshot is unreadable even if it is still in the map:
      // the user is now looking at a newer identity.
      if (Number(stored.seq) !== Number(watermarkByCategory[normalized.category] || 0)) return null;
      return stored;
    }

    function clear(ticker, category) {
      if (ticker === undefined) {
        store.clear();
        watermarkByCategory = Object.create(null);
        return;
      }
      var key = keyOf(ticker, category);
      store.delete(key);
    }

    function size() {
      return store.size;
    }

    return { put: put, get: get, clear: clear, size: size };
  }

  /* ------------------------------------------------------------------------ */
  /* Identity stamping                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Return a copy of `record` carrying a complete, normalised identity.
   * Never mutates the input and never invents a ticker: a missing ticker stays
   * `''` so `put()` / `assertIdentityMatch()` will reject it.
   *
   * `tradeDate` falls back to the record's `actual_data_date` and
   * `sourceTimestamp` to its `source_timestamp` — both are now published by
   * `api/candles.js` on every response.
   */
  function stampIdentity(record, expected) {
    var base = record && typeof record === 'object' ? record : {};
    var e = expected && typeof expected === 'object' ? expected : {};

    var ticker = e.ticker !== undefined ? e.ticker : base.ticker;
    var category = e.category !== undefined ? e.category : base.category;
    var tradeDate = e.tradeDate !== undefined
      ? e.tradeDate
      : (base.tradeDate !== undefined ? base.tradeDate : base.actual_data_date);
    var sourceTimestamp = e.sourceTimestamp !== undefined
      ? e.sourceTimestamp
      : base.source_timestamp;

    return Object.assign({}, base, {
      ticker: normalizeTicker(ticker),
      category: normalizeCategory(category),
      tradeDate: tradeDate === undefined ? null : tradeDate,
      sourceTimestamp: sourceTimestamp === undefined ? null : sourceTimestamp
    });
  }

  /**
   * Throw an `IDENTITY_MISMATCH` error unless both records carry the same
   * normalised identity. Returns `true` on success.
   */
  function assertIdentityMatch(record, expected) {
    if (identityMatches(record, expected)) return true;
    var actual = identityOf(record);
    var want = identityOf(expected);
    var err = new Error(
      'IDENTITY_MISMATCH: got ' + actual.ticker + '/' + actual.category +
      ', expected ' + want.ticker + '/' + want.category
    );
    err.name = 'IdentityMismatch';
    err.code = REJECT.IDENTITY_MISMATCH;
    err.actual = actual;
    err.expected = want;
    throw err;
  }

  /* ------------------------------------------------------------------------ */
  /* Convenience facade                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * Binds a guard and a bus into the read/write shape the front end needs.
   *
   * @param {{guard?:object, bus?:object}} [options]
   */
  function createChartState(options) {
    var opts = options || {};
    var guard = opts.guard || createRequestGuard();
    var bus = opts.bus || createSnapshotBus();

    /** Start a request: returns the token that must accompany the response. */
    function begin(ticker, category) {
      return guard.next(ticker, category);
    }

    /**
     * Publish a resolved payload. Refuses a stale token, a payload whose ticker
     * disagrees with the token, or an older sequence.
     */
    function publish(token, payload, meta) {
      if (!guard.isCurrent(token)) {
        return { ok: false, reason: REJECT.STALE_TOKEN, entry: null };
      }
      if (payload && typeof payload === 'object' && payload.ticker) {
        var payloadIdentity = { ticker: payload.ticker, category: token.category };
        if (!identityMatches(payloadIdentity, token)) {
          return { ok: false, reason: REJECT.IDENTITY_MISMATCH, entry: null };
        }
      }
      var m = meta && typeof meta === 'object' ? meta : {};
      return bus.put(stampIdentity({
        ticker: token.ticker,
        category: token.category,
        seq: token.seq,
        tradeDate: m.tradeDate,
        sourceTimestamp: m.sourceTimestamp,
        payload: payload
      }, token));
    }

    /** Identity-checked read. Returns the payload, or `null` on mismatch. */
    function read(ticker, category) {
      var entry = bus.get(ticker, category);
      return entry ? entry.payload : null;
    }

    /** Ticker of the newest request for a category, or `''` when none. */
    function currentTicker(category) {
      var active = guard.peek(category);
      return active && active.ticker ? active.ticker : '';
    }

    return {
      guard: guard,
      bus: bus,
      begin: begin,
      publish: publish,
      read: read,
      currentTicker: currentTicker,
      cancelAll: guard.cancelAll
    };
  }

  return {
    CATEGORY: CATEGORY,
    REJECT: REJECT,
    normalizeTicker: normalizeTicker,
    normalizeCategory: normalizeCategory,
    identityOf: identityOf,
    identityMatches: identityMatches,
    createRequestGuard: createRequestGuard,
    createSnapshotBus: createSnapshotBus,
    createChartState: createChartState,
    stampIdentity: stampIdentity,
    assertIdentityMatch: assertIdentityMatch
  };
});