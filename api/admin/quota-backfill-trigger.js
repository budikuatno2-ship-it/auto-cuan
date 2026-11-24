'use strict';

/**
 * api/admin/quota-backfill-trigger.js
 * ============================================================================
 * V6 (Subtask C) — Real backfill trigger endpoint (worker consumer).
 * Corrects audit finding #5: the button recording-only placebo now enqueues
 * into a durable trigger queue and drains it through a real consumer.
 *
 * PRODUCTION SAFETY
 *   - POST requires same-origin + signed admin session.
 *   - Real execution (`allowExecute`) is enabled ONLY for staging/fixture/test
 *     (i.e. NEVER when NODE_ENV === 'production'). In production the trigger is
 *     enqueued and drained idempotently but `executed:false` (no upstream burn).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const worker = require('../../lib/quota-queue-worker');
const backfillDecision = require('../../lib/backfill-decision');

function json(res, code, body) {
  try {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(body));
  } catch (_) {}
}

function readJsonBody(req) {
  return new Promise(function (resolve) {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let raw = '';
      req.on('data', function (c) { raw += String(c); if (raw.length > 65536) { try { req.destroy(); } catch (_) {} } });
      req.on('end', function () { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

function isProduction() {
  const env = String(process.env.NODE_ENV || '');
  return env === 'production' || process.env.VERCEL_ENV === 'production';
}

function isStaging() {
  const env = String(process.env.NODE_ENV || '');
  const v = String(process.env.VERCEL_ENV || '');
  return /staging|preview|test|development/i.test(env) || /staging|preview|development/i.test(v);
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();

  // GET status: admin session required.
  if (method === 'GET') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
    return json(res, 200, {
      success: true,
      worker: worker.getWorkerStatus(),
      backfillStatus: backfillDecision.readBackfillStatus()
    });
  }

  if (method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  // State-changing: same-origin + signed admin.
  if (!isSameOrigin(req)) return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
  const auth = requireAdminSession(req);
  if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

  let body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = await readJsonBody(req);

  const actor = String((auth.session && auth.session.un) || (auth.session && auth.session.uid) || 'admin');
  const reason = String((body && body.reason) || 'manual-backfill').trim();

  // W5 CONDITIONAL BACKFILL GATE — computed from REAL files/state BEFORE any
  // enqueue or provider call. The decision is persisted atomically to
  // data/backfill-status.json so the Admin UI reads EFFECTIVE state.
  const gateInputs = backfillDecision.collectBackfillInputs({
    // Admin may override the pause flag via the request body (pause/resume).
    paused: body && typeof body.paused === 'boolean' ? body.paused : undefined
  });
  const gate = worker.evaluateBackfillGate(gateInputs, { actor, trigger: 'admin-manual' });
  const decision = gate.decision;

  // V6 (Subtask E): H) dry-run preview FIRST — no enqueue, no state change,
  // no execution. The admin button calls this before the real trigger.
  if (body && body.dryRun === true) {
    const preview = worker.previewBackfill({ reason });
    return json(res, 200, {
      success: true,
      ok: true,
      dryRun: true,
      preview,
      decision,
      productionGated: isProduction(),
      honestStatus: isProduction() ? 'WAITING_APPROVAL' : 'READY_TO_EXECUTE_IN_STAGING'
    });
  }

  // IDLE / BLOCKED / PAUSED / NEEDS_EVIDENCE => ZERO provider requests.
  // We still enqueue nothing and return the honest decision to the admin.
  if (decision.status !== backfillDecision.DECISIONS.RUN_VERIFIED_GAP) {
    return json(res, 200, {
      success: true,
      ok: true,
      executed: false,
      requestsSent: 0,
      decision,
      status: decision.status,
      reason: decision.reason,
      nextCheckAt: decision.next_check_at,
      productionGated: isProduction(),
      queueState: decision.status
    });
  }

  const enqueued = worker.enqueueBackfill({ reason, actor });

  // Real execution ONLY in staging/fixture/test. In production the trigger is
  // enqueued and drained ONLY up to APPROVED (WAITING_APPROVAL, honest):
  // queued work is NEVER deleted and never fake-marked processed.
  const allowExecute = isStaging() && !isProduction();
  const executor = allowExecute ? worker.defaultExecutor : null;
  const drained = worker.consumeBackfillQueue({ allowExecute, execute: executor, decision });

  return json(res, 200, {
    success: true,
    ok: true,
    enqueued: enqueued.id,
    status: enqueued.status,
    decision,
    allowExecute,
    productionGated: isProduction(),
    // Honest queue semantics (V6): processed counts ONLY readback-verified
    // executions. In production processed stays 0 and the job remains pending.
    processed: drained.processed,
    executed: drained.executed,
    blocked: drained.blocked,
    retryWait: drained.retryWait,
    pending: drained.pending,
    queueState: allowExecute ? (drained.executed > 0 ? 'EXECUTED_AND_READBACK_VERIFIED' : 'PENDING') : 'WAITING_APPROVAL',
    worker: drained.ledger
  });
}

module.exports = handler;
module.exports.handler = handler;
module.exports.isProduction = isProduction;
module.exports.isStaging = isStaging;