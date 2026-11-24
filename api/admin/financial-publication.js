'use strict';

/**
 * api/admin/financial-publication.js
 * ============================================================================
 * V6 W3 — ADMIN ENDPOINT for the financial publication monitor.
 * ============================================================================
 * AUTH / CSRF (matches api/admin/quota-settings.js and schedule-settings.js):
 *   - GET  requires a signed admin session (`requireAdminSession`).
 *   - POST requires `isSameOrigin(req)` AND `requireAdminSession(req)`.
 *   - The actor is ALWAYS the server-signed `session.uid` (+ `session.un`);
 *     any client-supplied actor is ignored.
 *
 * GET  ?view=status|pending|missing[&ticker=...]
 *   - status  : every tracked issuer-period record
 *   - pending : records that are DUE / PENDING / MISSING_RETRY / REVISION_DETECTED
 *   - missing : records in MISSING_RETRY / UPSTREAM_UNAVAILABLE
 *
 * POST actions (all audited, append-only):
 *   - set_anchor        { ticker, fiscal_year, fiscal_year_end }
 *   - set_interval      { retry_interval_days }
 *   - force_check       { ticker, fiscal_year, period }
 *   - retry             { ticker, fiscal_year, period }
 *   - mark_revision     { ticker, fiscal_year, period, checksum }
 *
 * This endpoint NEVER calls a provider. It only reads/writes local state and
 * appends to the audit log.
 * ============================================================================
 */

const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const monitor = require('../../lib/financial-publication-monitor');
const adminStore = require('../../lib/admin-schedule-store');
const windowStore = require('../../lib/financial-window-store');
const incompleteStore = require('../../lib/financial-incomplete-store');
const manualFetch = require('../../lib/financial-manual-fetch');

function json(res, code, body) {
  try {
    res.statusCode = code;
    if (res && typeof res === 'object') res.body = body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(body));
  } catch (_) { /* ignore */ }
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

function flattenRecords(state) {
  const out = [];
  const issuers = (state && state.issuers) || {};
  for (const ticker of Object.keys(issuers)) {
    const byYear = issuers[ticker] || {};
    for (const year of Object.keys(byYear)) {
      const recs = byYear[year];
      if (Array.isArray(recs)) out.push.apply(out, recs);
    }
  }
  return out;
}

function actorOf(session) {
  return {
    id: (session && (session.uid || session.user_id)) || 'UNKNOWN_ADMIN',
    name: (session && (session.un || session.username)) || null
  };
}

function findRecord(state, ticker, fiscalYear, period) {
  const t = String(ticker || '').trim().toUpperCase();
  const y = String(Number(fiscalYear));
  const recs = (state.issuers && state.issuers[t] && state.issuers[t][y]) || [];
  return recs.find(function (r) { return r.period === period; }) || null;
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();

  if (method === 'GET') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

    const loaded = monitor.loadState();
    if (!loaded.ok) return json(res, 500, { success: false, error: 'Gagal membaca state: ' + loaded.error });

    const url = new URL(req.url || '/', 'http://localhost');
    const view = String(url.searchParams.get('view') || 'status').toLowerCase();
    const tickerFilter = url.searchParams.get('ticker');

    let records = flattenRecords(loaded.state);
    if (tickerFilter) {
      const t = String(tickerFilter).trim().toUpperCase();
      records = records.filter(function (r) { return r.ticker === t; });
    }

    if (view === 'pending') {
      records = records.filter(function (r) {
        return r.status === monitor.STATUS.DUE ||
          r.status === monitor.STATUS.PENDING ||
          r.status === monitor.STATUS.MISSING_RETRY ||
          r.status === monitor.STATUS.REVISION_DETECTED;
      });
    } else if (view === 'missing') {
      records = records.filter(function (r) {
        return r.status === monitor.STATUS.MISSING_RETRY ||
          r.status === monitor.STATUS.UPSTREAM_UNAVAILABLE;
      });
    }

    const sched = adminStore.readStore();
    const fundJob = (sched.ok && sched.doc && sched.doc.jobs && sched.doc.jobs.fundamental) || null;

    // TASK C: quarterly fetch windows (admin-editable, versioned) and the
    // separate incomplete-issuer state store. Both are read-only here.
    const windows = windowStore.get();
    const incomplete = incompleteStore.list({
      ticker: tickerFilter || undefined,
      openOnly: view !== 'incomplete_all'
    });

    return json(res, 200, {
      success: true,
      view,
      retryIntervalDays: loaded.state.retryIntervalDays,
      count: records.length,
      records,
      schedule_governance: {
        job_key: 'fundamental',
        enabled: fundJob ? fundJob.enabled : false,
        timeWIB: fundJob ? fundJob.timeWIB : '23:00',
        retryWindowMinutes: fundJob ? fundJob.retryWindowMinutes : 15,
        costClass: fundJob ? fundJob.costClass : 'MEDIUM'
      },
      fetch_windows: windows.ok ? {
        version: windows.doc.version,
        updatedAt: windows.doc.updatedAt,
        updatedBy: windows.doc.updatedBy,
        periods: windows.doc.periods
      } : null,
      incomplete_issuers: incomplete.ok ? {
        version: incomplete.doc.version,
        count: incomplete.entries.length,
        entries: incomplete.entries
      } : null
    });
  }

  if (method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  if (!isSameOrigin(req)) {
    return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
  }
  const auth = requireAdminSession(req);
  if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

  const body = req.body !== undefined || req._parsedBody !== undefined ? req.body : await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { success: false, error: 'JSON body harus berupa object.' });
  }
  const action = String(body.action || '').trim();
  const actor = actorOf(auth.session);

  const loaded = monitor.loadState();
  if (!loaded.ok) return json(res, 500, { success: false, error: 'Gagal membaca state: ' + loaded.error });
  const state = loaded.state;

  function audit(entry) {
    monitor.appendAudit(Object.assign({
      eventType: 'FINANCIAL_PUBLICATION_ADMIN',
      severity: 'INFO',
      actor: actor,
      ip: (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '127.0.0.1'
    }, entry));
  }

  if (action === 'set_interval') {
    const days = Number(body.retry_interval_days);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return json(res, 400, { success: false, error: 'retry_interval_days harus 1..365' });
    }
    const prev = state.retryIntervalDays;
    state.retryIntervalDays = Math.round(days);
    monitor.saveState(state);
    // Also sync retry window into admin schedule store if fundamental job exists
    try {
      const actor = actorOf(auth.session);
      adminStore.put({ jobs: { fundamental: { retryWindowMinutes: Math.min(120, Math.max(5, Math.round(days * 2))) } } }, actor, { comment: 'Update financial retry interval' });
    } catch (_) {}
    audit({ action, prev, next: state.retryIntervalDays });
    return json(res, 200, { success: true, retryIntervalDays: state.retryIntervalDays });
  }

  if (action === 'toggle_monitoring') {
    const enabled = body.enabled === true;
    const actor = actorOf(auth.session);
    try {
      adminStore.put({ jobs: { fundamental: { enabled } } }, actor, { comment: 'Toggle financial publication monitoring' });
    } catch (_) {}
    audit({ action, enabled });
    return json(res, 200, { success: true, monitoring_enabled: enabled });
  }

  if (action === 'set_anchor') {
    const ticker = String(body.ticker || '').trim().toUpperCase();
    const fiscalYear = Number(body.fiscal_year);
    const fiscalYearEnd = String(body.fiscal_year_end || '').trim();
    const validYearEnd = /^\d{2}-\d{2}$/.test(fiscalYearEnd) &&
      require('../../lib/insider-source-visibility').validDay(String(fiscalYear).padStart(4, '0') + '-' + fiscalYearEnd);
    if (!ticker || !Number.isInteger(fiscalYear) || !validYearEnd) {
      return json(res, 400, { success: false, error: 'ticker, fiscal_year, fiscal_year_end (MM-DD) wajib' });
    }
    const existing = {};
    const prior = (state.issuers[ticker] && state.issuers[ticker][String(fiscalYear)]) || [];
    for (const r of prior) existing[monitor.recordKey(r)] = r;
    const records = monitor.buildRecordsForIssuer({ ticker, fiscalYear, fiscalYearEnd, existing });
    state.issuers[ticker] = state.issuers[ticker] || {};
    state.issuers[ticker][String(fiscalYear)] = records;
    monitor.saveState(state);
    audit({ action, ticker, fiscalYear, fiscalYearEnd, count: records.length });
    return json(res, 200, { success: true, ticker, fiscalYear, records });
  }

  if (action === 'force_check' || action === 'retry') {
    const ticker = String(body.ticker || '').trim().toUpperCase();
    const fiscalYear = Number(body.fiscal_year);
    const period = String(body.period || '').trim().toUpperCase();
    const rec = findRecord(state, ticker, fiscalYear, period);
    if (!rec) return json(res, 404, { success: false, error: 'Record tidak ditemukan' });
    const now = new Date().toISOString().slice(0, 10);
    rec.status = monitor.STATUS.DUE;
    rec.next_check_at = now;
    monitor.saveState(state);
    audit({ action, ticker, fiscalYear, period, status: rec.status });
    return json(res, 200, { success: true, record: rec });
  }

  if (action === 'mark_revision') {
    const ticker = String(body.ticker || '').trim().toUpperCase();
    const fiscalYear = Number(body.fiscal_year);
    const period = String(body.period || '').trim().toUpperCase();
    const checksum = body.checksum ? String(body.checksum) : null;
    const rec = findRecord(state, ticker, fiscalYear, period);
    if (!rec) return json(res, 404, { success: false, error: 'Record tidak ditemukan' });
    const result = monitor.detectRevision(rec, checksum || 'FORCED_REVISION');
    if (!result.revision) {
      // Force a reopen even if no prior checksum exists.
      rec.status = monitor.STATUS.REVISION_DETECTED;
      rec.next_check_at = new Date().toISOString().slice(0, 10);
    } else {
      Object.assign(rec, result.record);
    }
    monitor.saveState(state);
    audit({ action, ticker, fiscalYear, period, checksum, status: rec.status });
    return json(res, 200, { success: true, record: rec });
  }

  // ── TASK C actions ────────────────────────────────────────────────────────
  // All below are state-changing and already passed same-origin + admin auth.

  if (action === 'set_fetch_windows') {
    const expectedVersion = body.expectedVersion != null ? Number(body.expectedVersion) :
      (body.version != null ? Number(body.version) : null);
    const result = windowStore.put(body.periods ? { periods: body.periods } : body, {
      actor: actor.id, reason: body.reason || 'Update quarterly fetch windows',
      expectedVersion, now: new Date()
    });
    if (!result.ok) {
      if (result.reason === 'VALIDATION_FAILED') return json(res, 400, { success: false, error: 'Window tidak valid.', details: result.errors });
      if (result.reason === 'CONFLICT') return json(res, 409, { success: false, error: 'Versi window berubah.', code: 'CONFIG_VERSION_CONFLICT', version: result.currentVersion, config: result.doc });
      if (result.reason === 'LOCK_BUSY') return json(res, 503, { success: false, error: 'Config sedang dipakai proses lain.' });
      return json(res, 500, { success: false, error: 'Gagal menyimpan window.', code: result.reason });
    }
    audit({ action, version: result.version, periods: result.doc.periods });
    return json(res, 200, { success: true, version: result.version, readbackOk: result.readbackOk, periods: result.doc.periods });
  }

  if (action === 'set_incomplete') {
    const result = incompleteStore.upsert(body, { actor: actor.id, reason: body.reason || 'Observed incomplete issuer', now: new Date() });
    if (!result.ok) {
      if (result.reason === 'VALIDATION_FAILED') return json(res, 400, { success: false, error: 'Entry tidak valid.', details: result.errors });
      if (result.reason === 'LOCK_BUSY') return json(res, 503, { success: false, error: 'State sedang dipakai proses lain.' });
      return json(res, 500, { success: false, error: 'Gagal menyimpan incomplete issuer.', code: result.reason });
    }
    audit({ action, ticker: result.entry.ticker, fiscal_year: result.entry.fiscal_year, period: result.entry.period, status: result.entry.status });
    return json(res, 200, { success: true, version: result.version, readbackOk: result.readbackOk, entry: result.entry });
  }

  if (action === 'manual_fetch') {
    // The transport is injected by the isolated test harness via req.mockedTransport.
    // In production there is NO transport, so this action is always BLOCKED —
    // zero live provider calls by construction.
    const transport = req.mockedTransport || null;
    const result = await manualFetch.runManualFetch({
      ticker: body.ticker,
      fiscal_year: body.fiscal_year,
      period: body.period,
      attemptId: body.attemptId,
      deadline: body.deadline,
      transport,
      actor: actor.id
    }, { now: new Date(), actor: actor.id });
    audit({
      action, ticker: body.ticker, fiscal_year: body.fiscal_year, period: body.period,
      outcome: result.outcome, reason: result.reason || null,
      httpRequests: result.httpRequests, billedUnits: result.billedUnits,
      transport: result.transport || null
    });
    if (!result.ok) {
      const code = result.reason === 'INVALID_TARGET' || result.reason === 'TRANSPORT_REQUIRED' ||
        result.reason === 'LIVE_TRANSPORT_REJECTED' ? 400 : 409;
      return json(res, code, { success: false, error: result.reason, outcome: result.outcome, httpRequests: 0, billedUnits: 0 });
    }
    return json(res, 200, Object.assign({ success: true }, result));
  }

  return json(res, 400, { success: false, error: 'Aksi tidak dikenal: ' + action });
}

module.exports = handler;
module.exports.handler = handler;
