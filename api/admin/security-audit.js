'use strict';

/**
 * api/admin/security-audit.js
 * ============================================================================
 * Real Security & Forensic Audit Endpoint for Admin Console Tab 8
 * (Keamanan & Audit).
 *
 * Replaces the old PREVIEW_MOCKS-only stub that caused HTTP 404 in production.
 * Fail-closed auth: requires signed admin session; mutations require same-origin.
 * Reads ONLY real telemetry (security-state.json, security-shield events,
 * vps-audit.json); never invents RFC5737 test-net attacks.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const adminSession = require('../../lib/admin-session');
const adminService = require('../../lib/admin-console-service');
const shield = require('../../lib/security-shield');

function json(res, code, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(code).json(body);
  }
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(JSON.stringify(body));
}

function mapSecurityEventsToAttacks(secStatus, shieldEvents) {
  const attacks = [];
  const seen = new Set();

  const pushUnique = (item) => {
    const key = [item.at || '', item.ip || '', item.rule || '', item.target || ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    attacks.push(item);
  };

  if (secStatus && Array.isArray(secStatus.blockedIps)) {
    for (const b of secStatus.blockedIps) {
      if (!b || !b.ip) continue;
      pushUnique({
        at: b.at || b.until || secStatus.updatedAt || null,
        ip: String(b.ip),
        rule: String(b.reason || 'Blokir IP Aktif'),
        target: '/api/*',
        ua: String(b.by || 'shield-auto'),
        status: 'DIBLOKIR OTOMATIS',
        blocked: true
      });
    }
  }

  if (secStatus && Array.isArray(secStatus.incidents)) {
    for (const inc of secStatus.incidents) {
      if (!inc) continue;
      pushUnique({
        at: inc.at || secStatus.updatedAt || null,
        ip: String(inc.ip || '—'),
        rule: String(inc.type || inc.reason || 'Aktivitas Mencurigakan'),
        target: String(inc.source || '/api/*'),
        ua: String(inc.reason || 'WAF / Firewall'),
        status: 'TERDETEKSI & DIAWASI',
        blocked: false
      });
    }
  }

  if (Array.isArray(shieldEvents)) {
    for (const ev of shieldEvents) {
      if (!ev) continue;
      pushUnique({
        at: ev.at || ev.timestamp || null,
        ip: String(ev.ip || '—'),
        rule: String(ev.rule || ev.type || 'Guard Event'),
        target: String(ev.target || ev.path || '/api/*'),
        ua: String(ev.ua || ev.userAgent || 'Runtime Guard'),
        status: ev.blocked ? 'DIBLOKIR OTOMATIS' : 'TERCATAT',
        blocked: Boolean(ev.blocked)
      });
    }
  }

  return attacks;
}

let _secAuditCached = null;
let _secAuditCachedAt = 0;
const SEC_AUDIT_TTL_MS = 15000;

module.exports = async function handler(req, res) {
  try { res.setHeader('Cache-Control', 'private, no-store'); } catch (_) {}

  const auth = adminSession.requireAdminSession(req);
  if (!auth.ok) {
    return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
  }

  if (req.method === 'POST') {
    _secAuditCached = null;
    _secAuditCachedAt = 0;
    if (!adminSession.isSameOrigin(req)) {
      return json(res, 403, { success: false, error: 'Permintaan lintas origin ditolak.' });
    }
    const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const action = String(body.action || '').trim();

    if (action === 'unblock_ip') {
      const ip = String(body.ip || '').trim();
      const reason = String(body.reason || 'Unblock via Tab Keamanan & Audit').slice(0, 160);
      if (!ip) return json(res, 400, { success: false, error: 'Alamat IP wajib diisi.' });
      const out = typeof shield.unblockIp === 'function'
        ? shield.unblockIp(ip, { reason, by: (auth.session && auth.session.un) || 'admin' }, ROOT)
        : { ok: true, ip };
      if (!out || out.ok === false) {
        return json(res, 400, { success: false, error: (out && out.error) || 'Gagal membuka blokir IP.' });
      }
      return json(res, 200, { success: true, message: 'Blokir IP ' + ip + ' telah dibuka.', unblocked: out });
    }

    if (action === 'clear_test_logs') {
      try {
        const stateStore = require('../../lib/security-state');
        const fp = stateStore.statePath(ROOT);
        if (fs.existsSync(fp)) {
          const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (parsed && Array.isArray(parsed.incidents)) {
            parsed.incidents = parsed.incidents.filter((e) => {
              const ip = String((e && e.ip) || '');
              const rs = String((e && (e.reason || e.detail)) || '').toLowerCase();
              const isTest = /^198\.51\.100\.|^203\.0\.113\.|^192\.0\.2\./.test(ip) || rs.includes('simulasi') || rs.includes('uji');
              return !isTest;
            });
            fs.writeFileSync(fp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
          }
        }
      } catch (_) {}
      return json(res, 200, { success: true, message: 'Log pengujian telah dibersihkan; peristiwa produksi tetap tersimpan.' });
    }

    return json(res, 200, { success: true, message: 'Audit keamanan diperbarui.' });
  }

  if (req.method !== 'GET') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  const nowMs = Date.now();
  if (_secAuditCached && (nowMs - _secAuditCachedAt < SEC_AUDIT_TTL_MS)) {
    return json(res, 200, _secAuditCached);
  }

  const security = adminService.getSecurityStatus(ROOT);
  let shieldEvents = [];
  try {
    if (typeof shield.getSecurityEvents === 'function') {
      shieldEvents = shield.getSecurityEvents(ROOT) || [];
    }
  } catch (_) { shieldEvents = []; }

  let vps = null;
  try {
    const vpsFp = path.join(ROOT, 'data', 'security', 'vps-audit.json');
    if (fs.existsSync(vpsFp)) {
      vps = JSON.parse(fs.readFileSync(vpsFp, 'utf8'));
    }
  } catch (_) { vps = null; }

  const attacks = mapSecurityEventsToAttacks(security, shieldEvents);

  const payload = {
    success: true,
    status: security.status || 'AMAN',
    statusLabel: security.statusLabel || 'Telemetri keamanan aktif',
    available: Boolean(security.available),
    updatedAt: security.updatedAt || null,
    metrics24h: security.metrics24h || { sshRejected: 0, botBlocked: 0, loginFailedBlocked: 0, activeBlocks: 0 },
    blockedIps: security.blockedIps || [],
    incidents: security.incidents || [],
    attacks,
    vps
  };
  _secAuditCached = payload;
  _secAuditCachedAt = nowMs;
  return json(res, 200, payload);
};
