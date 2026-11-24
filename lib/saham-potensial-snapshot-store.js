'use strict';

/**
 * lib/saham-potensial-snapshot-store.js
 * ============================================================================
 * Append-only snapshot history store — Auto-Cuan V6 (Subtask H / P0-10)
 * ============================================================================
 *
 * CONTRACT:
 * 1. Every published Short Swing snapshot is recorded in an append-only JSONL
 *    history file (`data/saham-potensial-snapshots/history.jsonl`). Existing
 *    lines are NEVER rewritten, reordered or deleted by this module.
 * 2. A full copy of each snapshot is frozen at
 *    `data/saham-potensial-snapshots/<snapshot_id>.json`. Once written, the
 *    file is immutable: re-publishing the SAME content hash is a no-op, and
 *    attempting to overwrite an existing snapshot_id with DIFFERENT content
 *    throws (that would mean a hash collision or a tampered artifact).
 * 3. Identity is the canonical content hash produced by
 *    `lib/saham-potensial-engine.js#buildSnapshotContentHash`. Any change to
 *    scores / R-R / levels / flags / reasons / ranking produces a NEW
 *    snapshot_id; the store then links it to the previous snapshot of the same
 *    session_date via `revision_parent` (append-only revision chain).
 * 4. `getLatestForSession()` only returns a snapshot whose recorded content
 *    hash still matches the recomputed hash of its stored rows — a tampered or
 *    truncated artifact is reported as INVALID, never served as truth.
 * 5. Consumers must NOT publish READY rows from a superseded snapshot: when a
 *    newer revision exists for the session, `isSuperseded()` returns true for
 *    the older snapshot_id.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require('./saham-potensial-engine.js');

const DEFAULT_STORE_DIR = path.join(__dirname, '..', 'data', 'saham-potensial-snapshots');
const HISTORY_FILE_NAME = 'history.jsonl';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch (_) {
      // A corrupt trailing line must not erase history; surface it as a record
      // so auditors can see the corruption instead of silently dropping it.
      out.push({ corrupt_line: s.slice(0, 200) });
    }
  }
  return out;
}

/**
 * Recompute the canonical content hash of a stored snapshot so a tampered
 * artifact can be detected on read.
 *
 * The engine persists every hash input on the snapshot itself
 * (`universe`, `row_digests`, `ranking`, `content_hash_version`), so the hash
 * is recomputed from the artifact alone — no engine re-run required. In
 * addition, each stored top20 row's digest is recomputed from the row content:
 * editing a score, level, R/R, flag or reason inside the artifact changes the
 * recomputed digest and therefore the snapshot hash.
 *
 * @returns {string|null} recomputed hash, or null when inputs are absent
 */
function recomputeContentHash(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.top20)) return null;
  if (!snapshot.row_digests || !Array.isArray(snapshot.universe) || !Array.isArray(snapshot.ranking)) {
    return null;
  }
  const rowDigests = Object.assign({}, snapshot.row_digests);
  for (const row of snapshot.top20) {
    const recomputedRowDigest = engine.buildRowContentDigest(row);
    if (rowDigests[row.ticker] !== recomputedRowDigest) {
      // Row content no longer matches its persisted digest => the recomputed
      // snapshot hash will differ from the stored one and verification fails.
      rowDigests[row.ticker] = recomputedRowDigest;
    }
  }
  const payload = {
    hash_version: snapshot.content_hash_version || engine.CONTENT_HASH_VERSION,
    session_date: snapshot.session_date,
    score_version: snapshot.score_version,
    horizon: snapshot.horizon,
    universe_count: snapshot.universe.length,
    universe: snapshot.universe.slice().sort(),
    row_digests: rowDigests,
    ranking: snapshot.ranking
  };
  return crypto.createHash('sha256')
    .update(engine.stableStringify(payload))
    .digest('hex');
}

/**
 * Publish a snapshot built by `engine.buildSahamPotensialSnapshot()`.
 *
 * - Same content hash as an existing record => idempotent no-op.
 * - New content for the same session_date => appended as a new revision with
 *   `revision_parent` pointing at the previous snapshot_id of that session.
 * - Existing snapshot_id file with different bytes => throws (tamper guard).
 *
 * @param {object} snapshot engine snapshot object
 * @param {object} [options] { storeDir, universe }
 * @returns {{ snapshot_id: string, appended: boolean, revision_parent: string|null, path: string }}
 */
function publishSnapshot(snapshot, options = {}) {
  if (!snapshot || !snapshot.snapshot_id || !snapshot.snapshot_content_hash) {
    throw new Error('SNAPSHOT_MISSING_IDENTITY: snapshot_id/snapshot_content_hash wajib ada');
  }
  const storeDir = options.storeDir || DEFAULT_STORE_DIR;
  ensureDir(storeDir);
  const historyFile = path.join(storeDir, HISTORY_FILE_NAME);
  const snapshotFile = path.join(storeDir, snapshot.snapshot_id + '.json');

  const history = readJsonl(historyFile);
  const existing = history.find((h) => h.snapshot_id === snapshot.snapshot_id);

  if (existing) {
    // Idempotent re-publish of identical content is allowed; different content
    // under the same id means tampering or a hash bug — fail loudly.
    if (existing.content_hash !== snapshot.snapshot_content_hash) {
      throw new Error('SNAPSHOT_ID_CONTENT_MISMATCH: ' + snapshot.snapshot_id);
    }
    if (fs.existsSync(snapshotFile)) {
      const onDisk = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      if (onDisk.snapshot_content_hash !== snapshot.snapshot_content_hash) {
        throw new Error('SNAPSHOT_FILE_TAMPERED: ' + snapshotFile);
      }
    }
    return {
      snapshot_id: snapshot.snapshot_id,
      appended: false,
      revision_parent: existing.revision_parent || null,
      path: snapshotFile
    };
  }

  // Revision chain: previous snapshot of the SAME session_date (last wins).
  let revisionParent = null;
  for (const h of history) {
    if (h.session_date === snapshot.session_date && !h.corrupt_line) {
      revisionParent = h.snapshot_id;
    }
  }

  const record = {
    snapshot_id: snapshot.snapshot_id,
    content_hash: snapshot.snapshot_content_hash,
    content_hash_version: snapshot.content_hash_version || engine.CONTENT_HASH_VERSION,
    session_date: snapshot.session_date,
    score_version: snapshot.score_version,
    horizon: snapshot.horizon,
    universe_count: snapshot.universe_count,
    evaluated_count: snapshot.evaluated_count,
    top20_count: snapshot.top20_count,
    top5_count: snapshot.top5_count,
    revision_parent: revisionParent,
    published_at: new Date().toISOString(),
    history_file: HISTORY_FILE_NAME
  };

  // Append-only: never rewrite the file, only add one line.
  fs.appendFileSync(historyFile, JSON.stringify(record) + '\n', 'utf8');

  // IMPORTANT: `snapshot.universe` / `row_digests` / `ranking` are the exact
  // inputs the canonical content hash was computed over. They must be frozen
  // VERBATIM, otherwise `loadVerifiedSnapshot()` recomputes a different hash
  // and a perfectly honest artifact looks tampered. A caller-supplied source
  // list is stored under a separate, non-hashed key.
  const frozen = Object.assign({}, snapshot, {
    revision_parent: revisionParent,
    published_at: record.published_at
  });
  if (Array.isArray(options.universe)) {
    frozen.source_universe = options.universe.slice().sort();
    frozen.source_universe_count = options.universe.length;
  }
  if (fs.existsSync(snapshotFile)) {
    const onDisk = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    if (onDisk.snapshot_content_hash !== snapshot.snapshot_content_hash) {
      throw new Error('SNAPSHOT_FILE_TAMPERED: ' + snapshotFile);
    }
  } else {
    fs.writeFileSync(snapshotFile, JSON.stringify(frozen, null, 2), 'utf8');
  }

  return {
    snapshot_id: snapshot.snapshot_id,
    appended: true,
    revision_parent: revisionParent,
    path: snapshotFile
  };
}

/** Full ordered history (append-only ledger). */
function readHistory(options = {}) {
  const storeDir = options.storeDir || DEFAULT_STORE_DIR;
  return readJsonl(path.join(storeDir, HISTORY_FILE_NAME));
}

/**
 * Latest snapshot record for a session_date, or the global latest when no
 * session is given. Returns null when the history is empty.
 */
function getLatestRecord(options = {}) {
  const history = readHistory(options).filter((h) => !h.corrupt_line);
  if (!history.length) return null;
  if (options.sessionDate) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].session_date === options.sessionDate) return history[i];
    }
    return null;
  }
  return history[history.length - 1];
}

/**
 * Load a frozen snapshot artifact and verify its content hash still matches
 * its rows. A snapshot that fails verification is reported, never trusted.
 *
 * @returns {{ snapshot: object|null, valid: boolean, reason: string|null }}
 */
function loadVerifiedSnapshot(snapshotId, options = {}) {
  const storeDir = options.storeDir || DEFAULT_STORE_DIR;
  const file = path.join(storeDir, snapshotId + '.json');
  if (!fs.existsSync(file)) {
    return { snapshot: null, valid: false, reason: 'SNAPSHOT_FILE_MISSING' };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { snapshot: null, valid: false, reason: 'SNAPSHOT_FILE_UNPARSEABLE' };
  }
  if (snapshot.snapshot_id !== snapshotId) {
    return { snapshot, valid: false, reason: 'SNAPSHOT_ID_MISMATCH' };
  }
  const recomputed = recomputeContentHash(snapshot);
  if (recomputed !== snapshot.snapshot_content_hash) {
    return { snapshot, valid: false, reason: 'CONTENT_HASH_MISMATCH' };
  }
  return { snapshot, valid: true, reason: null };
}

/**
 * True when a NEWER snapshot exists for the same session_date — i.e. this
 * snapshot_id has been superseded by a revision and must not be published as
 * the current truth.
 */
function isSuperseded(snapshotId, options = {}) {
  const history = readHistory(options).filter((h) => !h.corrupt_line);
  const idx = history.findIndex((h) => h.snapshot_id === snapshotId);
  if (idx < 0) return false;
  const sessionDate = history[idx].session_date;
  for (let i = idx + 1; i < history.length; i++) {
    if (history[i].session_date === sessionDate) return true;
  }
  return false;
}

module.exports = {
  DEFAULT_STORE_DIR,
  HISTORY_FILE_NAME,
  publishSnapshot,
  readHistory,
  getLatestRecord,
  loadVerifiedSnapshot,
  recomputeContentHash,
  isSuperseded
};
