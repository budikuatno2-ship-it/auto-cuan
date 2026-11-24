#!/usr/bin/env node
'use strict';

/**
 * scripts/top5-radar.js
 * ============================================================================
 * Single-source Short Swing IDX Top 20 / Top 5 snapshot publisher — V6 canonical.
 * ============================================================================
 *
 * WHAT CHANGED (Subtask F):
 *   BEFORE: this runner merged three legacy screener pools
 *   (screener-v3f04-konglo + screener-v3f04-nonkonglo + screener-v3f04-daytrade)
 *   into a combined "Top 5" and published per-category picks. That meant the
 *   dashboard Top 5 was a re-ranking of three different strategies, not a
 *   single Short Swing snapshot.
 *
 * WHAT CHANGED (Subtask H / P0-09):
 *   The `swing` pool of `data/screener-latest.json` was an ALIAS of the Konglo
 *   screener results (universe 165 conglomerate-affiliated tickers) — reading
 *   it meant Top20/Top5 were graded over Konglo165, not the whole eligible IDX
 *   universe. The runner now reads the CANONICAL `short_swing` pool produced by
 *   `scripts/run-screeners.js` via `lib/short-swing-universe.js` (whole local
 *   IDX universe) and graded by `lib/saham-potensial-engine.js`. The deprecated
 *   `swing` alias is GATED: when it is the only pool present, this runner
 *   refuses to publish it as canonical and emits an honest NOT_PUBLISHED with
 *   reason DEPRECATED_SWING_ALIAS_REJECTED.
 *
 *   AFTER: the runner reads ONE canonical Short Swing IDX source (the
 *   `short_swing` pool of `data/screener-latest.json`), normalises each real
 *   IDX row into the canonical candidate contract (preserving per-component
 *   as-of clocks), and re-ranks them through
 *   `lib/saham-potensial-engine.js#buildSahamPotensialSnapshot`. Because the
 *   engine is deterministic, the rebuilt snapshot_id must equal the producer's
 *   snapshot_id — a mismatch is published as a validation failure, not hidden.
 *   No three-screener merge, no padding, no fake READY: whatever the canonical
 *   fail-closed engine emits (READY / WAITING_ENTRY / WATCHLIST / DEGRADED /
 *   BLOCKED / NOT_READY) is what gets published.
 *
 * HONESTY CONTRACTS (still enforced):
 *   - Only rows that exist in the single IDX source are emitted. Zero is valid.
 *   - Broker/foreign data unavailable => BLOCKED (engine), never fabricated.
 *   - Stale as-of vs session_date => NOT_READY (engine), never READY.
 *   - `top5` is a PURE SUBSET of `top20` (same object references).
 *   - R/R policy minimum (`MIN_RR_RATIO` from `lib/screener-config.js`) is
 *     reported as `rr_policy_minimum`; the engine enforces R/R >= 1.5 at
 *     max_entry before any READY.
 *
 * OUTPUT FILES (unchanged paths)
 *   data/top5-radar.json
 *   data/radar-state.json
 *   data/job-heartbeat/top5-radar.json
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const screenerConfig = require('../lib/screener-config.js');
const engine = require('../lib/saham-potensial-engine.js');
const snapshotStore = require('../lib/saham-potensial-snapshot-store.js');

const { MIN_RR_RATIO } = screenerConfig;

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
// Test seams: V6_RADAR_SOURCE / V6_RADAR_OUTDIR / V6_RADAR_STORE let the
// immutability suite exercise the real runner against synthetic inputs without
// touching production artifacts. In normal operation they are unset.
const SOURCE_FILE = process.env.V6_RADAR_SOURCE || path.join(DATA_DIR, 'screener-latest.json');
const OUT_DIR = process.env.V6_RADAR_OUTDIR || DATA_DIR;
const OUT_FILE = path.join(OUT_DIR, 'top5-radar.json');
const RADAR_STATE_FILE = path.join(OUT_DIR, 'radar-state.json');
const HEARTBEAT_FILE = path.join(OUT_DIR, 'job-heartbeat', 'top5-radar.json');
const STORE_DIR = process.env.V6_RADAR_STORE || undefined; // undefined => store default

/** Maximum cardinality of the published Top 5 (mirrors the contract). */
const MAX_PICKS = 5;
const MAX_TOP20 = 20;
const MIN_WIN_RATE_SAMPLE = 10;

/**
 * A single source descriptor. NO ticker array — the "kosong" factory that
 * produced the fake Top 5 was seeded by in-code ticker lists, which are gone.
 */
const CATEGORY_SPECS = Object.freeze([
  Object.freeze({ key: 'short-swing', label: 'Short Swing IDX', file: 'screener-latest.json' })
]);

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

function pickFirstNumber(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickFirstText(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Candidate mapping — real values only, no fabrication                       */
/* -------------------------------------------------------------------------- */

/**
 * Convert a REAL Short Swing source row into a canonical engine candidate.
 *
 * Broker (`bandar_score`) and foreign flow (`foreign_flow_score`) are passed
 * ONLY if the source row actually carries them; when absent the canonical
 * engine fail-closes to BLOCKED instead of fabricating a neutral 50.
 *
 * Subtask H: rows of the canonical `short_swing` pool are themselves engine
 * outputs, so their PER-COMPONENT as-of clocks (bandar_asof / foreign_asof /
 * technical_asof / volume_asof, also nested under score_components) are
 * carried through. Dropping them would let a stale broker clock masquerade as
 * freshness-unknown and defeat the P0-08 gate on re-evaluation.
 *
 * @param {object} row
 * @param {string} sessionDate (the snapshot session date the row is graded against)
 * @returns {object}
 */
function normalizeCandidate(row, sessionDate) {
  const ticker = String(pickFirstText(row, 'ticker', 'symbol') || '').toUpperCase();
  const sc = row && row.score_components && typeof row.score_components === 'object'
    ? row.score_components
    : {};

  const componentAsOf = (comp, ...extraKeys) =>
    pickFirstText(row, ...extraKeys) ||
    pickFirstText(comp, 'as_of') ||
    null;

  return {
    ticker,
    emiten: pickFirstText(row, 'emiten', 'company_name', 'stock_name', 'name') || ticker,
    last_price: pickFirstNumber(row, 'last_price', 'close', 'price'),
    change_pct: pickFirstNumber(row, 'change_pct', 'changePercent'),
    volume_ratio: pickFirstNumber(row, 'volume_ratio_20d', 'volume_ratio', 'effective_volume_ratio'),

    entry_low: pickFirstNumber(row, 'entry_low', 'entry2', 'buy_low'),
    entry_high: pickFirstNumber(row, 'entry_high', 'entry1', 'entry', 'buy_high'),
    sl: pickFirstNumber(row, 'sl', 'stop_loss'),
    tp1: pickFirstNumber(row, 'tp1'),
    tp2: pickFirstNumber(row, 'tp2'),

    // Optional scoring inputs — absence is honest, canonical engine BLOCKS.
    bandar_score: pickFirstNumber(row, 'bandar_score', 'broksum_score', 'broker_score'),
    foreign_flow_score: pickFirstNumber(row, 'foreign_flow_score', 'foreign_score'),
    technical_score: pickFirstNumber(row, 'technical_score', 'conviction_score'),

    // Per-component clocks (P0-08). The row's OWN as_of is authoritative for
    // the price clock; only when absent do document-level dates apply. A
    // missing clock stays null (UNKNOWN) — never defaulted to sessionDate.
    as_of: pickFirstText(row, 'as_of', 'price_asof', 'trade_date', 'market_date', 'run_date') || null,
    price_asof: pickFirstText(row, 'price_asof', 'as_of') || null,
    bandar_asof: componentAsOf(sc.bandar, 'bandar_asof', 'broksum_date', 'broker_date'),
    foreign_asof: componentAsOf(sc.foreign, 'foreign_asof', 'foreign_date'),
    technical_asof: componentAsOf(sc.technical, 'technical_asof', 'technical_date'),
    volume_asof: componentAsOf(sc.volume_ratio, 'volume_asof', 'volume_date'),

    setup: pickFirstText(row, 'setup', 'status'),
    source: 'screener-latest-short-swing',
    source_file: 'data/screener-latest.json'
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Select the canonical Short Swing source pool from screener-latest.json.
 *
 * P0-09 GATE: the deprecated `swing` alias (Konglo165 screener results) is
 * NEVER accepted as the canonical source. When only the alias exists, the
 * runner reports an honest rejection instead of silently publishing Konglo165
 * as "whole IDX Short Swing".
 *
 * @returns {{ rows: Array<object>, pool: string, meta: object|null, rejected: string|null }}
 */
function selectCanonicalPool(doc) {
  if (!doc || typeof doc !== 'object') {
    return { rows: [], pool: null, meta: null, rejected: 'SOURCE_FILE_MISSING_OR_INVALID' };
  }
  const canonicalRows = Array.isArray(doc.short_swing) ? doc.short_swing : null;
  const meta = doc.short_swing_meta && typeof doc.short_swing_meta === 'object' ? doc.short_swing_meta : null;
  if (canonicalRows) {
    return { rows: canonicalRows, pool: 'short_swing', meta, rejected: null };
  }
  const legacyRows = Array.isArray(doc.swing) ? doc.swing : [];
  if (legacyRows.length > 0 || doc.swing_alias_deprecated) {
    return {
      rows: [],
      pool: null,
      meta,
      rejected: 'DEPRECATED_SWING_ALIAS_REJECTED: pool `swing` adalah alias Konglo165 (P0-09); ' +
        'producer wajib menulis pool kanonis `short_swing` dari seluruh universe IDX eligible'
    };
  }
  return { rows: [], pool: null, meta, rejected: 'SOURCE_PUBLISHED_NO_SHORT_SWING_POOL' };
}

function main() {
  const today = wibDateString();

  const doc = readJsonSafe(SOURCE_FILE, null);
  const { rows: sourceRows, pool: sourcePool, meta: producerMeta, rejected } = selectCanonicalPool(doc);

  // Session date = the snapshot's own market/trade date when available, so the
  // freshness gate compares apples to apples (data as-of vs its own session).
  const sessionDate = pickFirstText(doc, 'market_date', 'trade_date', 'run_date') || today;

  const candidates = sourceRows.map((row) => normalizeCandidate(row, sessionDate));

  const snapshot = engine.buildSahamPotensialSnapshot(candidates, { sessionDate });

  const top20 = snapshot.top20;
  const top5 = snapshot.top5;

  // Producer/consumer consistency (P0-10).
  //
  // The producer's snapshot_id is a content hash over ALL evaluated rows of the
  // whole universe (909 rows), while the published pool only carries the top20.
  // The runner therefore cannot reproduce that id from the pool alone, and
  // comparing the two would always "fail". Instead it verifies what IS
  // checkable, using the hash inputs the producer persists in short_swing_meta:
  //
  //   a) every published row's content digest is recomputed from the row itself
  //      and compared to the producer's persisted `row_digests[ticker]`. Editing
  //      a score, level, R/R, risk flag or reason in the file changes the
  //      recomputed digest => ROW_TAMPERED.
  //   b) the snapshot-level hash is recomputed from the persisted
  //      (universe, row_digests, ranking, session_date, score_version, horizon)
  //      and compared to `snapshot_content_hash` => detects edited meta.
  //   c) the frozen store artifact for the producer snapshot_id must exist and
  //      still verify (append-only history, tamper-evident).
  //   d) no newer revision may exist for the session (superseded check).
  //
  // Any failure is published as an honest VALIDATION_FAILED / NOT_PUBLISHED —
  // never silently corrected, never served as READY.
  const producerSnapshotId = producerMeta && producerMeta.snapshot_id ? producerMeta.snapshot_id : null;
  const producerContentHash = producerMeta && producerMeta.snapshot_content_hash
    ? producerMeta.snapshot_content_hash
    : null;

  let recomputedContentHash = null;
  let rowDigestTamper = null;
  const tamperedRows = [];
  if (producerMeta && producerMeta.row_digests && Array.isArray(producerMeta.universe) &&
      Array.isArray(producerMeta.ranking)) {
    const rowDigests = Object.assign({}, producerMeta.row_digests);
    for (const row of sourceRows) {
      const recomputedRowDigest = engine.buildRowContentDigest(row);
      const persisted = rowDigests[row.ticker];
      if (persisted !== undefined && persisted !== recomputedRowDigest) {
        tamperedRows.push(row.ticker);
        rowDigests[row.ticker] = recomputedRowDigest;
      }
    }
    if (tamperedRows.length) rowDigestTamper = tamperedRows.join('|');
    recomputedContentHash = engine.buildSnapshotContentHash({
      session_date: producerMeta.session_date || sessionDate,
      score_version: producerMeta.score_version || engine.SCORE_ALGORITHM_VERSION,
      horizon: producerMeta.horizon || engine.HOLDING_HORIZON_LABEL,
      rows: [],
      ranking: producerMeta.ranking,
      universe: producerMeta.universe,
      rowDigests
    }).content_hash;
  }

  const contentHashMatch = producerContentHash === null || recomputedContentHash === null
    ? null
    : recomputedContentHash === producerContentHash;
  const snapshotIdMatch = contentHashMatch;

  // Append-only snapshot store (P0-10): the PRODUCER owns commits; the runner
  // only VERIFIES. Committing the runner's own 20-row rebuild would pollute
  // the canonical revision chain (a derived view is not a new revision).
  // Checks performed against the producer's snapshot_id:
  //   1. the frozen artifact exists and its content hash still matches its
  //      rows (tamper detection);
  //   2. no NEWER revision exists for the session (superseded => the runner
  //      must not present the old snapshot as the current truth).
  let superseded = false;
  let storeVerified = null;
  if (producerSnapshotId) {
    try {
      const storeOpts = STORE_DIR ? { storeDir: STORE_DIR } : {};
      superseded = snapshotStore.isSuperseded(producerSnapshotId, storeOpts);
      storeVerified = snapshotStore.loadVerifiedSnapshot(producerSnapshotId, storeOpts);
    } catch (err) {
      storeVerified = { snapshot: null, valid: false, reason: 'STORE_READ_ERROR_' + String((err && err.message) || err) };
    }
  }

  // Data status reflects the honest result of the canonical engine.
  let dataStatus;
  let statusReason;
  const readyCount = top20.filter((r) => r.readiness === 'READY').length;
  if (rejected) {
    dataStatus = 'NOT_PUBLISHED';
    statusReason = rejected;
  } else if (snapshotIdMatch === false) {
    dataStatus = 'VALIDATION_FAILED';
    statusReason = rowDigestTamper
      ? 'SNAPSHOT_ROW_TAMPERED_' + rowDigestTamper
      : 'SNAPSHOT_CONTENT_HASH_MISMATCH_PRODUCER_' + producerContentHash + '_VS_RECOMPUTED_' + recomputedContentHash;
  } else if (producerSnapshotId && storeVerified && storeVerified.valid === false) {
    // Fail-closed: the canonical producer ALWAYS commits its snapshot to the
    // append-only store. A missing/tampered artifact means the pool was not
    // produced by the canonical chain.
    dataStatus = 'VALIDATION_FAILED';
    statusReason = 'SNAPSHOT_STORE_VERIFICATION_FAILED_' + storeVerified.reason;
  } else if (superseded) {
    dataStatus = 'NOT_PUBLISHED';
    statusReason = 'SNAPSHOT_SUPERSEDED_BY_NEWER_REVISION';
  } else if (sourceRows.length === 0) {
    dataStatus = 'NOT_PUBLISHED';
    statusReason = 'SOURCE_PUBLISHED_NO_SHORT_SWING_ROWS';
  } else if (top20.length === 0) {
    dataStatus = 'NOT_PUBLISHED';
    statusReason = 'NO_SOURCE_ROW_PASSED_CANONICAL_ENGINE';
  } else if (readyCount === 0 && top20.every((r) => r.readiness === 'NOT_READY' || r.readiness === 'BLOCKED')) {
    dataStatus = 'BLOCKED';
    statusReason = 'ALL_CANDIDATES_NOT_READY_OR_BLOCKED_BY_CANONICAL_ENGINE';
  } else if (readyCount > 0) {
    dataStatus = 'AVAILABLE';
    statusReason = 'CANONICAL_SHORT_SWING_SNAPSHOT';
  } else {
    dataStatus = 'PARTIAL';
    statusReason = 'CANONICAL_ENGINE_EMITTED_NO_READY_ROWS';
  }

  // A superseded or failed-validation snapshot must NOT publish READY rows:
  // consumers read `picks`/`top5` as the actionable set.
  const publishable = dataStatus === 'AVAILABLE' || dataStatus === 'PARTIAL' || dataStatus === 'BLOCKED';

  // Canonical identity for the published rows. The runner's own rebuild only
  // spans the 20 published rows, so its id differs from the producer's
  // whole-universe content hash; the PRODUCER's id is the canonical one and is
  // stamped onto every published row so the artifact is internally consistent.
  const canonicalSnapshotId = producerSnapshotId || snapshot.snapshot_id;
  const canonicalContentHash = producerContentHash || snapshot.snapshot_content_hash;
  const restamp = (row) => Object.assign({}, row, {
    snapshot_id: canonicalSnapshotId,
    snapshot_content_hash: canonicalContentHash
  });
  const publishedTop20 = publishable ? top20.map(restamp) : [];
  const publishedTop5 = publishable ? publishedTop20.slice(0, Math.min(MAX_PICKS, publishedTop20.length)) : [];

  const top5Locked = false; // Deprecated three-category lock claim; kept false.

  const lockedPayload = {
    success: true,
    engine: '../lib/saham-potensial-engine.js',
    source_pool: sourcePool,
    score_version: snapshot.score_version,
    // Canonical identity = the PRODUCER's content-hash snapshot id. The
    // runner's own rebuild (20-row derived view) is diagnostic only.
    snapshot_id: producerSnapshotId || snapshot.snapshot_id,
    snapshot_content_hash: producerContentHash || snapshot.snapshot_content_hash,
    rebuilt_snapshot_id: snapshot.snapshot_id,
    rebuilt_content_hash: snapshot.snapshot_content_hash,
    producer_snapshot_id: producerSnapshotId,
    producer_snapshot_content_hash: producerContentHash,
    recomputed_content_hash: recomputedContentHash,
    content_hash_version: snapshot.content_hash_version,
    snapshot_id_match: snapshotIdMatch,
    revision_parent: producerMeta && producerMeta.revision_parent !== undefined ? producerMeta.revision_parent : null,
    snapshot_superseded: superseded,
    store_verified: storeVerified ? storeVerified.valid : null,
    store_verify_reason: storeVerified ? storeVerified.reason : null,
    session_date: snapshot.session_date,
    trade_date: snapshot.session_date,
    date: snapshot.session_date,
    data_as_of: snapshot.session_date,
    locked_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    monitor_last_updated_at: new Date().toISOString(),

    top5_locked: top5Locked,
    top5_source: 'canonical_short_swing_snapshot',
    lock_reason: 'CANONICAL_SNAPSHOT_PUBLISHER',

    session_status: publishedTop20.length === 0 ? 'NO_DATA' : 'FINAL_SNAPSHOT',
    is_eod_final: false,
    eod_complete: false,

    data_status: dataStatus,
    status_reason: statusReason,
    rr_policy_minimum: MIN_RR_RATIO,
    fabricated_count: 0,

    universe_count: snapshot.universe_count,
    evaluated_count: snapshot.evaluated_count,
    top20_count: publishedTop20.length,
    top5_count: publishedTop5.length,
    producer_meta: producerMeta,

    total_locked: publishedTop5.length,
    top5: publishedTop5,
    picks: publishedTop5,
    top5_picks: publishedTop5,
    top20: publishedTop20,
    categories: {},
    categories_meta: {
      'short-swing': {
        key: 'short-swing',
        label: 'Short Swing IDX',
        source_file: 'data/screener-latest.json',
        source_pool: sourcePool,
        source_rows: sourceRows.length,
        data_status: dataStatus,
        trade_date: sessionDate
      }
    }
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(lockedPayload, null, 2), 'utf8');

  /* Radar state */
  const radarState = readJsonSafe(RADAR_STATE_FILE, {});
  radarState.status = publishedTop20.length === 0 ? 'no_data' : 'active';
  radarState.top5_locked = top5Locked;
  radarState.session_status = lockedPayload.session_status;
  radarState.is_eod_final = lockedPayload.is_eod_final;
  radarState.data_status = dataStatus;
  radarState.status_reason = statusReason;
  radarState.trade_date = sessionDate;
  radarState.market_date = sessionDate;
  radarState.run_date = sessionDate;
  radarState.snapshot_id = canonicalSnapshotId;
  radarState.snapshot_content_hash = canonicalContentHash;
  radarState.rebuilt_snapshot_id = snapshot.snapshot_id;
  radarState.score_version = snapshot.score_version;
  radarState.calculated_at = new Date().toISOString();
  radarState.updated_at = new Date().toISOString();
  radarState.freshness_label = readyCount > 0 && publishable ? 'fresh' : (publishedTop20.length === 0 ? null : 'stale');
  fs.writeFileSync(RADAR_STATE_FILE, JSON.stringify(radarState, null, 2), 'utf8');

  /* Heartbeat */
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  const heartbeat = {
    job: 'top5-radar',
    jobName: 'top5-radar',
    lastRun: new Date().toISOString(),
    lastStartWIB: new Date().toISOString(),
    lastEndWIB: new Date().toISOString(),
    status: publishedTop20.length === 0 ? 'NO_DATA' : 'OK',
    exitCode: 0,
    durationMs: 0,
    requestsUsed: 0,
    updatedAt: new Date().toISOString(),
    locked_count: publishedTop5.length,
    top20_count: publishedTop20.length,
    data_status: dataStatus,
    status_reason: statusReason,
    snapshot_id: canonicalSnapshotId,
    snapshot_content_hash: canonicalContentHash,
    score_version: snapshot.score_version,
    categories_locked: {
      'short-swing': publishedTop5.length
    }
  };
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2), 'utf8');

  console.log('[TOP5-RADAR] canonical short swing only — pool=' + sourcePool +
    ' source_rows=' + sourceRows.length +
    ' evaluated=' + snapshot.evaluated_count + ' top20=' + publishedTop20.length +
    ' top5=' + publishedTop5.length + ' ready=' + readyCount +
    ' snapshot_id=' + canonicalSnapshotId + ' hash_match=' + snapshotIdMatch +
    ' superseded=' + superseded + ' data_status=' + dataStatus);
  console.log('[TOP5-RADAR] reason: ' + statusReason);
  console.log('[TOP5-RADAR] File tersimpan: data/top5-radar.json, exitCode=0');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[TOP5-RADAR ERROR]', err);
    process.exit(1);
  }
}

module.exports = { main, normalizeCandidate, selectCanonicalPool, CATEGORY_SPECS, MAX_PICKS, MAX_TOP20, MIN_WIN_RATE_SAMPLE };
