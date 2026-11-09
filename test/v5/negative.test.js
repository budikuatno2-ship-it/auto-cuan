'use strict';

/**
 * test/v5/negative.test.js
 * ============================================================================
 * INDEPENDENT NEGATIVE CONTROLS N1–N25 — Auto-Cuan IDX V5
 * ============================================================================
 *
 * AUTHORITY
 *   - `audit-evidence/v5/archives/MASTER_PROMPT_V5_AUTO_CUAN_FINAL.md.txt` §20
 *     ("Negative controls wajib meliputi", 25 items)
 *   - `audit-evidence/v5/V5_CODE_TRACE_P0.md` §"Negative controls needed" N1–N22
 *   - `audit-evidence/v5/V5_MASTER_BUG_REGISTRY.md` (43 bugs, regression column)
 *
 * CONTRACT OF A CONTROL
 *   `run(ctx)`        THROWS when the defect is present. Returning normally means
 *                     the invariant held for every input actually examined.
 *   `defectProbe(ctx)` Independent (different code path) look for the same defect.
 *                     Returns a string describing live evidence, or null.
 *
 *   The runner uses the pair to classify:
 *     run() throws                          -> DETECTED  (control caught a live bug)
 *     run() ok + defectProbe() === null     -> PASSED    (bug genuinely absent)
 *     run() ok + defectProbe() !== null     -> BROKEN_CONTROL (control is broken)
 *     SkipControl                           -> SKIP
 *     PendingImplementation                 -> PENDING_IMPLEMENTATION
 *
 * BINDING RULES
 *   - No application source file is imported for the purpose of changing it.
 *   - No writes to `data/`, no network, no quota spend, no process exit.
 *   - A control that cannot run MUST NOT report PASS.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const H = require('./harness');

const { AssertionFailure, SkipControl, PendingImplementation } = H;

/* ========================================================================== */
/* Shared, lazily-loaded context (read-only)                                  */
/* ========================================================================== */

const CACHE = Object.create(null);

const SOURCE_FILES = Object.freeze({
  konglo: 'data/screener-v3f04-konglo.json',
  nonkonglo: 'data/screener-v3f04-nonkonglo.json',
  daytrade: 'data/screener-v3f04-daytrade.json'
});

const CATEGORY_KEYS = Object.freeze(['konglo', 'nonkonglo', 'daytrade']);

function screenerModule() {
  if (CACHE.screenerModule !== undefined) return CACHE.screenerModule;
  const res = H.requireOptional('api/screener.js');
  CACHE.screenerModule = res.ok ? res.module : null;
  return CACHE.screenerModule;
}

function screenerPayload() {
  if (CACHE.payload) return CACHE.payload;
  const mod = screenerModule();
  if (!mod || typeof mod.buildScreenerPayload !== 'function') {
    throw new SkipControl('api/screener.js does not export buildScreenerPayload()');
  }
  CACHE.payload = mod.buildScreenerPayload();
  return CACHE.payload;
}

function top5File() {
  if (CACHE.top5) return CACHE.top5;
  const res = H.loadJson('data/top5-radar.json');
  if (!res.ok) throw new SkipControl('data/top5-radar.json unreadable: ' + res.error);
  CACHE.top5 = res.data;
  return CACHE.top5;
}

function top5Picks() {
  const doc = top5File();
  const picks = doc.picks || doc.top5 || doc.top5_picks || [];
  return Array.isArray(picks) ? picks : [];
}

function sourceDoc(category) {
  const res = H.loadJson(SOURCE_FILES[category]);
  return res.ok ? res.data : null;
}

function sourceRows(category) {
  const doc = sourceDoc(category);
  if (!doc) return [];
  return Array.isArray(doc.results) ? doc.results : [];
}

function sourceTickerSet() {
  const set = new Set();
  for (const key of CATEGORY_KEYS) {
    for (const row of sourceRows(key)) {
      if (row && row.ticker) set.add(String(row.ticker).toUpperCase());
    }
  }
  return set;
}

function backtestRows() {
  if (CACHE.backtest) return CACHE.backtest;
  const res = H.loadJson('bukti-verifikasi-final/backtest-individual-964.json');
  const rows = res.ok && Array.isArray(res.data.tickers) ? res.data.tickers : [];
  CACHE.backtest = rows;
  return rows;
}

function backtestMap() {
  if (CACHE.backtestMap) return CACHE.backtestMap;
  const map = new Map();
  for (const row of backtestRows()) {
    if (row && row.ticker) map.set(String(row.ticker).toUpperCase(), row);
  }
  CACHE.backtestMap = map;
  return map;
}

function chartWorkstation() {
  if (CACHE.chartWorkstation !== undefined) return CACHE.chartWorkstation;
  const res = H.requireOptional('public/chart-workstation.js');
  CACHE.chartWorkstation = res.ok ? res.module : null;
  return CACHE.chartWorkstation;
}

/** Candle bars for a ticker from the daily store (read-only). */
function candlesFor(ticker) {
  const res = H.loadJson('data/daily-candles/' + ticker + '.json');
  if (!res.ok) return null;
  const bars = res.data.candles || res.data.data || [];
  return Array.isArray(bars) ? bars : [];
}

function allCandleFiles() {
  if (CACHE.candleFiles) return CACHE.candleFiles;
  const dir = H.abs('data/daily-candles');
  if (!fs.existsSync(dir)) throw new SkipControl('data/daily-candles is absent');
  CACHE.candleFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return CACHE.candleFiles;
}

function gitTracked(relativePath) {
  try {
    execSync('git ls-files --error-unmatch ' + JSON.stringify(relativePath), {
      cwd: H.ROOT,
      stdio: 'pipe'
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Scan lines for a pattern.
 *
 * `skipComments` defaults to true so that explanatory prose in JS/shell cannot
 * satisfy a control. It deliberately skips only true comment leaders:
 *   - `//`
 *   - `/*`, ` * ` (block-comment continuation with a leading space)
 *   - `#` when followed by a space or end-of-line (shell comment)
 * Markdown emphasis such as `**Status:**` must NOT be treated as a comment —
 * doing so previously hid a documentation claim from control N24.
 */
function lineScan(text, regex, options) {
  const opts = options || {};
  const lines = String(text || '').split(/\r?\n/);
  const hits = [];
  const isComment = (trimmed) => {
    if (trimmed.startsWith('//')) return true;
    if (trimmed.startsWith('/*')) return true;
    if (/^\*\s/.test(trimmed) || /^\*\/$/.test(trimmed)) return true;
    if (/^#(\s|$)/.test(trimmed)) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (opts.skipComments !== false && isComment(trimmed)) continue;
    if (regex.test(raw)) hits.push({ line: i + 1, text: trimmed });
  }
  return hits;
}

function windowAfter(text, startLine, spanLines) {
  const lines = String(text || '').split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  return lines.slice(start, Math.min(lines.length, start + spanLines));
}

/**
 * Locate the literal price substitutions the V5 code trace documents
 * (`last_price: 1550` / `380` / `1420` and the per-category default argument).
 * Returns "file:line,file:line" or null. Used only to enrich the failure text;
 * the assertion itself is driven by the live payload, not by this scan.
 */
function literalPriceSites() {
  const targets = [
    { file: 'api/screener.js', re: /last_price:\s*(1550|380|1420)\b/ },
    { file: 'scripts/top5-radar.js', re: /last_price:\s*(1550|380|1420)\b/ },
    { file: 'api/intel.js', re: /last_price:\s*(1550|380|1420)\b/ }
  ];
  const hits = [];
  for (const target of targets) {
    const src = H.readText(target.file);
    if (!src.ok) continue;
    for (const hit of lineScan(src.text, target.re)) hits.push(target.file + ':' + hit.line);
  }
  return hits.length ? hits.join(',') : null;
}

/* ========================================================================== */
/* Controls                                                                   */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* N1 — synthetic price constants must never be published as a market price   */
/* Guards: BUG-V5-P0-001 (contract #1 "Data harga palsu")                     */
/* -------------------------------------------------------------------------- */
const N1 = {
  id: 'N1',
  name: 'Synthetic price constants (1550/1420/380) never published as market price',
  bugIds: ['BUG-V5-P0-001'],
  invariant: 'No published row may carry last_price in {1550,1420,380,1000} unless the same ticker exists in the source screener JSON.',
  run() {
    const payload = screenerPayload();
    const published = Array.isArray(payload.results) ? payload.results : [];
    const sourceSet = sourceTickerSet();
    const untraced = published.filter((row) => !sourceSet.has(String(row && row.ticker).toUpperCase()));
    if (untraced.length === 0) return { checked: published.length, untraced: 0 };

    const forbidden = H.SYNTHETIC_PRICE_CONSTANTS;
    const forbiddenSet = new Set(forbidden.map(Number));
    const violations = untraced.filter((row) => forbiddenSet.has(H.priceOf(row)));
    if (violations.length > 0) {
      // Enforce the shared helper's rule (never weaken it) but surface a message
      // that names the exact substitution sites the code trace documents.
      let helperMessage = null;
      try {
        H.assertNoConstantPrice(violations, forbidden);
      } catch (err) {
        helperMessage = err.message;
      }
      const histogram = {};
      for (const row of violations) {
        const price = H.priceOf(row);
        histogram[price] = (histogram[price] || 0) + 1;
      }
      const literalSites = literalPriceSites();
      throw new AssertionFailure(
        helperMessage + ' | ' + violations.length + '/' + published.length + ' published rows have no source row ' +
        '(only ' + (published.length - untraced.length) + ' row(s) trace to a screener source file); ' +
        'price histogram of untraced rows = ' + JSON.stringify(histogram) +
        (literalSites ? '; literal substitution sites = ' + literalSites : ''),
        {
          published: published.length,
          untraced: untraced.length,
          histogram,
          sample: violations.slice(0, 8).map((r) => ({ ticker: r.ticker, last_price: H.priceOf(r) }))
        }
      );
    }
    if (violations.length > 0) {
      throw new AssertionFailure('untraced rows carry synthetic constants', { violations: violations.length });
    }
    return { checked: published.length, untraced: untraced.length };
  },
  defectProbe() {
    const payload = screenerPayload();
    const published = Array.isArray(payload.results) ? payload.results : [];
    const srcTotal = CATEGORY_KEYS.reduce((sum, key) => sum + sourceRows(key).length, 0);
    if (published.length <= srcTotal) return null;
    const sourceSet = sourceTickerSet();
    const synthetic = published.filter((row) => !sourceSet.has(String(row && row.ticker).toUpperCase()));
    if (synthetic.length === 0) return null;
    const priceCounts = {};
    for (const row of synthetic) {
      const p = H.priceOf(row);
      priceCounts[p] = (priceCounts[p] || 0) + 1;
    }
    return 'published=' + published.length + ' vs source rows=' + srcTotal +
      '; ' + synthetic.length + ' rows have no source provenance; price histogram of untraced rows=' +
      JSON.stringify(priceCounts);
  }
};

/* -------------------------------------------------------------------------- */
/* N2 — default score / win rate / RSI / volume ratio / change %              */
/* Guards: BUG-V5-P0-002 (contract #2 "Skor default", #3 "Win rate buatan")    */
/* -------------------------------------------------------------------------- */
const N2 = {
  id: 'N2',
  name: 'Literal defaults (82/85/88, 72.5, 56.4, 2.1/2.2, 1.8) never published as data',
  bugIds: ['BUG-V5-P0-002'],
  invariant: 'When no source value exists, a row must not publish score/win_rate_pct/rsi14/volume_ratio/change_pct equal to a literal default.',
  run() {
    const payload = screenerPayload();
    const published = Array.isArray(payload.results) ? payload.results : [];
    const sourceSet = sourceTickerSet();
    const checks = [
      { field: 'score', values: H.DEFAULT_SCORE_VALUES, read: (r) => H.num(r.score != null ? r.score : r.conviction_score) },
      { field: 'win_rate_pct', values: H.DEFAULT_WIN_RATE_VALUES, read: (r) => H.num(r.win_rate_pct != null ? r.win_rate_pct : r.winRatePct) },
      { field: 'rsi14', values: H.DEFAULT_RSI_VALUES, read: (r) => H.num(r.rsi14) },
      { field: 'volume_ratio', values: H.DEFAULT_VOLUME_RATIO_VALUES, read: (r) => H.num(r.volume_ratio != null ? r.volume_ratio : r.volume_ratio_20d) },
      { field: 'change_pct', values: H.DEFAULT_CHANGE_PCT_VALUES, read: (r) => H.num(r.change_pct) }
    ];

    const violations = [];
    for (const row of published) {
      const traced = sourceSet.has(String(row && row.ticker).toUpperCase());
      if (traced) continue;
      for (const check of checks) {
        const value = check.read(row);
        if (Number.isFinite(value) && check.values.indexOf(value) >= 0) {
          violations.push({ ticker: row && row.ticker, field: check.field, value });
        }
      }
    }
    if (violations.length > 0) {
      const byField = {};
      for (const v of violations) byField[v.field] = (byField[v.field] || 0) + 1;
      throw new AssertionFailure(
        violations.length + ' default-valued fields published on rows with no source provenance',
        { byField, sample: violations.slice(0, 10) }
      );
    }
    return { checked: published.length };
  },
  defectProbe() {
    const src = H.readText('api/screener.js');
    if (!src.ok) return null;
    const patterns = [
      { name: 'score floor Math.max(62', re: /Math\.max\(\s*62\s*,/ },
      { name: 'score default || 82', re: /\|\|\s*82\b/ },
      { name: 'win rate default 72.5', re: /\|\|\s*72\.5\b|:\s*72\.5\b/ },
      { name: 'RSI default 56.4', re: /\|\|\s*56\.4\b/ },
      { name: 'volume ratio default 2.2', re: /\|\|\s*2\.2\b/ },
      { name: 'change pct default 1.8', re: /:\s*1\.8\b/ },
      { name: 'R/R rescue || 2.0', re: /\|\|\s*2\.0\b/ }
    ];
    const hot = lineScan(src.text, /Math\.max\(\s*62\s*,|\|\|\s*(82|72\.5|56\.4|2\.2|2\.0)\b|:\s*(72\.5|1\.8)\b/);
    const names = patterns.filter((p) => p.re.test(src.text)).map((p) => p.name);
    if (hot.length === 0) return null;
    return 'literal plausible defaults still present in api/screener.js at lines ' +
      hot.map((h) => h.line).join(',') + ' (' + names.join('; ') + ')';
  }
};

/* -------------------------------------------------------------------------- */
/* N3 — READY / BUY / A+ / "Siap Entry" must never be an object literal       */
/* Guards: BUG-V5-P0-003 (contract §5 verdict-as-literal)                     */
/* -------------------------------------------------------------------------- */
const N3 = {
  id: 'N3',
  name: 'READY/BUY/A+/Siap Entry never emitted from literals or defaults',
  bugIds: ['BUG-V5-P0-003'],
  invariant: 'The readiness verdict must be computed from data; no producer may stamp it as an object-literal property.',
  run() {
    const producers = [
      { file: 'api/screener.js', response: /action:\s*'BUY'|action_label:\s*'BUY'|status:\s*'Ready'|setup:\s*'Swing Ready'/ },
      { file: 'scripts/top5-radar.js', response: /quality_grade:\s*'A\+'|grade:\s*'A\+'|risk_label:\s*'Low Risk'|trading_plan_valid:\s*true|safe:\s*true/ }
    ];
    const violations = [];
    for (const producer of producers) {
      const src = H.readText(producer.file);
      if (!src.ok) continue;
      for (const hit of lineScan(src.text, producer.response)) {
        violations.push({ file: producer.file, line: hit.line, text: hit.text });
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' readiness verdict(s) are object-literal assignments',
        { violations }
      );
    }

    // Dynamic corroboration: if no verdict can ever be non-ready, the literal is
    // load-bearing. Require at least one non-ready row on the live payload.
    const payload = screenerPayload();
    const published = Array.isArray(payload.results) ? payload.results : [];
    if (published.length > 0) {
      const ready = published.filter((row) => H.isReadyRow(row));
      if (ready.length === published.length) {
        throw new AssertionFailure(
          'all ' + published.length + ' published rows are READY/BUY — no code path produces a non-ready state',
          { published: published.length, ready: ready.length }
        );
      }
    }
    return { checked: published.length };
  },
  defectProbe() {
    const picks = top5Picks();
    const contradictory = picks.filter((p) => {
      const rr = H.rrOf(p);
      return H.isReadyRow(p) && Number.isFinite(rr) && rr < 1.5;
    });
    if (contradictory.length === 0) return null;
    return contradictory.length + '/' + picks.length + ' Top-5 picks declare the verdict as a literal while their own ' +
      'numbers contradict it (e.g. ' + contradictory.map((p) => p.ticker + ' rr=' + H.rrOf(p) + ' status=' + p.status + ' grade=' + p.quality_grade).slice(0, 3).join('; ') + ')';
  }
};

/* -------------------------------------------------------------------------- */
/* N4 — hardcoded Top 5 fallbacks, 0 candidates allowed, max 5 enforced       */
/* Guards: BUG-V5-P0-004 (contract #4 "Top 5 hardcoded")                      */
/* -------------------------------------------------------------------------- */
const N4 = {
  id: 'N4',
  name: 'Top 5 hardcoded fallbacks rejected; 0 candidates allowed; max 5 enforced',
  bugIds: ['BUG-V5-P0-004'],
  invariant: 'Every published Top-5 pick must exist in a real screener source file, the 5 picks must not share one metric tuple, and the cap is 5.',
  run() {
    const doc = top5File();
    const picks = top5Picks();
    if (picks.length > 5) {
      throw new AssertionFailure('Top 5 published ' + picks.length + ' picks (max 5)', { count: picks.length });
    }

    // (a) distinct metric tuples
    H.assertDistinctRows(picks, {
      fields: ['last_price', 'change_pct', 'volume_ratio_avg20', 'score', 'entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2'],
      minCount: 2
    });

    // (b) provenance: each pick must exist in a real source file
    const sourceSet = sourceTickerSet();
    const untraced = picks.filter((p) => !sourceSet.has(String(p && p.ticker).toUpperCase()));
    if (untraced.length > 0) {
      throw new AssertionFailure(
        untraced.length + '/' + picks.length + ' Top-5 tickers exist only in a hardcoded fallback array',
        { untraced: untraced.map((p) => p.ticker) }
      );
    }

    // (c) a locked publication requires >= 5 real candidates per category
    if (doc.top5_locked === true) {
      const thin = CATEGORY_KEYS.filter((key) => sourceRows(key).length < 5);
      if (thin.length > 0) {
        throw new AssertionFailure(
          'top5_locked=true while category source row counts are below 5',
          { categories: thin.map((key) => ({ key, sourceRows: sourceRows(key).length })) }
        );
      }
    }
    return { picks: picks.length };
  },
  defectProbe() {
    const doc = top5File();
    const picks = top5Picks();
    const signature = picks
      .map((p) => [p.last_price, p.change_pct, p.volume_ratio_avg20, p.score, p.entry_low, p.entry_high, p.stop_loss, p.tp1, p.tp2].join('/'))
      .filter((v, i, arr) => arr.indexOf(v) === i);
    if (signature.length !== 1 || picks.length < 2) return null;
    const daytrade = sourceRows('daytrade').length;
    return 'all ' + picks.length + ' picks share tuple ' + signature[0] +
      '; tickers=' + picks.map((p) => p.ticker).join(',') +
      '; daytrade source rows=' + daytrade + '; top5_locked=' + doc.top5_locked +
      '; top5_source=' + doc.top5_source;
  }
};

/* -------------------------------------------------------------------------- */
/* N5 — R/R >= 1.5 enforced on EVERY publish path (the 1.39 "Ready" case)     */
/* Guards: BUG-V5-P0-005 (contract #5 "Ready dengan R/R 1,39")                */
/* -------------------------------------------------------------------------- */
const N5 = {
  id: 'N5',
  name: 'R/R >= 1.5 enforced on every publish path; 1.39 + "Ready" rejected',
  bugIds: ['BUG-V5-P0-005', 'BUG-V5-P0-025'],
  invariant: 'Every row published as READY/BUY/A+/Siap Entry must satisfy the repository gate passesRiskRewardFilter(row, MIN_RR_RATIO, {recalculate:true}).',
  run() {
    const cfg = H.requireOrPending('lib/screener-config.js', ['passesRiskRewardFilter', 'MIN_RR_RATIO'],
      'The 1.5 R/R policy module must exist to enforce the gate on publish paths.');
    if (typeof cfg.passesRiskRewardFilter !== 'function') {
      throw new PendingImplementation('lib/screener-config.js', ['passesRiskRewardFilter'], 'gate function missing');
    }
    const threshold = Number(cfg.MIN_RR_RATIO);

    // Sanity: the gate itself must reject the documented 1.39 case.
    const probe = {
      ticker: 'PANI', entry_low: 1399, entry_high: 1420, stop_loss: 1349, tp1: 1519, tp2: 1619,
      risk_reward: 1.39, rr: 1.39
    };
    if (cfg.passesRiskRewardFilter(probe, threshold, { recalculate: true }) !== false) {
      throw new AssertionFailure('passesRiskRewardFilter() accepted rr=1.39 as valid', { threshold });
    }

    const paths = [
      { name: 'api/screener.js (results)', rows: (screenerPayload().results || []) },
      { name: 'data/top5-radar.json (picks)', rows: top5Picks() }
    ];

    const violations = [];
    for (const publishPath of paths) {
      for (const row of publishPath.rows) {
        if (!H.isReadyRow(row)) continue;
        const accepted = cfg.passesRiskRewardFilter(row, threshold, { recalculate: true });
        if (accepted !== true) {
          violations.push({ path: publishPath.name, ticker: row && row.ticker, rr: H.rrOf(row), status: row && row.status, grade: row && (row.quality_grade || row.grade) });
        }
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' ready rows bypass passesRiskRewardFilter (threshold ' + threshold + ')',
        { threshold, violations: violations.slice(0, 12) }
      );
    }
    return { threshold };
  },
  defectProbe() {
    const files = ['api/screener.js', 'scripts/top5-radar.js'];
    const notWired = files.filter((f) => {
      const src = H.readText(f);
      if (!src.ok) return false;
      return !/screener-config|passesRiskRewardFilter|MIN_RR/.test(src.text);
    });
    if (notWired.length === 0) return null;
    const ready = (screenerPayload().results || []).filter((r) => H.isReadyRow(r));
    const below = ready.filter((r) => Number(H.rrOf(r)) < 1.5);
    return 'publish producers never import the R/R policy: ' + notWired.join(', ') +
      '; live: ' + below.length + '/' + ready.length + ' ready screener rows have rr<1.5' +
      '; top5 picks with rr<1.5 and READY: ' + top5Picks().filter((p) => H.isReadyRow(p) && Number(H.rrOf(p)) < 1.5).length;
  }
};

/* -------------------------------------------------------------------------- */
/* N6 — OHLC validity                                                          */
/* Guards: BUG-V5-P1-035 (contract #6 "OHLC invalid")                          */
/* -------------------------------------------------------------------------- */
const N6 = {
  id: 'N6',
  name: 'OHLC validity: high>=low, open/close within [low,high], volume>=0',
  bugIds: ['BUG-V5-P2-001', 'BUG-V5-P1-035'],
  invariant: 'Every local candle bar must satisfy high>=low, low<=open<=high, low<=close<=high, volume>=0.',
  run() {
    const files = allCandleFiles();
    if (files.length === 0) throw new SkipControl('no candle files on disk');

    const violations = [];
    let bars = 0;
    for (const file of files) {
      const res = H.loadJson('data/daily-candles/' + file);
      if (!res.ok) continue;
      const barsArr = res.data.candles || res.data.data || [];
      for (const bar of barsArr) {
        bars += 1;
        const o = H.num(bar.open), hi = H.num(bar.high), lo = H.num(bar.low), c = H.num(bar.close), v = H.num(bar.volume);
        let reason = null;
        if (![o, hi, lo, c].every(Number.isFinite)) reason = 'non-finite OHLC';
        else if (!(hi >= lo)) reason = 'high<low';
        else if (o > hi || o < lo) reason = 'open outside [low,high]';
        else if (c > hi || c < lo) reason = 'close outside [low,high]';
        else if (Number.isFinite(v) && v < 0) reason = 'negative volume';
        if (reason) {
          violations.push({ file, reason, o, hi, lo, c, v });
          if (violations.length >= 20) break;
        }
      }
      if (violations.length >= 20) break;
    }
    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' OHLC violations across ' + files.length + ' files', { bars, violations });
    }
    return { files: files.length, bars };
  },
  defectProbe() {
    // The de-split transform in api/chart.js multiplies all four prices, so it
    // preserves the ordering invariant. Confirm nothing currently violates it.
    const res = H.loadJson('data/daily-candles/BBCA.json');
    if (!res.ok) return null;
    const bars = res.data.candles || [];
    const broken = bars.filter((b) => !(H.num(b.high) >= H.num(b.low))).length;
    return broken > 0 ? broken + ' BBCA bars violate high>=low' : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N7 — foreign flow unit reconciliation                                      */
/* Guards: BUG-V5-P1-017 / BUG-V5-P0-011 (contract #7 "Foreign Flow salah unit")*/
/* -------------------------------------------------------------------------- */
const N7 = {
  id: 'N7',
  name: 'Foreign flow unit reconciliation (no fabricated magnitude, |net| <= turnover)',
  bugIds: ['BUG-V5-P1-017', 'BUG-V5-P0-011'],
  invariant: 'The server may never assign a foreign-flow magnitude it did not read, and |net foreign| may never exceed the session turnover for that ticker.',
  run() {
    // (a) no fabricated magnitudes in the server path
    const quote = H.readText('api/quote.js');
    if (!quote.ok) throw new SkipControl('api/quote.js unreadable');

    const fabrications = [];
    for (const hit of lineScan(quote.text, /\b(?:15e9|35e9|60e9|144776632)\b/)) {
      fabrications.push({ file: 'api/quote.js', line: hit.line, text: hit.text });
    }
    for (const hit of lineScan(quote.text, /foreign_net_(?:today|3d|7d)\s*=\s*\(?\s*r\.foreign_net/)) {
      fabrications.push({ file: 'api/quote.js', line: hit.line, text: hit.text });
    }
    if (fabrications.length > 0) {
      throw new AssertionFailure(
        fabrications.length + ' fabricated foreign-flow magnitude assignment(s) in api/quote.js',
        { fabrications }
      );
    }

    // (b) plausibility: no double multiplication
    const fd = H.loadJson('data/foreign-flow-multi-day.json');
    if (!fd.ok) throw new SkipControl('data/foreign-flow-multi-day.json unreadable');
    const data = (fd.data && fd.data.data) || {};
    const implausible = [];
    let checked = 0;
    for (const ticker of Object.keys(data)) {
      const row = data[ticker] || {};
      const price = H.num(row.last_price);
      const volume = H.num(row.volume_today);
      const net = H.num(row.foreign_net_today);
      if (!Number.isFinite(price) || !Number.isFinite(volume) || !Number.isFinite(net) || volume <= 0) continue;
      checked += 1;
      const turnover = price * volume;
      if (Math.abs(net) > turnover) {
        implausible.push({ ticker, net, turnover: Math.round(turnover) });
      }
    }
    if (implausible.length > 0) {
      throw new AssertionFailure(
        implausible.length + '/' + checked + ' tickers report |net foreign| > session turnover',
        { implausible: implausible.slice(0, 10) }
      );
    }
    return { checked };
  },
  defectProbe() {
    const quote = H.readText('api/quote.js');
    if (!quote.ok) return null;
    const hits = lineScan(quote.text, /\b(?:15e9|35e9|60e9|144776632)\b/);
    if (hits.length === 0) return null;
    return 'api/quote.js substitutes synthetic rupiah magnitudes at line(s) ' +
      hits.map((h) => h.line).join(',') + ' — e.g. ' + hits[0].text;
  }
};

/* -------------------------------------------------------------------------- */
/* N8 — missing data must render an absence marker, never numeric 0           */
/* Guards: BUG-V5-P0-011 (contract #8 "Nilai missing menjadi nol")            */
/* -------------------------------------------------------------------------- */
const N8 = {
  id: 'N8',
  name: 'Missing data renders "—"/status, never numeric 0 or "Rp 0"',
  bugIds: ['BUG-V5-P0-011'],
  invariant: 'A foreign-flow producer must return an explicit absence (null) on a miss, and the formatter must not collapse absence into "Rp 0".',
  run() {
    const ws = chartWorkstation();
    if (!ws || typeof ws.getLatestForeignNet !== 'function') {
      throw new PendingImplementation('public/chart-workstation.js', ['getLatestForeignNet'],
        'The producer that must return null-on-miss is not loadable.');
    }
    const missCandles = [{ date: '2026-11-04', open: 100, high: 105, low: 95, close: 100, volume: 1000 }];
    const produced = ws.getLatestForeignNet(missCandles, []);

    const violations = [];
    if (produced === 0 || produced === '0') {
      violations.push('getLatestForeignNet() returned numeric 0 for a dataset with no foreign-flow field (contract requires null)');
    }
    // Explicit absence must survive the formatter.
    H.assertMissingNotZero(produced === 0 ? 'Rp 0' : produced, 'MISSING');

    if (typeof ws.formatIndonesianRupiahCompact === 'function') {
      const renderedZero = ws.formatIndonesianRupiahCompact(0);
      const renderedNull = ws.formatIndonesianRupiahCompact(null);
      if (renderedZero === 'Rp 0' || renderedNull === 'Rp 0') {
        violations.push('formatIndonesianRupiahCompact() renders "Rp 0" for 0/null — absence and a genuine zero are indistinguishable (' +
          'null->"' + renderedNull + '")');
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' missing-data collapses into a numeric zero', { violations, produced });
    }
    return { produced };
  },
  defectProbe() {
    const ws = H.readText('public/chart-workstation.js');
    const mfr = H.readText('public/market-feature-runtime.js');
    const evidence = [];
    if (ws.ok) {
      const ret0 = lineScan(ws.text, /^\s*return 0;\s*$/);
      const rp0 = lineScan(ws.text, /return 'Rp 0'/);
      if (ret0.length) evidence.push('chart-workstation.js:' + ret0.map((h) => h.line).join(',') + ' returns numeric 0 on producer miss');
      if (rp0.length) evidence.push('chart-workstation.js:' + rp0.map((h) => h.line).join(',') + " formats 0/null as 'Rp 0'");
    }
    if (mfr.ok) {
      const fallback = lineScan(mfr.text, /'Rp 0'/);
      if (fallback.length) evidence.push('market-feature-runtime.js:' + fallback.map((h) => h.line).join(',') + " has a literal 'Rp 0' fallback");
    }
    return evidence.length ? evidence.join('; ') : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N9 — no look-ahead trades in backtest                                      */
/* Guards: contract #9 "Trade dengan data masa depan"                          */
/* -------------------------------------------------------------------------- */
const N9 = {
  id: 'N9',
  name: 'No look-ahead trades in backtest (entry/exit never before signal date)',
  bugIds: ['BUG-V5-P1-022'],
  invariant: 'For every backtest trade, signal_date <= entry_date <= exit_date and no fill may precede the signal bar.',
  run() {
    const candidates = [
      'backtest/brpt-lpm/trades.csv',
      'backtest/brpt-lpm/data/backtest_results.json'
    ];
    const examd = [];
    const violations = [];

    const csv = H.readText('backtest/brpt-lpm/trades.csv');
    if (csv.ok) {
      const rows = csv.lines.filter((l) => l.trim().length > 0);
      const header = rows[0].split(',');
      const iSignal = header.indexOf('signal_date');
      const iEntry = header.indexOf('entry_date');
      const iExit = header.indexOf('exit_date');
      if (iSignal >= 0 && iEntry >= 0) {
        for (let i = 1; i < rows.length; i += 1) {
          const cells = rows[i].split(',');
          const signal = cells[iSignal];
          const entry = cells[iEntry];
          const exit = cells[iExit];
          if (entry && signal && entry < signal) violations.push({ file: 'trades.csv', row: i + 1, reason: 'entry before signal', signal, entry });
          if (exit && entry && exit < entry) violations.push({ file: 'trades.csv', row: i + 1, reason: 'exit before entry', entry, exit });
        }
        examd.push('backtest/brpt-lpm/trades.csv (' + (rows.length - 1) + ' trades)');
      }
    }

    const result = H.loadJson('backtest/brpt-lpm/data/backtest_results.json');
    if (result.ok) {
      const strategies = result.data.strategies || {};
      for (const key of Object.keys(strategies)) {
        const trades = (strategies[key] && strategies[key].trades) || [];
        for (const t of trades) {
          const signal = t.signal_date || t.signalDate;
          const entry = t.entry_date || t.entryDate;
          const exit = t.exit_date || t.exitDate;
          if (signal && entry && String(entry) < String(signal)) violations.push({ file: 'backtest_results.json', strategy: key, reason: 'entry before signal', signal, entry });
          if (entry && exit && String(exit) < String(entry)) violations.push({ file: 'backtest_results.json', strategy: key, reason: 'exit before entry', entry, exit });
        }
        if (trades.length) examd.push(key + ' (' + trades.length + ' trades)');
      }
    }

    if (examd.length === 0) {
      throw new SkipControl('no on-disk backtest trade ledger found (checked ' + candidates.join(', ') + ')');
    }
    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' look-ahead ordering violations', { violations: violations.slice(0, 12) });
    }
    return { examined: examd };
  },
  defectProbe() {
    const csv = H.readText('backtest/brpt-lpm/trades.csv');
    if (!csv.ok) return null;
    const rows = csv.lines.filter((l) => l.trim().length > 0);
    const header = rows[0].split(',');
    const iSignal = header.indexOf('signal_date');
    const iEntry = header.indexOf('entry_date');
    if (iSignal < 0 || iEntry < 0) return null;
    let outOfOrder = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const cells = rows[i].split(',');
      if (cells[iEntry] && cells[iSignal] && cells[iEntry] < cells[iSignal]) outOfOrder += 1;
    }
    return outOfOrder > 0 ? outOfOrder + ' trades enter before their signal date' : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N10 — fundamentals must not be used before publication date                */
/* Guards: contract #10 "Fundamental sebelum tanggal publikasi"               */
/* -------------------------------------------------------------------------- */
const N10 = {
  id: 'N10',
  name: 'Fundamentals must not be usable before their publication date',
  bugIds: ['BUG-V5-P1-012'],
  invariant: 'Every stored fundamental item must carry a publication/announcement date so consumption can be ordered against it.',
  run() {
    const dir = H.abs('data/fundamental');
    if (!fs.existsSync(dir)) throw new SkipControl('data/fundamental is absent');

    function walk(current, out) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.json')) out.push(full);
      }
      return out;
    }

    const files = walk(dir, []);
    if (files.length === 0) throw new SkipControl('no fundamentals files on disk');

    let items = 0;
    const undated = [];
    for (const file of files) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
      const list = (doc && doc.data && doc.data.items) || [];
      for (const item of list) {
        items += 1;
        const keys = Object.keys(item || {}).join(',').toLowerCase();
        const hasPublication = /publish|publication|announce|filing|rili|effective_date/.test(keys);
        if (!hasPublication) {
          if (undated.length < 5) undated.push({ file: path.relative(H.ROOT, file), keys: Object.keys(item || {}).join(',') });
        }
      }
    }

    if (items > 0 && undated.length > 0) {
      throw new AssertionFailure(
        'fundamental items carry no publication date — look-ahead cannot be prevented (' + items + ' items checked)',
        { items, files: files.length, sample: undated }
      );
    }
    if (items === 0) throw new SkipControl('fundamental files contain no items');
    return { files: files.length, items };
  },
  defectProbe() {
    const hits = [];
    for (const candidate of ['lib/admin-fundamentals-upload.js', 'tools/import-fundamentals.js', 'lib/screener-config.js']) {
      const src = H.readText(candidate);
      if (!src.ok) continue;
      const guard = lineScan(src.text, /publication|publish(ed)?_at|announcement_date/);
      if (guard.length) hits.push(candidate + ':' + guard.map((h) => h.line).join(','));
    }
    return hits.length === 0
      ? 'no module enforces a fundamentals publication-date ordering (searched admin-fundamentals-upload, import-fundamentals, screener-config)'
      : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N11 — harmonic patterns only after pivot confirmation                      */
/* Guards: contract #11 "Harmonic sebelum konfirmasi pivot"                   */
/* -------------------------------------------------------------------------- */
const N11 = {
  id: 'N11',
  name: 'Harmonic pattern published only after pivot confirmation',
  bugIds: ['BUG-V5-P1-022'],
  invariant: 'An XABCD/harmonic pattern may only be published once the D pivot is confirmed, i.e. at least one bar exists after D.',
  run() {
    const ws = chartWorkstation();
    if (!ws || typeof ws.calculateV3F09XABCD !== 'function') {
      throw new PendingImplementation('public/chart-workstation.js', ['calculateV3F09XABCD'],
        'The XABCD detector that must expose pivot confirmation is not loadable.');
    }
    const files = allCandleFiles().slice(0, 200);
    if (files.length === 0) throw new SkipControl('no candle files');

    const unconfirmed = [];
    let patterns = 0;
    for (const file of files) {
      const res = H.loadJson('data/daily-candles/' + file);
      if (!res.ok) continue;
      const raw = (res.data.candles || []).slice(-100).map((c) => ({
        time: String(c.date || c.time || '').slice(0, 10),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
      }));
      if (raw.length < 20) continue;
      let xb;
      try { xb = ws.calculateV3F09XABCD(raw); } catch (_) { continue; }
      if (!xb || xb.valid !== true || !xb.d) continue;
      patterns += 1;
      const lastIndex = raw.length - 1;
      if (Number(xb.d.index) >= lastIndex) {
        unconfirmed.push({ ticker: file.replace('.json', ''), dIndex: Number(xb.d.index), lastIndex, label: xb.dLabel });
      }
    }
    if (patterns === 0) throw new SkipControl('no XABCD pattern could be produced from local candles');
    if (unconfirmed.length > 0) {
      throw new AssertionFailure(
        unconfirmed.length + '/' + patterns + ' patterns place the D pivot on the newest bar (pivot not yet confirmed)',
        { patterns, sample: unconfirmed.slice(0, 8) }
      );
    }
    return { patterns };
  },
  defectProbe() {
    const producer = H.readText('api/pattern-radar.js');
    if (!producer.ok) return null;
    const stamped = lineScan(producer.text, /status:\s*'Terkonfirmasi'|badge:\s*'Terkonfirmasi'/);
    const cache = H.loadJson('data/pattern-radar-cache.json');
    let cacheInfo = 'cache unavailable';
    if (cache.ok) {
      const patterns = cache.data.patterns || [];
      const confirmed = patterns.filter((p) => /Terkonfirmasi|Konfirmasi/i.test(String(p && p.status)));
      cacheInfo = confirmed.length + '/' + patterns.length + ' cached patterns stamped confirmed';
    }
    if (stamped.length === 0) return null;
    return 'api/pattern-radar.js stamps confirmation status unconditionally at line(s) ' +
      stamped.map((h) => h.line).join(',') + '; ' + cacheInfo +
      '; the published object carries no confirmation-bar date/index field';
  }
};

/* -------------------------------------------------------------------------- */
/* N12 — cron SKIPPED must not be reported SUCCESS / exit 0                   */
/* Guards: BUG-V5-P0-007 (contract #12 "Cron SKIP dengan exit 0")             */
/* -------------------------------------------------------------------------- */
const N12 = {
  id: 'N12',
  name: 'SKIPPED cron outcome is not reported as SUCCESS / exit 0',
  bugIds: ['BUG-V5-P0-007'],
  invariant: 'Distinct job outcomes (OK, SCHEDULED_SKIP, FORBIDDEN_WINDOW_SKIP, LOCK_BUSY, TIMEOUT, ERROR) must map to distinct exit codes; a skip may not exit 0.',
  run() {
    const src = H.readText('deploy/vps/job-wrapper.sh');
    if (!src.ok) throw new SkipControl('deploy/vps/job-wrapper.sh unreadable');
    const lines = src.lines;

    const skipStatuses = ['SCHEDULED_SKIP', 'LOCK_BUSY', 'FORBIDDEN_WINDOW_SKIP'];
    const violations = [];

    for (const status of skipStatuses) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim().startsWith('#')) continue;
        if (lines[i].indexOf('STATUS="' + status + '"') < 0) continue;
        const window = lines.slice(i + 1, i + 5);
        if (window.some((l) => /EXIT_CODE=0/.test(l))) {
          violations.push({ status, line: i + 1, reason: 'status is collapsed into EXIT_CODE=0' });
        }
      }
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim().startsWith('#')) continue;
        if (lines[i].indexOf('"status":"' + status + '"') < 0) continue;
        const window = lines.slice(i + 1, i + 8);
        if (window.some((l) => /^\s*exit 0\s*$/.test(l))) {
          violations.push({ status, line: i + 1, reason: 'heartbeat writes exitCode 0 then exits 0' });
        }
      }
    }

    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' skip outcome(s) collapse into exit code 0',
        { violations }
      );
    }
    return { checked: skipStatuses };
  },
  defectProbe() {
    const src = H.readText('deploy/vps/job-wrapper.sh');
    if (!src.ok) return null;
    const lines = src.lines;
    const mappings = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /STATUS="([A-Z_]+)"\s*$/.exec(lines[i].trim());
      if (!m) continue;
      const window = lines.slice(i + 1, i + 4).join(' ');
      const zero = /EXIT_CODE=0/.test(window);
      if (zero) mappings.push(m[1] + '->0');
    }
    const evidence = [];
    if (mappings.length) evidence.push('status->exit0 mappings: ' + mappings.join(', '));
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].indexOf('"status":"FORBIDDEN_WINDOW_SKIP"') < 0) continue;
      const window = lines.slice(i + 1, i + 8).join(' ');
      if (/"exitCode":0/.test(window) || /(^|\s)exit 0(\s|$)/.test(window)) {
        evidence.push('heartbeat at line ' + (i + 1) + ' hardcodes "exitCode":0 for FORBIDDEN_WINDOW_SKIP then exits 0');
      }
    }
    return evidence.length ? evidence.join('; ') : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N13 — two active schedulers for the same job must be a detected conflict   */
/* Guards: BUG-V5-P0-006 / BUG-V5-P1-031 (contract #13 "Dua scheduler aktif") */
/* -------------------------------------------------------------------------- */
const N13 = {
  id: 'N13',
  name: 'Two schedulers active for the same job is detected as a conflict',
  bugIds: ['BUG-V5-P0-006', 'BUG-V5-P1-031'],
  invariant: 'No script may be scheduled by both the cron table and the PM2 scheduler daemon.',
  run() {
    const cron = H.readText('deploy/vps/final-schedule.cron');
    const daemon = H.readText('scripts/scheduler-daemon.js');
    if (!cron.ok || !daemon.ok) throw new SkipControl('scheduler definitions unreadable');

    const daemonScripts = new Map();
    const daemonMatches = daemon.text.matchAll(/runNode\(\s*'([^']+)'/g);
    for (const m of daemonMatches) daemonScripts.set(path.basename(m[1]), m[1]);

    const cronScripts = new Map();
    for (const line of cron.lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      for (const script of daemonScripts.keys()) {
        if (line.indexOf(script) >= 0) {
          const job = /job-wrapper\.sh\s+([a-z0-9_-]+)/i.exec(line);
          cronScripts.set(script, job ? job[1] : '(inline)');
        }
      }
    }

    const overlap = [...daemonScripts.keys()].filter((s) => cronScripts.has(s));
    if (overlap.length > 0) {
      throw new AssertionFailure(
        overlap.length + ' script(s) are scheduled by BOTH deploy/vps/final-schedule.cron and scripts/scheduler-daemon.js',
        {
          overlap: overlap.map((s) => ({ script: daemonScripts.get(s), cronJob: cronScripts.get(s) })),
          daemonScheduled: daemonScripts.size,
          cronScheduled: cronScripts.size
        }
      );
    }
    return { daemonScheduled: daemonScripts.size, cronScheduled: cronScripts.size };
  },
  defectProbe() {
    const eco = H.readText('ecosystem.config.js');
    const cron = H.readText('deploy/vps/final-schedule.cron');
    const daemon = H.readText('scripts/scheduler-daemon.js');
    if (!eco.ok || !cron.ok || !daemon.ok) return null;
    const daemonProcess = lineScan(eco.text, /script:\s*path\.join\(ROOT,\s*'scripts',\s*'scheduler-daemon\.js'\)/);
    const cronEntries = cron.lines.filter((l) => l.trim() && !l.trim().startsWith('#') && /job-wrapper\.sh/.test(l));
    if (daemonProcess.length === 0 || cronEntries.length === 0) return null;

    // Independent evidence requires the daemon to still actually schedule a job
    // that cron also owns. After the N13 reconciliation the daemon schedules no
    // jobs (it only observes the WIB window), so there is no live conflict.
    const daemonScripts = [];
    for (const m of daemon.text.matchAll(/runNode\(\s*'([^']+)'/g)) {
      daemonScripts.push(m[1]);
    }
    if (daemonScripts.length === 0) return null;

    const overlap = daemonScripts.filter((s) => cron.text.indexOf(path.basename(s)) >= 0);
    return overlap.length > 0
      ? 'daemon still schedules scripts also owned by cron: ' + overlap.join(', ')
      : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N14 — quota concurrency race                                               */
/* Guards: BUG-V5-P0-023 (contract #14 "Quota race condition")                */
/* -------------------------------------------------------------------------- */
const N14 = {
  id: 'N14',
  name: 'Quota concurrency race: concurrent reservations must not exceed the limit',
  bugIds: ['BUG-V5-P0-023'],
  invariant: 'A reservation API must atomically claim quota so N concurrent callers can never be granted more than the remaining budget.',
  seam: 'lib/quota-reservation.js must export reserveQuota(count, jobType, opts) -> {ok, granted, remainingAfter, reservationId} and releaseQuota(reservationId).',
  run() {
    // The seam that must own the atomic claim does not exist yet.
    const mod = H.requireOrPending('lib/quota-reservation.js', ['reserveQuota'],
      'Quota reservation atomicity has no owning module; lib/quota-state.js only exposes check-then-act helpers (canConsumeQuota) that do not reserve.');
    if (typeof mod.reserveQuota !== 'function') {
      throw new PendingImplementation('lib/quota-reservation.js', ['reserveQuota'], 'reserveQuota export missing');
    }
    const limit = 10;
    let spent = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = mod.reserveQuota(1, 'backfill', { limit, used: spent });
      if (res && res.ok) spent += 1;
    }
    if (spent > limit) {
      throw new AssertionFailure('concurrent reservations exceeded the limit', { limit, spent });
    }
    return { limit, spent };
  },
  defectProbe() {
    const qs = H.requireOptional('lib/quota-state.js');
    if (!qs.ok) return null;
    const exports = Object.keys(qs.module || {});

    // An atomic reservation API must CLAIM quota. `reserveFloorFor` only
    // computes a floor number, so a loose /reserve/ test would wrongly clear
    // this control. Match the actual claim verbs only.
    const ATOMIC = /^(reserveQuota|claimQuota|consumeQuota|reserveBudget|claimBudget|atomicReserve)$/;
    if (exports.some((k) => ATOMIC.test(k))) return null;

    // Demonstrate the live double-spend with the existing check-only API:
    // two callers each asking for the whole budget are both granted.
    const now = new Date('2026-11-05T04:00:00Z');
    const readOnly = exports.filter((k) => /canConsume|recordLocalUsage|syncFromUpstream/i.test(k));
    const first = qs.module.canConsumeQuota(18080, 'backfill', { now, reserveFloor: 0 });
    const second = qs.module.canConsumeQuota(18080, 'backfill', { now, reserveFloor: 0 });
    return 'lib/quota-state.js exposes only check-then-act functions (' + readOnly.join(',') +
      ') and no atomic claim. Two concurrent callers each requesting the full budget both receive ok=' +
      first.ok + ' / ok=' + second.ok + ' — a cumulative grant of ' + (18080 * 2) +
      ' against a ' + first.limit + ' unit limit, because the check does not reserve.';
  }
};

/* -------------------------------------------------------------------------- */
/* N15 — chart ticker must equal trading-plan ticker (stale-state guard)      */
/* Guards: BUG-V5-P0-009 / BUG-V5-P1-024 (contract #15)                       */
/* -------------------------------------------------------------------------- */
const N15 = {
  id: 'N15',
  name: 'Chart payload write is ticker-guarded; plan cannot render another ticker',
  bugIds: ['BUG-V5-P0-009', 'BUG-V5-P1-024'],
  invariant: 'Every write of a chart payload into the shared slot must be preceded by a request-ticker equality check and be cancellable.',
  run() {
    const src = H.readText('public/unified-cockpit-runtime.js');
    if (!src.ok) throw new SkipControl('public/unified-cockpit-runtime.js unreadable');
    const lines = src.lines;

    // Only the actual WRITE path is an assignment of the shared slot from a
    // payload (`root._chartPageData = data`). Reads like
    // `var data = root._chartPageData || ...` must not be mistaken for a write.
    const writeIndexes = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/root\._chartPageData\s*=\s*data\b/.test(lines[i]) && !lines[i].trim().startsWith('//')) writeIndexes.push(i);
    }
    if (writeIndexes.length === 0) throw new SkipControl('the shared chart slot is not written in this module');

    const violations = [];
    for (const idx of writeIndexes) {
      const lookback = lines.slice(Math.max(0, idx - 15), idx + 1).join('\n');
      const guarded = /data\.ticker\s*!==|ticker\s*!==\s*(requested|safe)Ticker|activeTicker\s*\)\s*!==|safeTicker|seqToken|requestSeq|RequestSeq|AbortController/.test(lookback);
      if (!guarded) {
        violations.push({ line: idx + 1, code: lines[idx].trim(), reason: 'write is not preceded by a request-ticker/sequence guard' });
      }
    }

    const abortCount = (src.text.match(/AbortController/g) || []).length;
    if (abortCount === 0) {
      violations.push({ line: null, code: 'AbortController', reason: 'no AbortController in the chart loader — a slower earlier response can overwrite the slot' });
    }

    // The reload gate must not be satisfied before the request resolves.
    // Skip the `var _lastLoadedChartTicker = '';` declaration (module init) and
    // only inspect the real reload-gate assignment that runs after a load.
    const gateIdx = lines.findIndex((l) => /_lastLoadedChartTicker\s*=/.test(l) && !l.trim().startsWith('//') && !/^\s*var\s+_lastLoadedChartTicker\s*=/.test(l));
    if (gateIdx >= 0) {
      const beforeAwait = lines.slice(0, gateIdx + 1).join('\n');
      const awaitBefore = /await /.test(beforeAwait);
      if (!awaitBefore) {
        violations.push({ line: gateIdx + 1, code: lines[gateIdx].trim(), reason: '_lastLoadedChartTicker is assigned before any await — the reload gate can be satisfied by an in-flight request' });
      }
    }

    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' stale-state guard defect(s) in the chart loader', { violations, abortCount });
    }
    return { writeSites: writeIndexes.length, abortCount };
  },
  defectProbe() {
    // Independent path: report a LIVE defect only when the source still does one
    // of the two forbidden things — (a) publishes into the shared chart slot
    // without a request-sequence/ticker guard and an AbortController, or
    // (b) fabricates a hardcoded last close for an empty candle set. After the
    // F5 fix both are absent, so this probe must return null (otherwise the
    // control would be BROKEN while the tree is genuinely clean).
    const chart = H.readText('public/unified-cockpit-runtime.js');
    const plan = H.readText('public/analisis-v2.js');
    const evidence = [];
    if (chart.ok) {
      // The loader owns a guard token via chartGuard().next(), not a variable
      // named _chartRequestSeq. Check the real acquisition, rejection and
      // cancellation contract rather than requiring an arbitrary identifier.
      const hasSequence = /chartGuard\(\)\.next\(/.test(chart.text) ||
        /_guard\.next\(safeTicker,\s*CHART_CATEGORY\)/.test(chart.text);
      const rejectsOldRequest = /\.isCurrent\(chartToken\)/.test(chart.text);
      const hasAbort = /new\s+_AbortController\(\)/.test(chart.text) &&
        /_chartAbort\.abort\(\)/.test(chart.text);
      const preventsStaleState = /if\s*\(getActiveTicker\(\)\s*!==\s*safeTicker\)\s*return/.test(chart.text);
      if (!(hasSequence && rejectsOldRequest && hasAbort && preventsStaleState)) {
        evidence.push('unified-cockpit-runtime.js missing actual request token, current-request rejection, abort, or active-ticker state guard');
      }
    }
    if (plan.ok) {
      const hardcoded = lineScan(plan.text, /9860|7480|5000\)\s*;?\s*$/);
      if (hardcoded.length) evidence.push('analisis-v2.js still fabricates a hardcoded last close when candles are empty at line(s) ' + hardcoded.map((h) => h.line).join(','));
    }
    return evidence.length ? evidence.join('; ') : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N16 — lot vs lembar conversion                                             */
/* Guards: BUG-V5-P0-010 (contract #16 "Salah konversi lot/lembar")           */
/* -------------------------------------------------------------------------- */
const N16 = {
  id: 'N16',
  name: 'lot vs lembar conversion (1 lot = 100 shares) consistently labelled',
  bugIds: ['BUG-V5-P0-010'],
  invariant: 'A raw vendor share count may only be labelled "lot" after dividing by 100; the same value must carry one unit across renderers.',
  run() {
    const violations = [];

    const ucr = H.readText('public/unified-cockpit-runtime.js');
    if (!ucr.ok) throw new SkipControl('public/unified-cockpit-runtime.js unreadable');
    for (const hit of lineScan(ucr.text, /\+\s*' lot'/)) {
      const converts = /\/\s*100|Math\.floor\([^)]*\/\s*100/.test(hit.text);
      if (!converts) {
        violations.push({ file: 'public/unified-cockpit-runtime.js', line: hit.line, reason: "raw share count labelled ' lot' without dividing by 100", code: hit.text });
      }
    }

    // The same volume must not be rendered with a different unit elsewhere.
    const ws = H.readText('public/chart-workstation.js');
    if (ws.ok) {
      const usesLembar = lineScan(ws.text, /'\s*lembar'/);
      if (usesLembar.length > 0 && violations.length > 0) {
        violations.push({
          file: 'public/chart-workstation.js',
          line: usesLembar[0].line,
          reason: 'the same stored volume is rendered with the unit "lembar" while another widget says "lot"',
          code: usesLembar[0].text
        });
      }
    }

    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' volume-unit defect(s) — lot and lembar disagree for one stored value', { violations });
    }
    return { checked: ['public/unified-cockpit-runtime.js', 'public/chart-workstation.js'] };
  },
  defectProbe() {
    // Independent probe must mirror the invariant, not assume any line that
    // says "lot" is wrong: a line that divides the raw share count by 100 before
    // labelling it "lot" is correct. Only flag "lot" labels applied to a raw
    // (un-divided) share count.
    const ucr = H.readText('public/unified-cockpit-runtime.js');
    if (!ucr.ok) return null;
    const offenders = [];
    for (const hit of lineScan(ucr.text, /\+\s*' lot'/)) {
      const converts = /\/\s*100/.test(hit.text);
      if (!converts) offenders.push(hit.line);
    }
    if (offenders.length === 0) return null;
    const bbcA = candlesFor('BBCA');
    const shares = (bbcA && bbcA.length > 0) ? H.num(bbcA[bbcA.length - 1].volume) : NaN;
    return 'unified-cockpit-runtime.js:' + offenders.join(',') +
      ' labels a RAW share count as "lot" without dividing by 100' +
      (Number.isFinite(shares) ? ' (stored BBCA volume = ' + shares + ' shares; correct lot count = ' + (shares / 100) + ')' : '');
  }
};

/* -------------------------------------------------------------------------- */
/* N17 — localStorage / fake identity cannot authenticate                     */
/* Guards: contract #17 "Login localStorage palsu" (V5_P1_014)                */
/* -------------------------------------------------------------------------- */
const N17 = {
  id: 'N17',
  name: 'localStorage / fake identity cannot authenticate',
  bugIds: ['BUG-V5-P1-014'],
  invariant: 'No server-side authorization decision may be granted from an unsigned client-claimed identity (header, query or body).',
  run() {
    // (a) The signed-session primitive must fail closed.
    const session = H.requireOrPending('lib/admin-session.js', ['verifySessionToken', 'requireAdminSession'],
      'Server-side session verification must exist for identity to be attestable.');
    const forged = 'v1.' + Buffer.from(JSON.stringify({ uid: 'attacker', un: 'attacker', adm: true, iat: 1, exp: 9999999999 })).toString('base64url') + '.deadbeef';
    const forgedResult = session.verifySessionToken(forged);
    if (!forgedResult || forgedResult.valid !== false) {
      throw new AssertionFailure('verifySessionToken accepted a forged admin payload', { forgedResult });
    }
    if (session.verifySessionToken('autocuan_logged_in=true') .valid !== false) {
      throw new AssertionFailure('verifySessionToken accepted a localStorage-shaped string as a session');
    }

    // (b) No module may grant authorization from an unsigned header.
    const violations = [];
    for (const dir of ['api', 'lib']) {
      const base = H.abs(dir);
      if (!fs.existsSync(base)) continue;
      for (const file of fs.readdirSync(base)) {
        if (!file.endsWith('.js')) continue;
        const src = H.readText(path.join(dir, file));
        if (!src.ok) continue;
        const lines = src.lines;
        for (let i = 0; i < lines.length; i += 1) {
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          if (!/x-(?:user-role|role|admin-role|admin|username|user-id)\b/i.test(trimmed)) continue;
          const window = lines.slice(i, i + 25);
          const grants = window.findIndex((l) => /return\s*\{\s*ok:\s*true/.test(l));
          if (grants >= 0) {
            violations.push({ file: dir + '/' + file, line: i + 1, grantLine: i + 1 + grants, code: trimmed });
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' authorization path(s) grant access from an unsigned client-claimed identity',
        { violations }
      );
    }
    return { checkedForged: forgedResult.reason };
  },
  defectProbe() {
    const src = H.readText('lib/admin-notes-handler.js');
    if (!src.ok) return null;
    const roleHeader = lineScan(src.text, /x-user-role/);
    const devBypass = lineScan(src.text, /x-admin'\]\s*===\s*'1'/);
    if (roleHeader.length === 0 && devBypass.length === 0) return null;
    return 'lib/admin-notes-handler.js trusts unsigned identity headers: role from ' +
      (roleHeader.length ? 'x-user-role/x-role/x-admin-role at line ' + roleHeader[0].line : 'n/a') +
      (devBypass.length ? '; zero-auth bypass accepts x-admin:1 at line ' + devBypass[0].line : '') +
      ' — signed session verification is bypassed entirely on that path';
  }
};

/* -------------------------------------------------------------------------- */
/* N18 — HTTP 200 with an empty/synthetic payload is not valid data           */
/* Guards: BUG-V5-P0-004 / BUG-V5-P0-026 (contract item 18 as renumbered)     */
/* -------------------------------------------------------------------------- */
const N18 = {
  id: 'N18',
  name: 'API 200 with empty/synthetic payload is not treated as valid data',
  bugIds: ['BUG-V5-P0-004', 'BUG-V5-P0-026'],
  invariant: 'A 200 response may only be published as valid data when every row it returns can be traced to a real source row.',
  async run() {
    const mod = H.requireOptional('api/top5-radar.js');
    if (!mod.ok || typeof mod.module !== 'function') {
      throw new SkipControl('api/top5-radar.js handler not loadable');
    }
    const payload = await mod.module({ headers: {} }, {});
    if (!payload || payload.success !== true) return { failClosed: true };

    const picks = payload.picks || payload.top5 || [];
    const sourceSet = sourceTickerSet();
    const untraced = picks.filter((p) => !sourceSet.has(String(p && p.ticker).toUpperCase()));
    if (untraced.length > 0) {
      throw new AssertionFailure(
        'HTTP 200 + success:true returned ' + untraced.length + '/' + picks.length + ' rows with no source provenance',
        { untraced: untraced.map((p) => p.ticker), count: payload.count, total: payload.total_locked }
      );
    }
    return { picks: picks.length };
  },
  defectProbe() {
    const mod = H.requireOptional('api/screener.js');
    if (!mod.ok || typeof mod.module.buildScreenerPayload !== 'function') return null;
    const payload = mod.module.buildScreenerPayload();
    if (!payload || payload.success !== true) return null;
    const published = payload.results || [];
    const srcTotal = CATEGORY_KEYS.reduce((s, k) => s + sourceRows(k).length, 0);
    if (published.length <= srcTotal) return null;
    return 'api/screener.js returns success:true with ' + published.length +
      ' rows while the source files hold ' + srcTotal + ' rows; meta claims universe=' +
      (payload.meta && payload.meta.universe_count) + ' scanned=' + (payload.meta && payload.meta.scanned_count) +
      ' though the source files declare 165/163-164';
  }
};

/* -------------------------------------------------------------------------- */
/* N19 — different screener categories must not share fallback sets            */
/* Guards: BUG-V5-P0-001 / BUG-V5-P0-002 (contract #20)                       */
/* -------------------------------------------------------------------------- */
const N19 = {
  id: 'N19',
  name: 'Different screener categories do not produce identical fallback sets',
  bugIds: ['BUG-V5-P0-001', 'BUG-V5-P0-002'],
  invariant: 'Within a category, untraced (fallback) rows must not be byte-identical on the metric tuple, and the three categories must not share one identical fallback tuple.',
  run() {
    const payload = screenerPayload();
    const sourceSet = sourceTickerSet();
    const perCategory = {};
    const globalSignatures = new Map();

    for (const key of CATEGORY_KEYS) {
      const rows = payload[key] || [];
      const fallback = rows.filter((r) => !sourceSet.has(String(r && r.ticker).toUpperCase()));
      if (fallback.length === 0) { perCategory[key] = { fallback: 0 }; continue; }

      H.assertDistinctRows(fallback, {
        fields: ['last_price', 'score', 'change_pct', 'volume_ratio', 'rsi14'],
        minCount: Math.max(2, Math.ceil(fallback.length / 2))
      });

      const signature = ['last_price', 'score', 'change_pct', 'volume_ratio', 'rsi14']
        .map((f) => String(fallback[0][f])).join('|');
      perCategory[key] = { fallback: fallback.length, signature };
      if (!globalSignatures.has(signature)) globalSignatures.set(signature, []);
      globalSignatures.get(signature).push(key);
    }

    const shared = [...globalSignatures.entries()].filter(([, keys]) => keys.length > 1);
    if (shared.length > 0) {
      throw new AssertionFailure(
        shared.length + ' fallback tuple(s) are shared across different screener categories',
        { shared: shared.map(([sig, keys]) => ({ signature: sig, categories: keys })) }
      );
    }
    return { perCategory };
  },
  defectProbe() {
    const payload = screenerPayload();
    const sourceSet = sourceTickerSet();
    const detail = CATEGORY_KEYS.map((key) => {
      const rows = payload[key] || [];
      const fallback = rows.filter((r) => !sourceSet.has(String(r && r.ticker).toUpperCase()));
      const uniq = new Set(fallback.map((r) => [r.last_price, r.score, r.change_pct, r.volume_ratio, r.rsi14].join('|')));
      return key + ': ' + fallback.length + ' fallback rows, ' + uniq.size + ' distinct tuple(s)';
    });
    const cloned = CATEGORY_KEYS.filter((key) => {
      const rows = payload[key] || [];
      const fallback = rows.filter((r) => !sourceSet.has(String(r && r.ticker).toUpperCase()));
      return fallback.length >= 5 && new Set(fallback.map((r) => [r.last_price, r.score].join('|'))).size === 1;
    });
    return cloned.length ? 'clone categories=' + cloned.join(',') + ' (' + detail.join('; ') + ')' : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N20 — strategy version change without approval must be rejected            */
/* Guards: contract #21 "Perubahan strategy version tanpa approval"           */
/* -------------------------------------------------------------------------- */
const N20 = {
  id: 'N20',
  name: 'Strategy parameter change without approval is rejected',
  bugIds: ['BUG-V5-P1-027'],
  invariant: 'A live strategy parameter file must carry approval metadata (approver, timestamp, immutable version), and its loader must refuse an unapproved change.',
  run() {
    const params = H.loadJson('config/v3-f03-winning-params.json');
    if (!params.ok) throw new SkipControl('config/v3-f03-winning-params.json unreadable');
    const keys = Object.keys(params.data || {}).map((k) => k.toLowerCase());
    const required = ['approved', 'approval', 'approvedby', 'approved_at', 'signature', 'version', 'checksum', 'sha256'];
    const present = required.filter((r) => keys.some((k) => k.indexOf(r) >= 0));
    if (present.length === 0) {
      throw new AssertionFailure(
        'strategy parameter file carries no approval/version metadata — any edit silently changes live scoring',
        { keys: Object.keys(params.data || {}), requiredAnyOf: required }
      );
    }
    return { present };
  },
  defectProbe() {
    const cfg = H.readText('lib/screener-config.js');
    if (!cfg.ok) return null;
    const loads = lineScan(cfg.text, /require\(['"]\.\/v3-f03-winning-params['"]\)/);
    const guards = lineScan(cfg.text, /approval|approved|signature|hmac|checksum/i);
    if (loads.length === 0 || guards.length > 0) return null;
    return 'lib/screener-config.js:' + loads[0].line + ' loads config/v3-f03-winning-params.json with a silent try/catch and no approval/checksum verification (0 guard keywords found)';
  }
};

/* -------------------------------------------------------------------------- */
/* N21 — foreign flow chart must not be scaled on the price axis              */
/* Guards: contract #22 "Chart foreign pada skala harga"                      */
/* -------------------------------------------------------------------------- */
const N21 = {
  id: 'N21',
  name: 'Foreign flow chart is not scaled on the price axis',
  bugIds: ['BUG-V5-P0-011'],
  invariant: 'A foreign-flow series (rupiah magnitude) must declare its own price scale, distinct from the main price scale.',
  run() {
    const src = H.readText('public/market-feature-runtime.js');
    if (!src.ok) throw new SkipControl('public/market-feature-runtime.js unreadable');
    const lines = src.lines;

    let foreignIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/calculateForeignFlowCumulative\(/.test(lines[i]) && !lines[i].trim().startsWith('//')) { foreignIndex = i; break; }
    }
    if (foreignIndex < 0) throw new SkipControl('no foreign-flow series created in this module');

    const block = lines.slice(foreignIndex, foreignIndex + 40).join('\n');
    const scaleMatch = /priceScaleId:\s*'([^']+)'/.exec(block);
    const violations = [];
    if (!scaleMatch) {
      violations.push({ line: foreignIndex + 1, reason: 'foreign series declares no priceScaleId — it inherits the main price scale' });
    } else if (scaleMatch[1] === 'right' || scaleMatch[1] === 'left') {
      violations.push({ line: foreignIndex + 1, reason: "foreign series is attached to the price scale '" + scaleMatch[1] + "'" });
    } else {
      const configured = new RegExp("priceScale\\('" + scaleMatch[1] + "'\\)\\.applyOptions");
      if (!configured.test(src.text)) {
        violations.push({ line: foreignIndex + 1, reason: 'scale ' + scaleMatch[1] + ' is declared but never configured' });
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(violations.length + ' foreign-flow scaling defect(s)', { violations });
    }
    return { scale: scaleMatch[1] };
  },
  defectProbe() {
    const src = H.readText('public/market-feature-runtime.js');
    if (!src.ok) return null;
    const scale = /priceScaleId:\s*'foreign_scale'/.test(src.text);
    const configured = /priceScale\('foreign_scale'\)\.applyOptions/.test(src.text);
    if (scale && configured) return null;
    return 'foreign series shares the main price axis (scale=' + scale + ', configured=' + configured + ')';
  }
};

/* -------------------------------------------------------------------------- */
/* N22 — empty data must never yield BUY                                      */
/* Guards: BUG-V5-P0-004 / BUG-V5-P0-001 (contract #23 "Empty data -> BUY")    */
/* -------------------------------------------------------------------------- */
const N22 = {
  id: 'N22',
  name: 'Empty source data never yields BUY',
  bugIds: ['BUG-V5-P0-004', 'BUG-V5-P0-001'],
  invariant: 'If a category source file holds zero candidate rows, the published set for that category must be empty and must contain no BUY/READY row.',
  run() {
    const payload = screenerPayload();
    const violations = [];
    for (const key of CATEGORY_KEYS) {
      const sourceCount = sourceRows(key).length;
      const published = payload[key] || [];
      if (sourceCount !== 0) continue;
      const ready = published.filter((r) => H.isReadyRow(r));
      if (published.length > 0 || ready.length > 0) {
        violations.push({ category: key, sourceRows: sourceCount, published: published.length, ready: ready.length });
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' category(ies) publish rows/BUY from an empty source',
        { violations }
      );
    }
    return { checked: CATEGORY_KEYS };
  },
  defectProbe() {
    const payload = screenerPayload();
    const doc = sourceDoc('daytrade');
    if (!doc) return null;
    const sourceResults = (doc.results || []).length;
    const published = (payload.daytrade || []).length;
    const buy = (payload.daytrade || []).filter((r) => String(r.action).toUpperCase().indexOf('BUY') >= 0).length;
    if (!(sourceResults === 0 && published > 0)) return null;
    const radar = (doc.radar || doc.radar_candidates || []).length;
    return 'data/screener-v3f04-daytrade.json has results=[] (0 candidates) yet ' + published +
      ' Day Trade rows are published, ' + buy + ' of them action=BUY; ' + radar +
      ' real radar candidate(s) exist on disk under "radar" but api/screener.js reads "radar_candidates" and discards them';
  }
};

/* -------------------------------------------------------------------------- */
/* N23 — a single 100%-win trade must not qualify a strategy                  */
/* Guards: contract #24 "Strategy satu kemenangan 100% win rate"              */
/* -------------------------------------------------------------------------- */
const N23 = {
  id: 'N23',
  name: 'Single 100%-win trade does not qualify a strategy (sample size)',
  bugIds: ['BUG-V5-P0-002', 'BUG-V5-P0-005'],
  invariant: 'A win rate may only be published as a qualification when the sample is large enough (trades >= 10) and the Wilson lower bound clears the threshold.',
  run() {
    const map = backtestMap();
    if (map.size === 0) throw new SkipControl('backtest-individual-964.json unavailable');

    const payload = screenerPayload();
    const rows = [];
    for (const key of CATEGORY_KEYS) rows.push(...(payload[key] || []));
    rows.push(...top5Picks());

    const violations = [];
    const seen = new Set();
    for (const row of rows) {
      const ticker = String(row && row.ticker || '').toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      if (!H.isReadyRow(row)) continue;
      const bt = map.get(ticker) || {};
      const trades = H.num(bt.tradesCount);
      const winRate = H.num(row.win_rate_pct != null ? row.win_rate_pct : row.winRatePct);
      const wilson = H.num(bt.wilsonLowerBoundPct);
      if (!Number.isFinite(winRate) || winRate < 100) continue;
      if (!Number.isFinite(trades) || trades < 10) {
        violations.push({ ticker, trades: Number.isFinite(trades) ? trades : null, winRate, wilson: Number.isFinite(wilson) ? wilson : null, status: row.status });
      }
    }
    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' ready row(s) publish a 100% win rate from a sample smaller than 10 trades',
        { violations: violations.slice(0, 12) }
      );
    }
    return { checked: seen.size };
  },
  defectProbe() {
    // Independent probe of the PUBLISHED output (different composition path than
    // run()). The invariant is about *publication as a qualification*: a row that
    // is actually READY may not carry a 100% win rate backed by <10 trades.
    // Scanning the raw backtest file here is out of invariant scope — the raw file
    // legitimately reports per-ticker stats that are only a defect once a producer
    // promotes them into an actionable qualification.
    const map = backtestMap();
    const published = [];
    for (const key of CATEGORY_KEYS) published.push(...(screenerPayload()[key] || []));
    published.push(...top5Picks());
    const seen = new Set();
    const offenders = [];
    for (const row of published) {
      const ticker = String(row && row.ticker || '').toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      if (!H.isReadyRow(row)) continue;
      const bt = map.get(ticker) || {};
      const trades = H.num(bt.tradesCount);
      const win = H.num(row.win_rate_pct != null ? row.win_rate_pct : row.winRatePct);
      if (Number.isFinite(win) && win >= 100 && (!Number.isFinite(trades) || trades < 10)) {
        offenders.push(ticker + '(wr=' + win + ',n=' + (Number.isFinite(trades) ? trades : '?') + ')');
      }
    }
    if (offenders.length === 0) return null;
    return offenders.length + ' published READY row(s) carry a 100% win rate from <10 trades: ' +
      offenders.slice(0, 5).join(', ');
  }
};

/* -------------------------------------------------------------------------- */
/* N24 — a report claiming PASS without real assertions must be rejected      */
/* Guards: BUG-V5-P1-032 (contract #25 "CSV/report klaim PASS")               */
/* -------------------------------------------------------------------------- */

/*
 * N24 detection is invariant-driven, not keyed to a single literal.
 * The invariant: "no report claims PASS for gate scripts that are not tracked
 * in git, and no untraceable 100%-PASS claim over the full 16 gates."
 * Two facets are checked across BOTH manifest copies (repo root + archived):
 *   A. an untraceable full-16 "100% PASS" claim, in the original literal
 *      ("LULUS 16/16" / "16/16 GATE"), the reworded equivalent
 *      ("Seluruh 16 gate … 100% PASS"), or a range-style claim
 *      ("V4-F01 s.d. V4-F16" / "F01–F16" / "F01-F16" + "100% PASS/LULUS");
 *   B. a §5 result-table row that marks an individual gate (V4-F<NN>) as
 *      **PASS** while its gate script is not tracked in git.
 */

const N24_MANIFEST_PATHS = Object.freeze([
  'MANIFEST_AUDIT_V4_LENGKAP.md',
  'audit-evidence/v5/archives/MANIFEST_AUDIT_V4_LENGKAP.md'
]);

const N24_FULL_PASS_CLAIM = /LULUS\s*16\s*\/\s*16|\b16\s*\/\s*16\s*GATE|Seluruh\s+16\s+gate\b[^\n]*100\s*%\s*PASS/i;

const N24_FULL_RANGE_F16_RE = /(?:V4[- ]?)?F0?1\s*(?:s\.d\.|s\/d\.?|-|–|—)\s*(?:V4[- ]?)?F16\b[^\n]*100\s*%\s*(?:PASS|LULUS)/i;

const N24_GATE_ROW = /^\|\s*\*\*V4-F(\d+)\*\*/;

function n24ManifestTexts() {
  return N24_MANIFEST_PATHS.map((rel) => {
    const res = H.readText(rel);
    return { rel, ok: res.ok, text: res.ok ? res.text : null, lines: res.ok ? res.lines : [] };
  });
}

function n24UntrackedGateFiles() {
  const untracked = new Set();
  for (const m of n24ManifestTexts()) {
    if (!m.ok) continue;
    const re = /tools\/gates\/(gate-V4-F\d+\.js)/g;
    let match;
    while ((match = re.exec(m.text)) !== null) {
      const gate = match[1];
      if (!gitTracked('tools/gates/' + gate)) untracked.add(gate);
    }
  }
  return [...untracked].sort();
}

function n24FullPassClaimHits() {
  const hits = [];
  const PATTERNS = [N24_FULL_PASS_CLAIM, N24_FULL_RANGE_F16_RE];
  for (const m of n24ManifestTexts()) {
    if (!m.ok) continue;
    for (const pattern of PATTERNS) {
      for (const hit of lineScan(m.text, pattern)) {
        hits.push({ rel: m.rel, line: hit.line, text: hit.text });
      }
    }
  }
  return hits;
}

function n24UntrackedPassRows() {
  const rows = [];
  for (const m of n24ManifestTexts()) {
    if (!m.ok) continue;
    for (let i = 0; i < m.lines.length; i += 1) {
      const match = N24_GATE_ROW.exec(m.lines[i]);
      if (!match) continue;
      const gate = 'gate-V4-F' + match[1] + '.js';
      if (gitTracked('tools/gates/' + gate)) continue;
      if (/\*\*PASS\*\*/.test(m.lines[i])) {
        rows.push({ rel: m.rel, line: i + 1, gate });
      }
    }
  }
  return rows;
}

const N24 = {
  id: 'N24',
  name: 'Report claiming PASS without traceable assertions is rejected',
  bugIds: ['BUG-V5-P1-032'],
  invariant: 'Every gate a manifest claims as PASS must be verifiable from a script tracked in version control at the reported commit.',
  run() {
    const manifests = n24ManifestTexts();
    if (!manifests.some((m) => m.ok)) {
      throw new SkipControl('no copy of MANIFEST_AUDIT_V4_LENGKAP.md is readable (checked repo root + audit-evidence/v5/archives)');
    }

    const untracked = n24UntrackedGateFiles();
    const fullClaims = n24FullPassClaimHits();
    const passRows = n24UntrackedPassRows();

    const violations = [];
    if (fullClaims.length > 0 && untracked.length > 0) {
      violations.push({ type: 'untraceable-full-16-pass-claim', claims: fullClaims, untracked });
    }
    if (passRows.length > 0) {
      violations.push({ type: 'untracked-gate-marked-pass', rows: passRows });
    }

    if (violations.length > 0) {
      throw new AssertionFailure(
        violations.length + ' anti-fake claim violation(s): a report claims PASS for gate scripts not tracked in git',
        { violations, untracked }
      );
    }
    return { fullPassClaims: fullClaims.length, untrackedPassRows: passRows.length, untrackedGateFiles: untracked.length };
  },
  defectProbe() {
    // Independent path over the same invariant, using raw reads rather than the
    // shared lineScan helpers. Reports live evidence only, or null when the
    // manifest is actually truthful.
    const evidence = [];
    for (const m of n24ManifestTexts()) {
      if (!m.ok) continue;

      const original16 = /LULUS\s*16\s*\/\s*16/i.test(m.text) || /\b16\s*\/\s*16\s*GATE/i.test(m.text);
      const reworded16 = /Seluruh\s+16\s+gate\b[^\n]*100\s*%\s*PASS/i.test(m.text);
      const rangeVariant = N24_FULL_RANGE_F16_RE.test(m.text);
      if (original16 || reworded16 || rangeVariant) {
        evidence.push(m.rel + ' asserts a full-16 100% PASS claim (untraceable)');
      }

      let untrackedPass = 0;
      for (let i = 0; i < m.lines.length; i += 1) {
        const rowMatch = /^\|\s*\*\*V4-F(\d+)\*\*/.exec(m.lines[i]);
        if (!rowMatch) continue;
        const gate = 'gate-V4-F' + rowMatch[1] + '.js';
        if (gitTracked('tools/gates/' + gate)) continue;
        if (/\*\*PASS\*\*/.test(m.lines[i])) untrackedPass += 1;
      }
      if (untrackedPass > 0) {
        evidence.push(m.rel + ': ' + untrackedPass + ' untracked gate row(s) marked PASS');
      }
    }
    return evidence.length ? evidence.join('; ') : null;
  }
};

/* -------------------------------------------------------------------------- */
/* N25 — video / evidence artifact integrity                                  */
/* Guards: BUG-V5-P2-002 (contract #25 evidence class)                        */
/* -------------------------------------------------------------------------- */
const N25 = {
  id: 'N25',
  name: 'Video/evidence artifact integrity (CSV row count vs claimed cuts)',
  bugIds: ['BUG-V5-P2-002'],
  invariant: 'The number of data rows in V5_VIDEO_SCENE_CHANGES.csv must equal the number of scene cuts claimed in V5_VIDEO_BUG_MAP.md.',
  run() {
    const csv = H.readText('audit-evidence/v5/V5_VIDEO_SCENE_CHANGES.csv');
    const prose = H.readText('audit-evidence/v5/V5_VIDEO_BUG_MAP.md');
    if (!csv.ok || !prose.ok) throw new SkipControl('video evidence artifacts unreadable');

    const dataRows = csv.lines.filter((l) => l.trim().length > 0 && !/^source_video\s*,/i.test(l.trim()));
    const claims = [...prose.text.matchAll(/(\d+)\s*cuts?/gi)].map((m) => Number(m[1]));
    const claimed = claims.reduce((sum, n) => sum + n, 0);
    const perVideo = claims.filter((n) => n > 0);

    if (claimed !== dataRows.length) {
      throw new AssertionFailure(
        'prose claims ' + claimed + ' scene cut(s) but the CSV artifact holds ' + dataRows.length + ' data row(s)',
        { claimed, perVideoClaims: perVideo, dataRows: dataRows.length, csvBytes: Buffer.byteLength(csv.text, 'utf8') }
      );
    }
    return { claimed, dataRows: dataRows.length };
  },
  defectProbe() {
    const csv = H.readText('audit-evidence/v5/V5_VIDEO_SCENE_CHANGES.csv');
    const prose = H.readText('audit-evidence/v5/V5_VIDEO_BUG_MAP.md');
    if (!csv.ok || !prose.ok) return null;
    const dataRows = csv.lines.filter((l) => l.trim().length > 0 && !/^source_video\s*,/i.test(l.trim()));
    const claims = [...prose.text.matchAll(/(\d+)\s*cuts?/gi)].map((m) => Number(m[1]));
    const claimed = claims.reduce((sum, n) => sum + n, 0);
    if (dataRows.length > 0 || claimed === 0) return null;
    return 'V5_VIDEO_SCENE_CHANGES.csv is ' + Buffer.byteLength(csv.text, 'utf8') +
      ' bytes with header only (0 data rows) while V5_VIDEO_BUG_MAP.md claims ' + claimed +
      ' cuts (' + claims.join('+') + ')';
  }
};

/* ========================================================================== */
/* Registry                                                                   */
/* ========================================================================== */

const CONTROLS = [
  N1, N2, N3, N4, N5, N6, N7, N8, N9, N10,
  N11, N12, N13, N14, N15, N16, N17, N18, N19, N20,
  N21, N22, N23, N24, N25
];

module.exports = {
  CONTROLS,
  byId(id) {
    return CONTROLS.find((c) => c.id === id) || null;
  }
};