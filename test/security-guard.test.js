'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../lib/security-guard');

const PEPPER = 'security-test-pepper-0123456789-abcdef';

function req(headers) {
  return { headers: headers || {}, socket: { remoteAddress: '10.0.0.1' } };
}

function env(overrides) {
  return Object.assign({
    SECURITY_GUARD_MODE: 'shadow',
    SECURITY_EVENT_PEPPER: PEPPER,
    SECURITY_ALERTS_ENABLED: '0'
  }, overrides || {});
}

test('client IP prefers the Vercel-controlled forwarding header and normalizes addresses', () => {
  assert.equal(guard.getClientIp(req({
    'x-vercel-forwarded-for': '203.0.113.10, 10.0.0.2',
    'x-forwarded-for': '198.51.100.99'
  })), '203.0.113.10');
  assert.equal(guard.normalizeIp('::ffff:192.0.2.8'), '192.0.2.8');
  assert.equal(guard.normalizeIp('192.0.2.9:443'), '192.0.2.9');
  assert.equal(guard.normalizeIp('not-an-ip'), null);
});

test('security context masks usernames and uses deterministic non-reversible keys', () => {
  const context = guard.buildContext(req({
    'x-vercel-forwarded-for': '203.0.113.15',
    'user-agent': 'Browser\nInjected'
  }), 'Budi', env());
  assert.equal(context.username, 'budi');
  assert.equal(context.usernameMasked, 'bu**');
  assert.equal(context.adminTarget, true);
  assert.equal(context.userAgent, 'Browser Injected');
  assert.match(context.ipHash, /^[0-9a-f]{64}$/);
  assert.match(context.accountHash, /^[0-9a-f]{64}$/);
  assert.notEqual(context.ipHash, '203.0.113.15');
  assert.notEqual(context.accountHash, 'budi');
});

test('mode off never calls the database and never blocks login', async () => {
  let calls = 0;
  const db = { rpc: async function () { calls += 1; return { data: null, error: null }; } };
  const result = await guard.beginLogin({
    req: req({ 'x-vercel-forwarded-for': '203.0.113.20' }),
    db,
    username: 'budi',
    env: env({ SECURITY_GUARD_MODE: 'off' })
  });
  assert.equal(result.status, 'disabled');
  assert.equal(result.deny, false);
  await result.failure('bad_password');
  assert.equal(calls, 0);
});

test('enforce mode rejects an active IP or pair block with Retry-After metadata', async () => {
  const blockedUntil = new Date(Date.now() + 120000).toISOString();
  const calls = [];
  const db = {
    rpc: async function (name, params) {
      calls.push({ name, params });
      if (name === 'security_login_precheck') {
        return { data: { blocked: true, blocked_until: blockedUntil, reason: 'pair' }, error: null };
      }
      return { data: { recorded: true }, error: null };
    }
  };
  const result = await guard.beginLogin({
    req: req({ 'x-vercel-forwarded-for': '203.0.113.21' }),
    db,
    username: 'budi',
    env: env({ SECURITY_GUARD_MODE: 'enforce' })
  });
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.deny, true);
  assert.equal(result.httpStatus, 429);
  assert.ok(result.retryAfterSeconds >= 1);
  assert.deepEqual(calls.map(function (row) { return row.name; }), [
    'security_login_precheck',
    'security_login_record_blocked'
  ]);
});

test('shadow block audit and credential/failure events use distinct request ids', async () => {
  const calls = [];
  const db = {
    rpc: async function (name, params) {
      calls.push({ name, params });
      if (name === 'security_login_precheck') {
        return { data: { blocked: true, blocked_until: new Date(Date.now() + 60000).toISOString(), reason: 'ip' }, error: null };
      }
      if (name === 'security_login_record_failure') {
        return { data: { should_alert: false, blocked: false }, error: null };
      }
      return { data: { recorded: true }, error: null };
    }
  };
  const result = await guard.beginLogin({
    req: req({ 'x-vercel-forwarded-for': '203.0.113.22' }),
    db,
    username: 'someone',
    env: env({ SECURITY_GUARD_MODE: 'shadow' })
  });
  assert.equal(result.deny, false);
  await result.failure('bad_password');
  const blockedCall = calls.find(function (row) { return row.name === 'security_login_record_blocked'; });
  const failureCall = calls.find(function (row) { return row.name === 'security_login_record_failure'; });
  assert.ok(blockedCall);
  assert.ok(failureCall);
  assert.notEqual(blockedCall.params.p_request_id, failureCall.params.p_request_id);
});

test('admin can fail closed when security configuration is unavailable', async () => {
  const result = await guard.beginLogin({
    req: req({ 'x-vercel-forwarded-for': '203.0.113.23' }),
    db: null,
    username: 'budi',
    env: {
      SECURITY_GUARD_MODE: 'enforce',
      SECURITY_GUARD_FAIL_CLOSED_ADMIN: '1'
    }
  });
  assert.equal(result.deny, true);
  assert.equal(result.httpStatus, 503);
});

test('Telegram alerts use a dedicated chat and never include secrets', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async function (url, options) {
    captured = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200 };
  };
  try {
    const context = guard.buildContext(req({
      'x-vercel-forwarded-for': '203.0.113.24',
      'user-agent': 'safe-agent'
    }), 'budi', env());
    const result = await guard.sendSecurityAlert({
      severity: 'critical',
      blocked: true,
      blocked_until: '2026-07-29T12:00:00Z',
      failure_reason: 'bad_password',
      counts: { ip: 3, account: 3, pair: 3, distinct_accounts: 1 }
    }, context, env({
      SECURITY_ALERTS_ENABLED: '1',
      SECURITY_TELEGRAM_BOT_TOKEN: 'dedicated-token',
      SECURITY_TELEGRAM_CHAT_ID: '123456',
      TELEGRAM_CHAT_ID: 'must-not-be-used'
    }));
    assert.equal(result.sent, true);
    assert.equal(captured.body.chat_id, '123456');
    assert.match(captured.url, /dedicated-token/);
    assert.doesNotMatch(captured.body.text, /passwordHash|cookie|deviceId|must-not-be-used/i);
    assert.match(captured.body.text, /Target: bu\*\*/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('security dashboard groups suspicious activity by IP and sorts active critical blocks first', () => {
  const now = Date.parse('2026-07-29T10:00:00Z');
  const rows = [
    {
      ip_address: '203.0.113.30',
      event_type: 'login_failed',
      severity: 'medium',
      outcome: 'failed',
      username_masked: 'us****',
      user_agent: 'browser-a',
      failure_reason: 'bad_password',
      route: '/api/login-user',
      created_at: '2026-07-29T09:00:00Z',
      metadata: { admin_target: false }
    },
    {
      ip_address: '203.0.113.31',
      event_type: 'login_rate_limited',
      severity: 'critical',
      outcome: 'blocked',
      username_masked: 'bu**',
      user_agent: 'bot',
      failure_reason: 'pair',
      route: '/api/login-user',
      blocked_until: '2026-07-29T11:00:00Z',
      created_at: '2026-07-29T09:30:00Z',
      metadata: { admin_target: true }
    }
  ];
  const summary = guard.buildSecuritySummary(rows, now);
  assert.equal(summary.total_events_24h, 2);
  assert.equal(summary.active_blocks, 1);
  assert.equal(summary.admin_target_events_24h, 1);
  assert.equal(summary.suspicious_ips[0].ip, '203.0.113.31');
  assert.equal(summary.suspicious_ips[0].active_block, true);
});
