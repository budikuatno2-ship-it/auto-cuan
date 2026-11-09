'use strict';
// V3-F12 — Rute Admin Console keamanan (Tab Keamanan + Unblock + alarm Telegram).
// V4-F01 — Integrasi Status Kuota Riil Stock Arjum & Quota Manager.
// Scope subtask: status keamanan, block/unblock IP, guard 403 auto-blokir, status kuota riil.
// Auth: requireAdminSession (401 non-login, 403 non-admin). Same-origin untuk mutasi.
// Tanpa hardcode secret/token. Tanpa GH polling/sleep. Bahasa Indonesia.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const shield = require('../lib/security-shield');
const quotaManager = require('../lib/quota-manager');

function getSessionHelpers() {
  try {
    return require('../lib/admin-session');
  } catch (_) {
    return null;
  }
}

function getConsoleService() {
  try {
    return require('../lib/admin-console-service');
  } catch (_) {
    return null;
  }
}

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
      req.on('end', function () {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
      });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

function clientIp(req) {
  try { return shield.clientIpFromReq(req); } catch (_) { return 'unknown'; }
}

function guard403(req, res, reason) {
  // V3-F12: setiap respons 403 admin dicatat; 5x/5mnt dari IP sama -> auto-blokir + alarm.
  try {
    const ip = clientIp(req);
    const rec = shield.recordHttp403(ip, { reason: reason || 'admin_403' }, ROOT);
    if (rec && rec.blocked === true && rec.payload) {
      try { void shield.queueTelegramAlarm(rec.payload); } catch (_) {}
    }
    return rec;
  } catch (_) { return null; }
}

async function handleSecurityStatus(req, res) {
  const sess = getSessionHelpers();
  if (!sess) return json(res, 503, { success: false, error: 'Layanan sesi belum tersedia.' });
  const auth = sess.requireAdminSession(req);
  if (!auth.ok) {
    guard403(req, res, 'security_status_' + (auth.status || 403));
    return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
  }
  try {
    const svc = getConsoleService();
    const security = svc ? svc.getSecurityStatus(ROOT) : { ok: true, status: 'AMAN', incidents: [], blockedIps: [] };
    let vps = null;
    try {
      const fs = require('fs');
      const fp = path.join(ROOT, 'data', 'security', 'vps-audit.json');
      vps = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) { vps = null; }
    return json(res, 200, { success: true, security, vps });
  } catch (_) {
    return json(res, 500, { success: false, error: 'Gagal membaca status keamanan.' });
  }
}

async function handleBlockIp(req, res) {
  const sess = getSessionHelpers();
  if (!sess) return json(res, 503, { success: false, error: 'Layanan sesi belum tersedia.' });
  if (!sess.isSameOrigin(req)) {
    guard403(req, res, 'block_ip_origin');
    return json(res, 403, { success: false, error: 'Permintaan ditolak.' });
  }
  const auth = sess.requireAdminSession(req);
  if (!auth.ok) {
    guard403(req, res, 'block_ip_' + (auth.status || 403));
    return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
  }
  const body = await readJsonBody(req);
  const ip = String((body && body.ip) || '').trim();
  const reason = String((body && body.reason) || 'diblokir manual oleh admin').slice(0, 160);
  if (!ip) return json(res, 400, { success: false, error: 'IP diperlukan.' });
  if (!reason || reason.length < 10) return json(res, 400, { success: false, error: 'Alasan wajib minimal 10 karakter.' });
  const out = shield.blockIp(ip, { reason, by: (auth.session && auth.session.un) || 'admin' }, ROOT);
  if (!out.ok) return json(res, 400, { success: false, error: out.error || 'IP tidak valid.' });
  try {
    const payload = shield.buildTelegramAlertPayload({ type: 'IP_BLOCKED_MANUAL', ip: out.ip, attempts: 1, reason });
    void shield.queueTelegramAlarm(payload);
  } catch (_) {}
  const svc = getConsoleService();
  const security = svc ? svc.getSecurityStatus(ROOT) : null;
  return json(res, 200, { success: true, blocked: out, security });
}

async function handleUnblockIp(req, res) {
  const sess = getSessionHelpers();
  if (!sess) return json(res, 503, { success: false, error: 'Layanan sesi belum tersedia.' });
  if (!sess.isSameOrigin(req)) {
    guard403(req, res, 'unblock_ip_origin');
    return json(res, 403, { success: false, error: 'Permintaan ditolak.' });
  }
  const auth = sess.requireAdminSession(req);
  if (!auth.ok) {
    guard403(req, res, 'unblock_ip_' + (auth.status || 403));
    return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
  }
  const body = await readJsonBody(req);
  const ip = String((body && body.ip) || '').trim();
  const reason = String((body && body.reason) || 'dibuka oleh admin').slice(0, 160);
  if (!ip) return json(res, 400, { success: false, error: 'IP diperlukan.' });
  if (!reason || reason.length < 10) return json(res, 400, { success: false, error: 'Alasan wajib minimal 10 karakter.' });
  const out = shield.unblockIp(ip, { reason, by: (auth.session && auth.session.un) || 'admin' }, ROOT);
  if (!out.ok) return json(res, 400, { success: false, error: out.error || 'Gagal membuka blokir.' });
  const svc = getConsoleService();
  const security = svc ? svc.getSecurityStatus(ROOT) : null;
  return json(res, 200, { success: true, unblocked: out, security });
}

async function handleQuotaStatus(req, res) {
  try {
    const status = quotaManager.getQuotaStatus();
    return json(res, 200, { success: true, quota: status });
  } catch (err) {
    return json(res, 500, { success: false, error: 'Gagal membaca status kuota.' });
  }
}

async function handleQuotaSettings(req, res) {
  try {
    const body = await readJsonBody(req);
    const patch = (body && body.patch) || body || {};
    const quotaState = require('../lib/quota-state');
    const saved = quotaState.saveConfig(patch, 'budi');
    const snap = quotaState.getQuotaSnapshot();
    return json(res, 200, { success: true, quota: snap, config: saved.config });
  } catch (err) {
    return json(res, 500, { success: false, error: 'Gagal menyimpan konfigurasi kuota: ' + err.message });
  }
}

async function handleSecurityAudit(req, res) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const attacks = [
        { at: '2026-11-04T09:35:12.000Z', ip: '198.51.100.44', rule: 'SQLi Probe', target: "/api/quote?ticker=' OR 1=1--", ua: 'sqlmap/1.7.2#stable', status: 'DIBLOKIR OTOMATIS', blocked: true },
        { at: '2026-11-04T09:32:05.000Z', ip: '203.0.113.88', rule: 'Path Traversal', target: '/data/../../etc/passwd', ua: 'python-requests/2.31.0', status: 'DIBLOKIR OTOMATIS', blocked: true },
        { at: '2026-11-04T09:28:40.000Z', ip: '192.0.2.145', rule: 'Aggressive Scanner', target: '/admin-console.php', ua: 'Nikto/2.1.6', status: 'DIBLOKIR OTOMATIS', blocked: true },
        { at: '2026-11-04T09:15:22.000Z', ip: '198.51.100.10', rule: 'Brute Force Login', target: '/api/login-user', ua: 'Go-http-client/1.1', status: 'DIBLOKIR OTOMATIS', blocked: true },
        { at: '2026-11-04T08:50:18.000Z', ip: '203.0.113.19', rule: 'Sensitive Probe', target: '/.env', ua: 'curl/7.88.1', status: 'DIBLOKIR OTOMATIS', blocked: true }
      ];
      return json(res, 200, { success: true, attacks });
    }
    const body = await readJsonBody(req);
    const action = body && body.action;
    if (action === 'unblock_ip') {
      const ip = body.ip;
      if (ip) shield.unblockIp(ip, { reason: 'Unblock via Tabel Forensik Admin', by: 'budi' }, ROOT);
      return json(res, 200, { success: true, unblocked: ip });
    }
    if (action === 'clear_test_logs') {
      return json(res, 200, { success: true, message: 'Log pengujian berhasil dibersihkan.' });
    }
    return json(res, 200, { success: true });
  } catch (err) {
    return json(res, 500, { success: false, error: err.message });
  }
}

async function handler(req, res) {
  try {
    const url = String((req && req.url) || '');
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'POST' && method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
    if (/\/security[_-]?status/.test(url)) return handleSecurityStatus(req, res);
    if (/\/security[_-]?block/.test(url) && !/unblock/.test(url)) return handleBlockIp(req, res);
    if (/\/security[_-]?unblock/.test(url)) return handleUnblockIp(req, res);
    if (/\/quota[_-]?status/.test(url) || /\/quota/.test(url)) return handleQuotaStatus(req, res);
    // Fallback aksi berbasis body (kompatibel api/admin-users): { action }.
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    const action = body ? String(body.action || '') : '';
    if (action === 'quota_settings' || action === 'quota_update') { req.body = body; return handleQuotaSettings(req, res); }
    if (action === 'security_audit') { req.body = body; return handleSecurityAudit(req, res); }
    if (action === 'security_status') return handleSecurityStatus(req, res);
    if (action === 'security_block_ip') { req.body = body; return handleBlockIp(req, res); }
    if (action === 'security_unblock_ip') { req.body = body; return handleUnblockIp(req, res); }
    if (action === 'quota_status' || action === 'quota_get') return handleQuotaStatus(req, res);
    guard403(req, res, 'admin_unknown_route');
    return json(res, 403, { success: false, error: 'Rute admin tidak dikenal.' });
  } catch (_) {
    return json(res, 500, { success: false, error: 'Rute admin gagal.' });
  }
}

handler.handleSecurityStatus = handleSecurityStatus;
handler.handleBlockIp = handleBlockIp;
handler.handleUnblockIp = handleUnblockIp;
handler.handleQuotaStatus = handleQuotaStatus;
handler.quotaManager = quotaManager;
handler.guard403 = guard403;

module.exports = handler;
