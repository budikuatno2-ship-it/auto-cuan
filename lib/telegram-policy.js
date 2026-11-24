'use strict';

/**
 * lib/telegram-policy.js — M-P1c Top5 Telegram Notification Policy (PURE)
 * ============================================================================
 * Decision module deciding whether the Top5 Telegram highlight should be sent
 * for a new Top20 snapshot. Pure: no I/O, no network, no clock reads (an
 * explicit `now` Date is injected).
 *
 * User policy (M-P1c):
 *   - Top20 is refreshed and visible on the WEBSITE every valid Mon-Fri session.
 *   - Top5 goes to Telegram ONLY when new candidates or material meaningful
 *     changes occur vs the previous snapshot — never an identical daily list.
 *   - Dedupe by snapshot_id / ticker / signal lifecycle / event_id.
 *   - Weekly digest is OPT-IN (disabled by default).
 *   - Weekends: NO daily picks are fabricated (NO_SESSION_WEEKEND).
 *   - No valid READY candidates => NO_VALID_CANDIDATE (never a fake BUY).
 *
 * Material change classes:
 *   MEMBERSHIP_ADDED / MEMBERSHIP_REMOVED  — Top5 ticker set changed
 *   SCORE_CHANGE      — same members, but a score moved more than
 *                       config.scoreChangeThresholdPct
 *   ENTRY_LEVEL_CHANGE — entry/SL/TP level changed for a shared member
 *   READINESS_FLIP    — actionable <-> not actionable flipped for a member
 *   NO_CHANGE         — identical content => shouldNotify=false IDENTICAL_SNAPSHOT
 *
 * event_id = sha256(prev_snapshot_id + '|' + next_snapshot_id + '|' + changeClass)
 * so the same transition class between the same two snapshots always maps to
 * the same id (stable dedupe key).
 * ============================================================================
 */

const crypto = require('crypto');

const REASONS = Object.freeze({
  NO_SESSION_WEEKEND: 'NO_SESSION_WEEKEND',
  NO_VALID_CANDIDATE: 'NO_VALID_CANDIDATE',
  IDENTICAL_SNAPSHOT: 'IDENTICAL_SNAPSHOT',
  NO_MATERIAL_CHANGE: 'NO_MATERIAL_CHANGE',
  NO_PREV_SNAPSHOT: 'NO_PREV_SNAPSHOT',
  NOTIFY_MEMBERSHIP_CHANGE: 'NOTIFY_MEMBERSHIP_CHANGE',
  NOTIFY_SCORE_CHANGE: 'NOTIFY_SCORE_CHANGE',
  NOTIFY_ENTRY_LEVEL_CHANGE: 'NOTIFY_ENTRY_LEVEL_CHANGE',
  NOTIFY_READINESS_FLIP: 'NOTIFY_READINESS_FLIP'
});

const CHANGE_CLASSES = Object.freeze({
  NONE: 'NO_CHANGE',
  MEMBERSHIP_ADDED: 'MEMBERSHIP_ADDED',
  MEMBERSHIP_REMOVED: 'MEMBERSHIP_REMOVED',
  SCORE_CHANGE: 'SCORE_CHANGE',
  ENTRY_LEVEL_CHANGE: 'ENTRY_LEVEL_CHANGE',
  READINESS_FLIP: 'READINESS_FLIP'
});

const DEFAULT_CONFIG = Object.freeze({
  scoreChangeThresholdPct: 5.0,
  weeklyDigestEnabled: false
});

function defaultConfig(overrides) {
  return Object.assign({}, DEFAULT_CONFIG, overrides || {});
}

function normalizeTicker(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isWeekend(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Pick the Top5 tickers from a snapshot (ordered by rank, first 5). */
function top5Tickers(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
  return rows
    .slice()
    .sort((a, b) => (numOrNull(a.rank) != null && numOrNull(b.rank) != null
      ? numOrNull(a.rank) - numOrNull(b.rank)
      : 0))
    .slice(0, 5)
    .map((r) => normalizeTicker(r.ticker))
    .filter(Boolean);
}

function rowByTicker(snapshot, ticker) {
  const rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const t = normalizeTicker(ticker);
  for (const r of rows) if (normalizeTicker(r.ticker) === t) return r;
  return null;
}

function isActionable(row) {
  const v = row && (row.actionable != null ? row.actionable : row.ready);
  return v === true || String(v).toLowerCase() === 'true';
}

/**
 * Count READY/actionable candidates. A ticker is a valid candidate only when
 * explicitly READY/actionable — anything else never becomes a BUY suggestion.
 */
function countReadyCandidates(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
  return rows.filter(isActionable).length;
}

/** Stable event_id over the transition: hash(prev_id + next_id + changeClass). */
function computeEventId(prevSnapshotId, nextSnapshotId, changeClass) {
  const basis = `${prevSnapshotId == null ? '' : prevSnapshotId}|${nextSnapshotId == null ? '' : nextSnapshotId}|${changeClass}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function diffMembership(prevRows, nextRows) {
  const prev = new Set(prevRows.map(normalizeTicker));
  const next = new Set(nextRows.map(normalizeTicker));
  const added = [];
  const removed = [];
  for (const t of next) if (!prev.has(t)) added.push(t);
  for (const t of prev) if (!next.has(t)) removed.push(t);
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

/**
 * Compare a shared member across snapshots.
 * @returns {{changed:boolean, scoreChangePct:number|null, entryChanged:boolean,
 *            readinessFlipped:boolean}}
 */
function diffMember(prevRow, nextRow, thresholdPct) {
  const result = {
    changed: false,
    scoreChangePct: null,
    entryChanged: false,
    readinessFlipped: false
  };
  if (!prevRow || !nextRow) return result;

  const prevScore = numOrNull(prevRow.score);
  const nextScore = numOrNull(nextRow.score);
  if (prevScore != null && nextScore != null && prevScore !== 0) {
    const pct = Math.abs((nextScore - prevScore) / Math.abs(prevScore)) * 100;
    result.scoreChangePct = Number(pct.toFixed(4));
    if (pct > thresholdPct) result.changed = true;
  }

  const levelKeys = ['entry', 'entry1', 'entry2', 'sl', 'tp1', 'tp2'];
  for (const k of levelKeys) {
    const a = numOrNull(prevRow[k]);
    const b = numOrNull(nextRow[k]);
    if (a != null && b != null && a !== b) {
      result.entryChanged = true;
      result.changed = true;
    }
  }

  const prevAct = isActionable(prevRow);
  const nextAct = isActionable(nextRow);
  if (prevAct !== nextAct) {
    result.readinessFlipped = true;
    result.changed = true;
  }

  return result;
}

/**
 * Main policy decision.
 *
 * @param {object} args
 * @param {object|null} args.prevSnapshot  previous accepted Top20 snapshot
 * @param {object} args.nextSnapshot       freshly built Top20 snapshot
 * @param {Date|string|number} [args.now]  explicit clock (UTC); weekend check
 * @param {object} [args.config]           { scoreChangeThresholdPct, weeklyDigestEnabled }
 * @returns {{
 *   shouldNotify: boolean,
 *   reason: string,
 *   changeClass: string,
 *   event_id: string,
 *   details: object
 * }}
 */
function shouldNotifyTop5(args = {}) {
  const cfg = defaultConfig(args.config);
  const prev = args.prevSnapshot || null;
  const next = args.nextSnapshot || null;
  const now = args.now != null ? args.now : new Date();

  const details = {
    prev_snapshot_id: prev ? prev.snapshot_id || null : null,
    next_snapshot_id: next ? next.snapshot_id || null : null,
    added: [],
    removed: [],
    score_changes: [],
    entry_changes: [],
    readiness_flips: [],
    weekly_digest_eligible: cfg.weeklyDigestEnabled === true
  };

  // (g) No valid READY candidates => never notify, never fake a BUY.
  if (next && countReadyCandidates(next) === 0) {
    return {
      shouldNotify: false,
      reason: REASONS.NO_VALID_CANDIDATE,
      changeClass: CHANGE_CLASSES.NONE,
      event_id: computeEventId(
        details.prev_snapshot_id, details.next_snapshot_id, 'NO_VALID_CANDIDATE'),
      details
    };
  }

  // (f) Weekend => no daily picks fabricated.
  if (isWeekend(now)) {
    return {
      shouldNotify: false,
      reason: REASONS.NO_SESSION_WEEKEND,
      changeClass: CHANGE_CLASSES.NONE,
      event_id: computeEventId(
        details.prev_snapshot_id, details.next_snapshot_id, 'NO_SESSION_WEEKEND'),
      details
    };
  }

  // No previous snapshot: a first accepted snapshot IS new information, but
  // only when it carries valid candidates (checked above).
  if (!prev || !prev.snapshot_id) {
    return {
      shouldNotify: true,
      reason: REASONS.NO_PREV_SNAPSHOT,
      changeClass: CHANGE_CLASSES.MEMBERSHIP_ADDED,
      event_id: computeEventId('NONE', details.next_snapshot_id, 'FIRST_SNAPSHOT'),
      details
    };
  }

  // (e) Identical snapshot_id => identical content => never resend.
  if (details.prev_snapshot_id === details.next_snapshot_id) {
    return {
      shouldNotify: false,
      reason: REASONS.IDENTICAL_SNAPSHOT,
      changeClass: CHANGE_CLASSES.NONE,
      event_id: computeEventId(
        details.prev_snapshot_id, details.next_snapshot_id, 'IDENTICAL'),
      details
    };
  }

  const prevTop5 = top5Tickers(prev);
  const nextTop5 = top5Tickers(next);
  details.prev_top5 = prevTop5;
  details.next_top5 = nextTop5;

  // (b) Membership diff.
  const membership = diffMembership(prevTop5, nextTop5);
  details.added = membership.added;
  details.removed = membership.removed;

  // (c) Same-member material changes.
  let scoreChanged = false;
  let entryChanged = false;
  let readinessFlipped = false;
  for (const t of nextTop5) {
    const prevRow = rowByTicker(prev, t);
    const nextRow = rowByTicker(next, t);
    const d = diffMember(prevRow, nextRow, cfg.scoreChangeThresholdPct);
    if (d.scoreChangePct != null && d.scoreChangePct > cfg.scoreChangeThresholdPct) {
      details.score_changes.push({ ticker: t, change_pct: d.scoreChangePct });
      scoreChanged = true;
    }
    if (d.entryChanged) {
      details.entry_changes.push({ ticker: t });
      entryChanged = true;
    }
    if (d.readinessFlipped) {
      details.readiness_flips.push({ ticker: t, from: isActionable(prevRow), to: isActionable(nextRow) });
      readinessFlipped = true;
    }
  }

  if (membership.changed) {
    details.change_class = membership.added.length ? CHANGE_CLASSES.MEMBERSHIP_ADDED : CHANGE_CLASSES.MEMBERSHIP_REMOVED;
    return {
      shouldNotify: true,
      reason: REASONS.NOTIFY_MEMBERSHIP_CHANGE,
      changeClass: details.change_class,
      event_id: computeEventId(details.prev_snapshot_id, details.next_snapshot_id, details.change_class),
      details
    };
  }
  if (readinessFlipped) {
    return {
      shouldNotify: true,
      reason: REASONS.NOTIFY_READINESS_FLIP,
      changeClass: CHANGE_CLASSES.READINESS_FLIP,
      event_id: computeEventId(details.prev_snapshot_id, details.next_snapshot_id, CHANGE_CLASSES.READINESS_FLIP),
      details
    };
  }
  if (entryChanged) {
    return {
      shouldNotify: true,
      reason: REASONS.NOTIFY_ENTRY_LEVEL_CHANGE,
      changeClass: CHANGE_CLASSES.ENTRY_LEVEL_CHANGE,
      event_id: computeEventId(details.prev_snapshot_id, details.next_snapshot_id, CHANGE_CLASSES.ENTRY_LEVEL_CHANGE),
      details
    };
  }
  if (scoreChanged) {
    return {
      shouldNotify: true,
      reason: REASONS.NOTIFY_SCORE_CHANGE,
      changeClass: CHANGE_CLASSES.SCORE_CHANGE,
      event_id: computeEventId(details.prev_snapshot_id, details.next_snapshot_id, CHANGE_CLASSES.SCORE_CHANGE),
      details
    };
  }

  // Same members, all deltas below threshold => not material.
  return {
    shouldNotify: false,
    reason: REASONS.NO_MATERIAL_CHANGE,
    changeClass: CHANGE_CLASSES.NONE,
    event_id: computeEventId(details.prev_snapshot_id, details.next_snapshot_id, 'NO_MATERIAL_CHANGE'),
    details
  };
}

module.exports = {
  REASONS,
  CHANGE_CLASSES,
  DEFAULT_CONFIG,
  defaultConfig,
  isWeekend,
  top5Tickers,
  countReadyCandidates,
  diffMembership,
  diffMember,
  computeEventId,
  shouldNotifyTop5
};
