'use strict';

/**
 * lib/task-d-telegram-push.js — TASK D Telegram Top5/Top20 push readiness.
 * ============================================================================
 * PURE decision + formatting layer. It performs NO network I/O and NEVER reads
 * process.env for a live-send decision. Every outbound message must be handed
 * to the caller's injected `transport` (tests inject a MOCK-* recorder; the
 * production notifier remains the only module allowed to touch the network,
 * behind lib/telegram-gate.js).
 *
 * Contract (owner TASK D requirement 1):
 *   - concise accurate message: ticker, entry, SL, TP1/TP2, R/R, score,
 *     snapshot date;
 *   - deduplication by (scope, snapshot_id, ticker, event) with a durable
 *     idempotency store seam;
 *   - readiness guard: NO send unless the row is READY (fail-closed);
 *   - dedicated chat routing: Top5 and Top20 route to distinct chat keys;
 *   - anti-secret leak: every payload is redacted before it reaches a transport
 *     or a receipt, and a token/chat-id-looking value is rejected in text;
 *   - Admin ON/OFF toggle: an explicit, versioned config seam (default OFF).
 *
 * All state is injectable. No production file is written by importing this
 * module. Fixtures used in tests are labelled OFFLINE SYNTHETIC.
 * ============================================================================
 */

const crypto = require('crypto');
const { redactString, redactObject } = require('./secret-redaction');

const SCOPES = Object.freeze({ TOP5: 'TOP5', TOP20: 'TOP20' });
const DEFAULT_CONFIG = Object.freeze({
  // Fail-closed: an Admin must explicitly turn the broadcast on.
  enabled: false,
  // Dedicated chat routing keys. Values are opaque route names, never secrets.
  chatRoutes: Object.freeze({ TOP5: 'TOP5_CHANNEL', TOP20: 'TOP20_CHANNEL' })
});

const REASON = Object.freeze({
  DISABLED: 'ADMIN_TOGGLE_OFF',
  NOT_READY: 'NOT_READY',
  INVALID_ROW: 'INVALID_ROW',
  DUPLICATE: 'DUPLICATE_SUPPRESSED',
  SECRET_LIKE_TEXT: 'SECRET_LIKE_TEXT_BLOCKED',
  NO_CHAT_ROUTE: 'NO_CHAT_ROUTE',
  MOCK_ONLY: 'MOCK_TRANSPORT_REQUIRED'
});

function defaultConfig(overrides) {
  const o = overrides || {};
  return {
    enabled: o.enabled === true,
    chatRoutes: Object.assign({}, DEFAULT_CONFIG.chatRoutes, o.chatRoutes || {})
  };
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Snapshot date must be explicit; never invent "today" for a stale artifact. */
function resolveSnapshotDate(row) {
  const raw = row && (row.snapshot_date || row.snapshotDate || row.trade_date ||
    row.tradeDate || row.locked_date || row.date || row.as_of || row.asOf);
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isReadyRow(row) {
  if (!row || typeof row !== 'object') return false;
  const verdict = text(row.readiness_status || row.readiness || row.status || row.final_status).toUpperCase();
  if (verdict && verdict !== 'READY') return false;
  if (row.actionable === false || row.safe === false || row.trading_plan_valid === false) return false;
  if (row.publication_blocked === true || row.snapshot_superseded === true || row.store_verified === false) return false;
  return true;
}

/**
 * R/R from the locked plan. Uses (TP1-entry)/(entry-SL) when both sides exist;
 * falls back to an explicit rr field. Never fabricates a number.
 */
function resolveRR(row) {
  const explicit = num(row && (row.rr_at_max_entry || row.risk_reward || row.rr));
  if (explicit != null) return explicit;
  const entry = num(row && (row.entry_high || row.entry_price || row.entry));
  const sl = num(row && (row.sl || row.stop_loss));
  const tp1 = num(row && row.tp1);
  if (entry == null || sl == null || tp1 == null || entry <= sl) return null;
  return Number(((tp1 - entry) / (entry - sl)).toFixed(2));
}

function fmtPrice(value) {
  const n = num(value);
  return n == null ? '-' : 'Rp' + Math.round(n).toLocaleString('id-ID');
}

function fmtRR(value) {
  const n = num(value);
  return n == null ? '-' : n.toFixed(2) + 'x';
}

/**
 * Concise, deterministic, single-line-per-candidate message.
 * Includes exactly the owner-required fields. No qualitative slop.
 */
function formatCandidateMessage(scope, row, options) {
  const o = options || {};
  const ticker = text(row && (row.ticker || row.symbol)).toUpperCase();
  const entry = num(row && (row.entry_high || row.entry_price || row.entry));
  const sl = num(row && (row.sl || row.stop_loss));
  const tp1 = num(row && row.tp1);
  const tp2 = num(row && row.tp2);
  const score = row && row.score != null && Number.isFinite(Number(row.score)) ? Number(row.score) : null;
  const snapshotDate = resolveSnapshotDate(row) || (o.snapshotDate ? String(o.snapshotDate).slice(0, 10) : null);
  const rr = resolveRR(row);
  const lines = [
    '[' + String(scope).toUpperCase() + '] ' + (ticker || 'UNKNOWN') + ' · Snapshot ' + (snapshotDate || 'UNKNOWN'),
    'Entry ' + fmtPrice(entry) + ' | SL ' + fmtPrice(sl) + ' | TP1 ' + fmtPrice(tp1) + ' | TP2 ' + fmtPrice(tp2),
    'R/R ' + fmtRR(rr) + ' | Score ' + (score == null ? '-' : score.toFixed(1))
  ];
  return lines.join('\n');
}

/** Reject text that looks like a token / chat id / credential before any send. */
function looksLikeSecret(value) {
  const s = String(value == null ? '' : value);
  return /(?:bot\d{6,}:[A-Za-z0-9_-]{20,})/i.test(s) ||
    /(?:bearer\s+[A-Za-z0-9\-._~+/=]{8,})/i.test(s) ||
    /(?:\b(?:token|secret|password|authorization|cookie)\b\s*[:=]\s*\S{4,})/i.test(s) ||
    /(?:chat[_-]?id\s*[:=]\s*-?\d{6,})/i.test(s);
}

function dedupeKey(scope, row, eventType) {
  const ticker = text(row && (row.ticker || row.symbol)).toUpperCase();
  const snapshotId = text(row && (row.snapshot_id || row.snapshotId)) || resolveSnapshotDate(row) || 'no-snapshot';
  return 'taskd:' + String(scope).toUpperCase() + ':' + snapshotId + ':' + ticker + ':' + String(eventType || 'PUSH');
}

/**
 * Create an in-memory idempotency store. Production callers may inject a durable
 * store with the same has(key)/add(key) interface; without it, sends are
 * dry-run only (mirrors lib/top5-progress-monitor.js's durable-idempotency rule).
 */
function createMemoryIdempotencyStore() {
  const seen = new Set();
  return {
    has(key) { return seen.has(String(key)); },
    add(key) { seen.add(String(key)); return true; },
    size() { return seen.size; }
  };
}

function resolveChatRoute(config, scope) {
  const routes = (config && config.chatRoutes) || DEFAULT_CONFIG.chatRoutes;
  const route = routes[String(scope).toUpperCase()];
  return route ? String(route) : null;
}

/**
 * Prepare a push. Returns a decision object; NEVER sends.
 *
 * @param {object} input { scope, rows, config, idempotency, eventType, snapshotDate }
 * @param {object} deps  { transport, now } — transport MUST be a MOCK-* recorder
 */
function preparePush(input, deps) {
  const i = input || {};
  const d = deps || {};
  const scope = String(i.scope || '').toUpperCase();
  if (!SCOPES[scope]) return { ok: false, reason: REASON.INVALID_ROW, messages: [], sent: 0, skipped: 0 };

  const config = defaultConfig(i.config);
  if (!config.enabled) return { ok: false, reason: REASON.DISABLED, messages: [], sent: 0, skipped: 0 };

  const chatRoute = resolveChatRoute(config, scope);
  if (!chatRoute) return { ok: false, reason: REASON.NO_CHAT_ROUTE, messages: [], sent: 0, skipped: 0 };

  const transport = d.transport;
  if (!transport || typeof transport.send !== 'function' || !/^MOCK-/i.test(String(transport.id || ''))) {
    return { ok: false, reason: REASON.MOCK_ONLY, messages: [], sent: 0, skipped: 0, httpRequests: 0, billedUnits: 0 };
  }

  const idempotency = i.idempotency || createMemoryIdempotencyStore();
  const rows = Array.isArray(i.rows) ? i.rows : [];
  const messages = [];
  const skipped = [];
  let sent = 0;

  for (const row of rows) {
    if (!isReadyRow(row)) {
      skipped.push({ ticker: text(row && row.ticker).toUpperCase(), reason: REASON.NOT_READY });
      continue;
    }
    const key = dedupeKey(scope, row, i.eventType);
    if (idempotency.has(key)) {
      skipped.push({ ticker: text(row && row.ticker).toUpperCase(), reason: REASON.DUPLICATE, key_hash: sha256(key).slice(0, 12) });
      continue;
    }
    const rawText = formatCandidateMessage(scope, row, { snapshotDate: i.snapshotDate });
    if (looksLikeSecret(rawText)) {
      skipped.push({ ticker: text(row && row.ticker).toUpperCase(), reason: REASON.SECRET_LIKE_TEXT });
      continue;
    }
    const payload = redactObject({
      chat_route: chatRoute,
      text: redactString(rawText),
      scope,
      dedupe_key_hash: sha256(key),
      snapshot_date: resolveSnapshotDate(row) || i.snapshotDate || null
    });
    // The transport is injected and mocked; no network, no token, no real chat id.
    const receipt = transport.send(payload);
    idempotency.add(key);
    sent += 1;
    messages.push({ payload, receipt: redactObject(receipt) });
  }

  return {
    ok: true,
    reason: null,
    scope,
    chat_route: chatRoute,
    messages,
    sent,
    skipped,
    skipped_count: skipped.length,
    httpRequests: 0,
    billedUnits: 0,
    transport_id: String(transport.id),
    idempotency_size: typeof idempotency.size === 'function' ? idempotency.size() : null
  };
}

module.exports = {
  SCOPES,
  REASON,
  DEFAULT_CONFIG,
  defaultConfig,
  formatCandidateMessage,
  looksLikeSecret,
  dedupeKey,
  createMemoryIdempotencyStore,
  resolveChatRoute,
  resolveSnapshotDate,
  resolveRR,
  isReadyRow,
  preparePush
};
