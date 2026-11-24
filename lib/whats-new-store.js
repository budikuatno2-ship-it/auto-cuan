'use strict';

/**
 * lib/whats-new-store.js
 * ============================================================================
 * V6 (W2a / Feature 13A) — DURABLE, VERSIONED "WHAT'S NEW" RELEASE STORE
 * ============================================================================
 * WHY THIS EXISTS
 *   Feature 13A ("What's New") had ZERO implementation: no endpoint, no data
 *   file, no admin surface, no test. The nearest artefacts were api/version.js
 *   and a static CHANGELOG.md — neither of which can show a release ONCE per
 *   user with server-side acknowledgement truth.
 *
 *   This module is the single source-of-truth for release notes:
 *     - a versioned, atomically-written releases document,
 *     - an append-only per-user acknowledgement log (unique user_id+release_id),
 *     - an append-only audit log for every admin action.
 *
 * PERSISTENCE (all overridable via env for tests)
 *   data/whats-new/releases.json          (WHATS_NEW_STORE_PATH)
 *   data/whats-new/backups/               (WHATS_NEW_BACKUP_DIR)
 *       releases.v<N>.json                (immutable snapshot before each write)
 *   data/whats-new/acks.jsonl             (WHATS_NEW_ACKS_PATH, append-only)
 *   data/whats-new/audit.log.jsonl        (WHATS_NEW_AUDIT_PATH, append-only)
 *
 * RELEASE SHAPE
 *   {
 *     release_id, version, title, summary, items[],
 *     published_at_wib, published_by,
 *     status: 'draft' | 'published' | 'archived',
 *     rollback_of: <release_id|null>
 *   }
 *
 * SAFETY
 *   - Atomic temp+rename writes; a backup snapshot is taken before every write.
 *   - Optimistic concurrency: a stale `expectedVersion` is rejected (CONFLICT).
 *   - Acknowledgements are idempotent: a second ack for the same
 *     (user_id, release_id) returns already_acknowledged:true and appends NO
 *     duplicate row.
 *   - No fabricated timestamps: published_at_wib is only set on publish.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const STORE_PATH = process.env.WHATS_NEW_STORE_PATH || path.join(ROOT, 'data', 'whats-new', 'releases.json');
const BACKUP_DIR = process.env.WHATS_NEW_BACKUP_DIR || path.join(ROOT, 'data', 'whats-new', 'backups');
const ACKS_PATH = process.env.WHATS_NEW_ACKS_PATH || path.join(ROOT, 'data', 'whats-new', 'acks.jsonl');
const AUDIT_PATH = process.env.WHATS_NEW_AUDIT_PATH || path.join(ROOT, 'data', 'whats-new', 'audit.log.jsonl');

const SCHEMA_VERSION = 1;
const MAX_TITLE = 160;
const MAX_SUMMARY = 2000;
const MAX_ITEMS = 50;
const MAX_ITEM_LEN = 500;

const STATUSES = ['draft', 'published', 'archived'];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function ensureDirs() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ACKS_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
}

/** WIB ISO-8601 with explicit +07:00 offset (never a bare UTC stamp). */
function wibIso(nowOpt) {
  const d = nowOpt instanceof Date ? nowOpt : new Date(nowOpt == null ? Date.now() : nowOpt);
  const base = isNaN(d.getTime()) ? new Date() : d;
  const shifted = new Date(base.getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    shifted.getUTCFullYear() + '-' + p(shifted.getUTCMonth() + 1) + '-' + p(shifted.getUTCDate()) +
    'T' + p(shifted.getUTCHours()) + ':' + p(shifted.getUTCMinutes()) + ':' + p(shifted.getUTCSeconds()) +
    '+07:00'
  );
}

function blankDoc() {
  return { schemaVersion: SCHEMA_VERSION, version: 0, releases: [] };
}

function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return blankDoc();
  const out = blankDoc();
  out.version = Number.isInteger(Number(doc.version)) && Number(doc.version) >= 0 ? Number(doc.version) : 0;
  out.releases = Array.isArray(doc.releases) ? doc.releases.filter((r) => r && typeof r === 'object') : [];
  return out;
}

function readDoc() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return { ok: true, doc: normalizeDoc(JSON.parse(raw)), error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: blankDoc(), error: null };
    return { ok: false, doc: blankDoc(), error: String((err && err.message) || err) };
  }
}

function writeDocAtomic(doc) {
  ensureDirs();
  // Backup the CURRENT on-disk document (if any) before overwriting.
  try {
    if (fs.existsSync(STORE_PATH)) {
      const current = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      const v = Number.isInteger(Number(current && current.version)) ? Number(current.version) : 0;
      const backupFile = path.join(BACKUP_DIR, 'releases.v' + v + '.json');
      if (!fs.existsSync(backupFile)) {
        fs.writeFileSync(backupFile, JSON.stringify(current, null, 2), 'utf8');
      }
    }
  } catch (_) { /* backup is best-effort; never block the write */ }

  const tmp = STORE_PATH + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
  return true;
}

function appendJsonl(filePath, record) {
  ensureDirs();
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function appendAudit(entry) {
  appendJsonl(AUDIT_PATH, Object.assign({
    eventId: crypto.randomUUID(),
    timestampIso: new Date().toISOString(),
    processPid: process.pid
  }, entry));
}

function newReleaseId() {
  return 'rel_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function validateReleaseInput(input) {
  const errors = [];
  const title = String((input && input.title) || '').trim();
  const summary = String((input && input.summary) || '').trim();
  let items = input && input.items;
  if (items == null) items = [];
  if (!Array.isArray(items)) {
    errors.push('items harus array.');
    items = [];
  }
  if (!title) errors.push('title wajib diisi.');
  if (title.length > MAX_TITLE) errors.push('title maksimal ' + MAX_TITLE + ' karakter.');
  if (summary.length > MAX_SUMMARY) errors.push('summary maksimal ' + MAX_SUMMARY + ' karakter.');
  if (items.length > MAX_ITEMS) errors.push('items maksimal ' + MAX_ITEMS + ' butir.');
  const cleanItems = [];
  for (const it of items) {
    const s = String(it == null ? '' : it).trim();
    if (!s) continue;
    if (s.length > MAX_ITEM_LEN) {
      errors.push('satu butir items melebihi ' + MAX_ITEM_LEN + ' karakter.');
      continue;
    }
    cleanItems.push(s);
  }
  return { ok: errors.length === 0, errors, title, summary, items: cleanItems };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

function getDoc() {
  return readDoc();
}

function listReleases() {
  const r = readDoc();
  if (!r.ok) return { ok: false, error: r.error, releases: [] };
  return { ok: true, releases: r.doc.releases.slice(), version: r.doc.version };
}

/** Latest PUBLISHED release (highest version among published), or null. */
function getLatestPublished() {
  const r = readDoc();
  if (!r.ok) return { ok: false, error: r.error, release: null };
  const published = r.doc.releases.filter((x) => x.status === 'published');
  if (published.length === 0) return { ok: true, release: null, version: r.doc.version };
  published.sort((a, b) => (b.version || 0) - (a.version || 0));
  return { ok: true, release: published[0], version: r.doc.version };
}

function findRelease(doc, releaseId) {
  return doc.releases.find((x) => x.release_id === releaseId) || null;
}

/* -------------------------------------------------------------------------- */
/* Mutations (admin)                                                           */
/* -------------------------------------------------------------------------- */

function createDraft(input, opts) {
  const o = opts || {};
  const v = validateReleaseInput(input);
  if (!v.ok) return { ok: false, reason: 'VALIDATION_FAILED', errors: v.errors };

  const r = readDoc();
  if (!r.ok) return { ok: false, reason: 'READ_FAILED', error: r.error };
  const doc = r.doc;

  if (o.expectedVersion != null && Number(o.expectedVersion) !== doc.version) {
    return { ok: false, reason: 'CONFLICT', currentVersion: doc.version };
  }

  const release = {
    release_id: newReleaseId(),
    version: doc.version + 1,
    title: v.title,
    summary: v.summary,
    items: v.items,
    published_at_wib: null,
    published_by: null,
    status: 'draft',
    rollback_of: null,
    created_at_wib: wibIso(o.now),
    created_by: String(o.actor || 'admin')
  };

  doc.releases.push(release);
  doc.version += 1;
  writeDocAtomic(doc);
  appendAudit({ action: 'WHATS_NEW_DRAFT_CREATED', actor: release.created_by, release_id: release.release_id, version: doc.version });
  return { ok: true, release, version: doc.version };
}

function publish(releaseId, opts) {
  const o = opts || {};
  const r = readDoc();
  if (!r.ok) return { ok: false, reason: 'READ_FAILED', error: r.error };
  const doc = r.doc;

  if (o.expectedVersion != null && Number(o.expectedVersion) !== doc.version) {
    return { ok: false, reason: 'CONFLICT', currentVersion: doc.version };
  }

  const release = findRelease(doc, releaseId);
  if (!release) return { ok: false, reason: 'NOT_FOUND' };
  if (release.status === 'published') return { ok: false, reason: 'ALREADY_PUBLISHED' };

  // Only one release may be the "current" published one at a time; archive the
  // previously published release so GET /api/whats-new is unambiguous.
  for (const other of doc.releases) {
    if (other.status === 'published' && other.release_id !== releaseId) {
      other.status = 'archived';
    }
  }

  release.status = 'published';
  release.published_at_wib = wibIso(o.now);
  release.published_by = String(o.actor || 'admin');
  doc.version += 1;
  writeDocAtomic(doc);
  appendAudit({ action: 'WHATS_NEW_PUBLISHED', actor: release.published_by, release_id: release.release_id, version: doc.version });
  return { ok: true, release, version: doc.version };
}

function archive(releaseId, opts) {
  const o = opts || {};
  const r = readDoc();
  if (!r.ok) return { ok: false, reason: 'READ_FAILED', error: r.error };
  const doc = r.doc;

  if (o.expectedVersion != null && Number(o.expectedVersion) !== doc.version) {
    return { ok: false, reason: 'CONFLICT', currentVersion: doc.version };
  }

  const release = findRelease(doc, releaseId);
  if (!release) return { ok: false, reason: 'NOT_FOUND' };
  if (release.status === 'archived') return { ok: false, reason: 'ALREADY_ARCHIVED' };

  release.status = 'archived';
  doc.version += 1;
  writeDocAtomic(doc);
  appendAudit({ action: 'WHATS_NEW_ARCHIVED', actor: String(o.actor || 'admin'), release_id: release.release_id, version: doc.version });
  return { ok: true, release, version: doc.version };
}

/**
 * Rollback: re-publish a previous release by creating a NEW release that
 * mirrors it (rollback_of points at the source). History is never erased.
 */
function rollback(targetReleaseId, opts) {
  const o = opts || {};
  const r = readDoc();
  if (!r.ok) return { ok: false, reason: 'READ_FAILED', error: r.error };
  const doc = r.doc;

  if (o.expectedVersion != null && Number(o.expectedVersion) !== doc.version) {
    return { ok: false, reason: 'CONFLICT', currentVersion: doc.version };
  }

  const target = findRelease(doc, targetReleaseId);
  if (!target) return { ok: false, reason: 'NOT_FOUND' };

  for (const other of doc.releases) {
    if (other.status === 'published') other.status = 'archived';
  }

  const release = {
    release_id: newReleaseId(),
    version: doc.version + 1,
    title: target.title,
    summary: target.summary,
    items: Array.isArray(target.items) ? target.items.slice() : [],
    published_at_wib: wibIso(o.now),
    published_by: String(o.actor || 'admin'),
    status: 'published',
    rollback_of: target.release_id,
    created_at_wib: wibIso(o.now),
    created_by: String(o.actor || 'admin')
  };

  doc.releases.push(release);
  doc.version += 1;
  writeDocAtomic(doc);
  appendAudit({
    action: 'WHATS_NEW_ROLLBACK',
    actor: release.published_by,
    release_id: release.release_id,
    rollback_of: target.release_id,
    version: doc.version
  });
  return { ok: true, release, version: doc.version };
}

/* -------------------------------------------------------------------------- */
/* Acknowledgements (per user, append-only, idempotent)                        */
/* -------------------------------------------------------------------------- */

function readAcks() {
  try {
    const raw = fs.readFileSync(ACKS_PATH, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch (_) { /* skip corrupt line */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function getAckForUser(userId, releaseId) {
  const uid = String(userId || '');
  const rid = String(releaseId || '');
  if (!uid || !rid) return null;
  const acks = readAcks();
  for (let i = acks.length - 1; i >= 0; i--) {
    const a = acks[i];
    if (String(a.user_id) === uid && String(a.release_id) === rid) return a;
  }
  return null;
}

function hasAck(userId, releaseId) {
  return getAckForUser(userId, releaseId) != null;
}

/**
 * Record an acknowledgement. Idempotent: a duplicate (user_id, release_id)
 * returns already_acknowledged:true and appends NO new row.
 */
function recordAck(input) {
  const o = input || {};
  const userId = String(o.userId || '').trim();
  const releaseId = String(o.releaseId || '').trim();
  if (!userId) return { ok: false, reason: 'MISSING_USER' };
  if (!releaseId) return { ok: false, reason: 'MISSING_RELEASE' };

  const existing = getAckForUser(userId, releaseId);
  if (existing) {
    return { ok: true, already_acknowledged: true, ack: existing };
  }

  const ack = {
    user_id: userId,
    release_id: releaseId,
    acknowledged_at_wib: wibIso(o.now),
    device_hint: o.deviceHint ? String(o.deviceHint).slice(0, 120) : null,
    ip_hash: o.ipHash ? String(o.ipHash).slice(0, 64) : null
  };
  appendJsonl(ACKS_PATH, ack);
  return { ok: true, already_acknowledged: false, ack };
}

module.exports = {
  // paths (exposed for tests / diagnostics)
  STORE_PATH,
  BACKUP_DIR,
  ACKS_PATH,
  AUDIT_PATH,
  STATUSES,
  // helpers
  wibIso,
  // reads
  getDoc,
  listReleases,
  getLatestPublished,
  getAckForUser,
  hasAck,
  // admin mutations
  createDraft,
  publish,
  archive,
  rollback,
  // acks
  recordAck
};
