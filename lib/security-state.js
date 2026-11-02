'use strict';
// S2 — Penyimpanan status keamanan terpusat (data/security/security-state.json).
// Dipakai bersama oleh lib/security-shield.js (real-time hook), tools/security-monitor.js
// (cron */5, 6 sumber ancaman), dan Admin Console (banner + Tab Keamanan & Audit).
// Tanpa hardcode kuota/token. Tanpa print secret. Bahasa Indonesia.
const fs = require('fs');
const path = require('path');

const STATE_VERSION = 'S2-1.0.0';
const MAX_INCIDENTS = 200;

function stateDir(rootDir) {
  const root = rootDir || path.resolve(__dirname, '..');
  return path.join(root, 'data', 'security');
}

function statePath(rootDir) {
  return path.join(stateDir(rootDir), 'security-state.json');
}

function historyPath(rootDir) {
  return path.join(stateDir(rootDir), 'alert-history.json');
}

function nowIso() {
  return new Date().toISOString();
}

function blankState() {
  return {
    version: STATE_VERSION,
    updatedAt: nowIso(),
    status: 'AMAN',
    statusLabel: 'Aman - Firewall & Anti-Bot Aktif',
    sources: {
      ssh: { rejected: 0, banned: 0, newLogins: 0, detail: '' },
      appBrute: { failed: 0, blocked: 0, detail: '' },
      botFlood: { blocked: 0, probes: 0, detail: '' },
      admin403: { attempts: 0, detail: '' },
      integrity: { issues: 0, detail: '' },
      sensitiveProbe: { count: 0, detail: '' }
    },
    metrics24h: {
      sshRejected: 0,
      botBlocked: 0,
      loginFailedBlocked: 0,
      activeBlocks: 0
    },
    blockedIps: [],
    incidents: [],
    telegram: { lastSentAt: null, cooldownMs: 30 * 60 * 1000 }
  };
}

function readState(rootDir) {
  const fp = typeof rootDir === 'string' && rootDir.endsWith('.json') ? rootDir : statePath(rootDir);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blankState();
    if (!Array.isArray(parsed.incidents)) parsed.incidents = [];
    if (!Array.isArray(parsed.blockedIps)) parsed.blockedIps = [];
    if (!parsed.metrics24h || typeof parsed.metrics24h !== 'object') parsed.metrics24h = blankState().metrics24h;
    if (!parsed.sources || typeof parsed.sources !== 'object') parsed.sources = blankState().sources;
    if (!parsed.status) parsed.status = 'AMAN';
    if (!parsed.statusLabel) parsed.statusLabel = 'Aman - Firewall & Anti-Bot Aktif';
    return parsed;
  } catch (_) {
    return blankState();
  }
}

function writeState(state, rootDir) {
  const fp = typeof rootDir === 'string' && rootDir.endsWith('.json') ? rootDir : statePath(rootDir);
  const dir = path.dirname(fp);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const out = Object.assign({}, state || {}, { version: STATE_VERSION, updatedAt: nowIso() });
  fs.writeFileSync(fp, JSON.stringify(out, null, 2));
  return fp;
}

function maskIpForUi(ip, isSuperAdmin) {
  const v = String(ip == null ? '' : ip).trim();
  if (!v) return 'tidak tersedia';
  if (isSuperAdmin === true) return v;
  // Masking sebagian: tampilkan 2 oktet pertama saja untuk IPv4.
  const m4 = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) return m4[1] + '.' + m4[2] + '.*.*';
  // IPv6: tampilkan 4 grup pertama.
  if (v.indexOf(':') >= 0) {
    const parts = v.split(':');
    return parts.slice(0, 4).join(':') + ':****';
  }
  if (v.length <= 4) return v.charAt(0) + '***';
  return v.slice(0, 2) + '***' + v.slice(-2);
}

function appendIncident(state, incident) {
  const s = state || blankState();
  if (!Array.isArray(s.incidents)) s.incidents = [];
  const entry = Object.assign({ id: 'inc_' + Date.now() + '_' + Math.floor(Math.random() * 100000), at: nowIso() }, incident || {});
  s.incidents.unshift(entry);
  if (s.incidents.length > MAX_INCIDENTS) s.incidents.length = MAX_INCIDENTS;
  return entry;
}

function upsertBlockedIp(state, record) {
  const s = state || blankState();
  if (!Array.isArray(s.blockedIps)) s.blockedIps = [];
  const ip = String(record && record.ip || '').trim();
  if (!ip) return null;
  const idx = s.blockedIps.findIndex((r) => String(r.ip) === ip);
  const entry = {
    ip,
    reason: String(record.reason || 'serangan terdeteksi'),
    until: record.until || null,
    by: record.by || 'auto',
    at: record.at || nowIso(),
    attempts: Number(record.attempts || 0)
  };
  if (idx >= 0) s.blockedIps[idx] = entry;
  else s.blockedIps.push(entry);
  return entry;
}

function removeBlockedIp(state, ip) {
  const s = state || blankState();
  if (!Array.isArray(s.blockedIps)) s.blockedIps = [];
  const v = String(ip || '').trim();
  const before = s.blockedIps.length;
  s.blockedIps = s.blockedIps.filter((r) => String(r.ip) !== v);
  return before !== s.blockedIps.length;
}

function pruneExpiredBlocks(state, nowMs) {
  const s = state || blankState();
  if (!Array.isArray(s.blockedIps)) return 0;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const before = s.blockedIps.length;
  s.blockedIps = s.blockedIps.filter((r) => {
    if (!r.until) return true;
    const t = Date.parse(r.until);
    return Number.isFinite(t) ? t > now : true;
  });
  return before - s.blockedIps.length;
}

function computeMetrics24h(incidents, blockedIps, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const recent = (incidents || []).filter((e) => {
    const t = Date.parse(e && e.at || '');
    return Number.isFinite(t) && t >= cutoff;
  });
  let sshRejected = 0;
  let botBlocked = 0;
  let loginFailedBlocked = 0;
  for (const e of recent) {
    const type = String(e.type || '');
    const n = Number(e.attempts || e.count || 1) || 1;
    if (type === 'SSH_BRUTE_FORCE' || type === 'SSH_BANNED') sshRejected += n;
    else if (type === 'API_FLOOD_BOT' || type === 'BOT_FLOOD' || type === 'SENSITIVE_PROBE') botBlocked += n;
    else if (type === 'BRUTE_FORCE_AUTH' || type === 'LOGIN_BLOCKED') loginFailedBlocked += n;
  }
  let activeBlocks = 0;
  for (const b of (blockedIps || [])) {
    if (!b.until) { activeBlocks += 1; continue; }
    const t = Date.parse(b.until);
    if (!Number.isFinite(t) || t > now) activeBlocks += 1;
  }
  return { sshRejected, botBlocked, loginFailedBlocked, activeBlocks };
}

function refreshDerived(state, nowMs) {
  const s = state || blankState();
  pruneExpiredBlocks(s, nowMs);
  s.metrics24h = computeMetrics24h(s.incidents, s.blockedIps, nowMs);
  const hasActive = (s.blockedIps || []).length > 0
    || (s.incidents || []).slice(0, 20).some((e) => {
      const t = Date.parse(e.at || '');
      const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      return Number.isFinite(t) && (now - t) < 60 * 60 * 1000 && /BRUTE|FLOOD|PROBE|403|SSH|INTEGRITY/i.test(String(e.type || ''));
    });
  s.status = hasActive ? 'WASPADA' : 'AMAN';
  s.statusLabel = hasActive
    ? 'WASPADA - Serangan Bot Terdeteksi & Diblokir'
    : 'Aman - Firewall & Anti-Bot Aktif';
  s.updatedAt = nowIso();
  return s;
}

module.exports = {
  STATE_VERSION,
  MAX_INCIDENTS,
  statePath,
  historyPath,
  blankState,
  readState,
  writeState,
  maskIpForUi,
  appendIncident,
  upsertBlockedIp,
  removeBlockedIp,
  pruneExpiredBlocks,
  computeMetrics24h,
  refreshDerived
};
