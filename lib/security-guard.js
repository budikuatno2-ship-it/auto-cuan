'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const SECURITY_ROUTE = '/api/login-user';
const ALLOWED_MODES = new Set(['off', 'shadow', 'enforce']);
const MAX_USER_AGENT_LENGTH = 240;
const MAX_USERNAME_LENGTH = 80;
const DASHBOARD_EVENT_LIMIT = 300;
const ALERT_TIMEOUT_MS = 3000;

function getMode(env) {
  const value = String((env || process.env).SECURITY_GUARD_MODE || 'off').trim().toLowerCase();
  return ALLOWED_MODES.has(value) ? value : 'off';
}

function getPepper(env) {
  const value = (env || process.env).SECURITY_EVENT_PEPPER;
  return typeof value === 'string' && value.length >= 32 ? value : null;
}

function getPublicStatus(env) {
  const source = env || process.env;
  const mode = getMode(source);
  const pepperReady = Boolean(getPepper(source));
  const alertsEnabled = source.SECURITY_ALERTS_ENABLED === '1';
  const alertTokenReady = Boolean(source.SECURITY_TELEGRAM_BOT_TOKEN || source.TELEGRAM_BOT_TOKEN);
  const alertChatReady = Boolean(source.SECURITY_TELEGRAM_CHAT_ID);
  return {
    mode,
    enabled: mode !== 'off',
    enforcement: mode === 'enforce',
    pepper_ready: pepperReady,
    alerts_enabled: alertsEnabled,
    alerts_ready: alertsEnabled && alertTokenReady && alertChatReady,
    admin_fail_closed: source.SECURITY_GUARD_FAIL_CLOSED_ADMIN === '1'
  };
}

function normalizeUsername(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, MAX_USERNAME_LENGTH);
}

function maskUsername(value) {
  const clean = normalizeUsername(value);
  if (!clean) return 'unknown';
  if (clean.length <= 2) return clean.charAt(0) + '*';
  return clean.slice(0, 2) + '*'.repeat(Math.min(6, clean.length - 2));
}

function sanitizeUserAgent(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH) || 'unknown';
}

function normalizeIp(value) {
  let input = String(value == null ? '' : value).trim();
  if (!input) return null;
  if (input.startsWith('[') && input.includes(']')) input = input.slice(1, input.indexOf(']'));
  if (/^::ffff:/i.test(input)) input = input.slice(7);
  if (net.isIP(input)) return input;
  const ipv4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(input);
  if (ipv4Port && net.isIP(ipv4Port[1]) === 4) return ipv4Port[1];
  return null;
}

function firstValidForwarded(value) {
  const parts = String(value == null ? '' : value).split(',');
  for (const part of parts) {
    const ip = normalizeIp(part);
    if (ip) return ip;
  }
  return null;
}

function getClientIp(req) {
  const headers = (req && req.headers) || {};
  return firstValidForwarded(headers['x-vercel-forwarded-for']) ||
    normalizeIp(headers['x-real-ip']) ||
    firstValidForwarded(headers['x-forwarded-for']) ||
    normalizeIp(req && req.socket && req.socket.remoteAddress) ||
    null;
}

function digest(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

function requestId() {
  return 'sec_' + crypto.randomBytes(18).toString('base64url');
}

function buildContext(req, username, env) {
  const pepper = getPepper(env);
  const normalizedUsername = normalizeUsername(username);
  const ip = getClientIp(req);
  const userAgent = sanitizeUserAgent((req && req.headers && req.headers['user-agent']) || '');
  const id = requestId();
  if (!pepper) {
    return {
      requestId: id,
      username: normalizedUsername,
      usernameMasked: maskUsername(normalizedUsername),
      ip,
      userAgent,
      adminTarget: normalizedUsername === 'budi',
      ready: false
    };
  }
  const ipMaterial = ip || 'ip-unavailable';
  const accountMaterial = normalizedUsername || 'account-unavailable';
  return {
    requestId: id,
    username: normalizedUsername,
    usernameMasked: maskUsername(normalizedUsername),
    ip,
    userAgent,
    adminTarget: normalizedUsername === 'budi',
    ipHash: digest('ip:' + ipMaterial, pepper),
    accountHash: digest('account:' + accountMaterial, pepper),
    pairHash: digest('pair:' + ipMaterial + '|' + accountMaterial, pepper),
    userAgentHash: digest('ua:' + userAgent, pepper),
    ready: true
  };
}

function unwrapRpcData(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value && typeof value === 'object' ? value : null;
}

function retryAfterSeconds(blockedUntil) {
  const time = Date.parse(blockedUntil || '');
  if (!Number.isFinite(time)) return 60;
  return Math.max(1, Math.ceil((time - Date.now()) / 1000));
}

function isMissingSecuritySchema(error) {
  if (!error) return false;
  const text = String(error.code || '') + ' ' + String(error.message || '');
  return /42P01|42883|does not exist|Could not find the function/i.test(text);
}

function rpcParams(context) {
  return {
    p_request_id: context.requestId,
    p_ip_address: context.ip,
    p_ip_hash: context.ipHash,
    p_account_hash: context.accountHash,
    p_pair_hash: context.pairHash,
    p_username_masked: context.usernameMasked,
    p_user_agent: context.userAgent,
    p_user_agent_hash: context.userAgentHash,
    p_is_admin_target: context.adminTarget,
    p_route: SECURITY_ROUTE
  };
}

async function sendSecurityAlert(result, context, env) {
  const source = env || process.env;
  if (source.SECURITY_ALERTS_ENABLED !== '1') return { sent: false, skipped: true, reason: 'disabled' };
  const token = String(source.SECURITY_TELEGRAM_BOT_TOKEN || source.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(source.SECURITY_TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { sent: false, skipped: true, reason: 'missing_config' };

  const severity = String(result.severity || 'high').toUpperCase();
  const action = result.blocked === true ? 'BLOCKED' : 'DETECTED';
  const counts = result.counts || {};
  const lines = [
    (severity === 'CRITICAL' ? '🔴' : '🟠') + ' SECURITY ALERT — ' + action,
    '',
    'Waktu: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
    'IP: ' + (context.ip || 'tidak tersedia'),
    'Target: ' + context.usernameMasked,
    'Route: POST ' + SECURITY_ROUTE,
    'Alasan: ' + String(result.failure_reason || 'login_failed'),
    'Hit IP/Target/Pair: ' + Number(counts.ip || 0) + '/' + Number(counts.account || 0) + '/' + Number(counts.pair || 0),
    'Akun unik dari IP: ' + Number(counts.distinct_accounts || 0),
    'Tindakan: ' + (result.blocked_until ? ('blok sampai ' + result.blocked_until) : 'dicatat dan dipantau'),
    'User-Agent: ' + context.userAgent,
    'Request ID: ' + context.requestId
  ];

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ALERT_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join('\n'),
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    return response.ok ? { sent: true, skipped: false } : { sent: false, skipped: false, reason: 'api_error' };
  } catch (error) {
    clearTimeout(timer);
    return { sent: false, skipped: false, reason: error && error.name === 'AbortError' ? 'timeout' : 'fetch_error' };
  }
}

async function recordBlockedHit(db, context, precheck, mode) {
  if (!db || !context.ready) return;
  try {
    await db.rpc('security_login_record_blocked', Object.assign(rpcParams(context), {
      p_blocked_until: precheck.blocked_until || null,
      p_block_reason: precheck.reason || 'active_rate_limit',
      p_shadow_only: mode !== 'enforce'
    }));
  } catch (_) {}
}

function makeNoopGuard(context, status, extra) {
  return Object.assign({
    context,
    status,
    deny: false,
    retryAfterSeconds: 0,
    failure: async function () { return { recorded: false, status }; },
    credentialAccepted: async function () { return { recorded: false, status }; }
  }, extra || {});
}

async function beginLogin(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const mode = getMode(env);
  const context = buildContext(opts.req, opts.username, env);
  if (mode === 'off') return makeNoopGuard(context, 'disabled');

  if (!context.ready || !opts.db) {
    const failClosed = mode === 'enforce' && context.adminTarget && env.SECURITY_GUARD_FAIL_CLOSED_ADMIN === '1';
    return makeNoopGuard(context, 'unavailable', failClosed ? {
      deny: true,
      httpStatus: 503,
      publicError: 'Login admin sementara dikunci untuk keamanan.'
    } : null);
  }

  let precheck = null;
  try {
    const response = await opts.db.rpc('security_login_precheck', {
      p_ip_hash: context.ipHash,
      p_account_hash: context.accountHash,
      p_pair_hash: context.pairHash
    });
    if (response.error) throw response.error;
    precheck = unwrapRpcData(response.data) || {};
  } catch (error) {
    const failClosed = mode === 'enforce' && context.adminTarget && env.SECURITY_GUARD_FAIL_CLOSED_ADMIN === '1';
    return makeNoopGuard(context, isMissingSecuritySchema(error) ? 'schema_missing' : 'precheck_failed', failClosed ? {
      deny: true,
      httpStatus: 503,
      publicError: 'Login admin sementara dikunci untuk keamanan.'
    } : null);
  }

  const blocked = precheck.blocked === true;
  if (blocked) await recordBlockedHit(opts.db, context, precheck, mode);

  const guard = makeNoopGuard(context, blocked ? 'rate_limited' : 'ready', blocked && mode === 'enforce' ? {
    deny: true,
    httpStatus: 429,
    publicError: 'Terlalu banyak percobaan login. Coba lagi nanti.',
    retryAfterSeconds: retryAfterSeconds(precheck.blocked_until)
  } : null);

  guard.failure = async function (reason) {
    try {
      const response = await opts.db.rpc('security_login_record_failure', Object.assign(rpcParams(context), {
        p_failure_reason: String(reason || 'login_failed').slice(0, 80)
      }));
      if (response.error) throw response.error;
      const result = unwrapRpcData(response.data) || {};
      if (result.should_alert === true) await sendSecurityAlert(result, context, env);
      return Object.assign({ recorded: true }, result);
    } catch (error) {
      return { recorded: false, status: isMissingSecuritySchema(error) ? 'schema_missing' : 'record_failed' };
    }
  };

  guard.credentialAccepted = async function (outcome) {
    try {
      const response = await opts.db.rpc('security_login_record_success', Object.assign(rpcParams(context), {
        p_outcome: String(outcome || 'login_success').slice(0, 80)
      }));
      if (response.error) throw response.error;
      return { recorded: true };
    } catch (error) {
      return { recorded: false, status: isMissingSecuritySchema(error) ? 'schema_missing' : 'record_failed' };
    }
  };

  return guard;
}

function severityRank(value) {
  return ({ low: 1, medium: 2, high: 3, critical: 4 })[String(value || '').toLowerCase()] || 0;
}

function safeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildSecuritySummary(rows, nowValue) {
  const now = nowValue == null ? Date.now() : Number(nowValue);
  const cutoff = now - 24 * 60 * 60 * 1000;
  const recent = (rows || []).filter(function (row) {
    const time = Date.parse(row && row.created_at || '');
    return Number.isFinite(time) && time >= cutoff;
  });
  const suspicious = recent.filter(function (row) { return row.outcome !== 'success'; });
  const grouped = new Map();

  suspicious.forEach(function (row) {
    const ip = row.ip_address || 'tidak tersedia';
    if (!grouped.has(ip)) grouped.set(ip, {
      ip,
      hits: 0,
      blocked_hits: 0,
      severity: 'low',
      last_seen: null,
      blocked_until: null,
      user_agents: new Set(),
      targets: new Set(),
      reasons: new Map(),
      routes: new Set()
    });
    const item = grouped.get(ip);
    item.hits += 1;
    if (row.outcome === 'blocked' || row.event_type === 'login_rate_limited') item.blocked_hits += 1;
    if (severityRank(row.severity) > severityRank(item.severity)) item.severity = row.severity;
    if (!item.last_seen || Date.parse(row.created_at) > Date.parse(item.last_seen)) item.last_seen = row.created_at;
    if (row.blocked_until && (!item.blocked_until || Date.parse(row.blocked_until) > Date.parse(item.blocked_until))) item.blocked_until = row.blocked_until;
    if (row.user_agent) item.user_agents.add(row.user_agent);
    if (row.username_masked) item.targets.add(row.username_masked);
    if (row.failure_reason) item.reasons.set(row.failure_reason, (item.reasons.get(row.failure_reason) || 0) + 1);
    if (row.route) item.routes.add(row.route);
  });

  const suspiciousIps = Array.from(grouped.values()).map(function (item) {
    return {
      ip: item.ip,
      hits: item.hits,
      blocked_hits: item.blocked_hits,
      severity: item.severity,
      last_seen: item.last_seen,
      blocked_until: item.blocked_until,
      active_block: Boolean(item.blocked_until && Date.parse(item.blocked_until) > now),
      user_agents: Array.from(item.user_agents).slice(0, 5),
      targets: Array.from(item.targets).slice(0, 8),
      reasons: Array.from(item.reasons.entries()).map(function (entry) { return { reason: entry[0], count: entry[1] }; }).sort(function (a, b) { return b.count - a.count; }),
      routes: Array.from(item.routes).slice(0, 8)
    };
  }).sort(function (a, b) {
    return Number(b.active_block) - Number(a.active_block) || severityRank(b.severity) - severityRank(a.severity) || b.hits - a.hits;
  });

  return {
    total_events_24h: suspicious.length,
    blocked_events_24h: suspicious.filter(function (row) { return row.outcome === 'blocked' || row.event_type === 'login_rate_limited'; }).length,
    admin_target_events_24h: suspicious.filter(function (row) { return safeMetadata(row.metadata).admin_target === true; }).length,
    unique_ips_24h: new Set(suspicious.map(function (row) { return row.ip_address || 'tidak tersedia'; })).size,
    active_blocks: suspiciousIps.filter(function (item) { return item.active_block; }).length,
    suspicious_ips: suspiciousIps.slice(0, 50)
  };
}

async function loadSecurityDashboard(db, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit || DASHBOARD_EVENT_LIMIT), 500));
  if (!db) return { available: false, reason: 'database_unavailable', events: [], summary: buildSecuritySummary([]) };
  try {
    const response = await db.from('security_events')
      .select('id,event_type,severity,outcome,route,method,ip_address,username_masked,user_agent,status_code,failure_reason,blocked_until,request_id,created_at,metadata')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (response.error) throw response.error;
    const rows = response.data || [];
    return { available: true, reason: null, events: rows, summary: buildSecuritySummary(rows, opts.now) };
  } catch (error) {
    return { available: false, reason: isMissingSecuritySchema(error) ? 'schema_missing' : 'query_failed', events: [], summary: buildSecuritySummary([]) };
  }
}

module.exports = {
  SECURITY_ROUTE,
  ALLOWED_MODES,
  getMode,
  getPepper,
  getPublicStatus,
  normalizeUsername,
  maskUsername,
  sanitizeUserAgent,
  normalizeIp,
  getClientIp,
  digest,
  buildContext,
  retryAfterSeconds,
  isMissingSecuritySchema,
  beginLogin,
  sendSecurityAlert,
  buildSecuritySummary,
  loadSecurityDashboard
};
