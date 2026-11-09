'use strict';
/**
 * test/v5/quota-s2-admin-concurrency.test.js
 * ============================================================================
 * SUBTASK S2 — Quota P0 + Admin Concurrency (real source, isolated sandbox)
 * ============================================================================
 * Part A  P0-01 / P0-02 regression negatives against the REAL lib/quota-limit.js
 *         and lib/quota-reservation.js (fail if the dangerous behavior returns).
 * Part B  Admin SET/CLEAR concurrency + audit transactional model (8 scenarios).
 * Part C  Lockfile regression: the admin override path and the worker snapshot
 *         path share ONE lock so a worker snapshot sync can never clobber a
 *         concurrent admin override (lost-update across processes).
 *
 * No network, no Stock Arjum quota spend, no Telegram, no real data/ mutation
 * (every scenario runs in a temp sandbox with QUOTA_LIMIT_BLOB_PATH redirected).
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true, error: null }); process.stdout.write('PASS  ' + name + '\n'); })
    .catch((err) => { results.push({ name, ok: false, error: String((err && err.message) || err) }); process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n'); });
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

const WIB_KEY = '2026-11-08'; // deterministic same-day key
const NOW = new Date('2026-11-08T05:00:00Z'); // 12:00 WIB weekday

/* -------------------------------------------------------------------------- */
/* Sandbox builders (real modules, isolated paths)                             */
/* -------------------------------------------------------------------------- */

function copyTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile() && /\.js$/.test(entry.name)) fs.copyFileSync(s, d);
  }
}

function makeAuthoritySandbox(seedBlob) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-s2-lim-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'quota-limit.js'),
    fs.readFileSync(path.join(REPO_ROOT, 'lib', 'quota-limit.js'), 'utf8'));
  const blobPath = path.join(root, 'data', 'quota-limit.json');
  if (seedBlob != null) fs.writeFileSync(blobPath, JSON.stringify(seedBlob));
  const A = require(path.join(root, 'lib', 'quota-limit.js'));
  return { A, root, blobPath };
}

function freshBlob(limit, used, verifiedAtIso, override) {
  return {
    schemaVersion: 1,
    source: 'provider',
    providerLimit: limit,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: verifiedAtIso,
    providerPeriodUsed: used,
    providerPeriodUsedVerifiedAt: verifiedAtIso,
    providerPeriodUsedWibDate: WIB_KEY,
    planExpiresAt: '2099-01-01T00:00:00+07:00',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: override || { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: verifiedAtIso
  };
}

// Full admin-endpoint sandbox (endpoint + lib tree) for Part B HTTP/handler tests.
function makeEndpointSandbox(seedBlob, seedState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-s2-ep-'));
  copyTree(path.join(REPO_ROOT, 'lib'), path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'api', 'admin'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'api', 'admin', 'quota-limit.js'), path.join(root, 'api', 'admin', 'quota-limit.js'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'quota.json'), JSON.stringify({
    planName: 'Supporter', planExpiresAt: '2099-01-01T00:00:00+07:00',
    reserveFloorWeekday: 0, reserveFloorWeekend: 0, weekdayBackfillLimit: 0, weekendBackfillLimit: null
  }));
  const blobPath = path.join(root, 'data', 'quota-limit.json');
  if (seedBlob != null) fs.writeFileSync(blobPath, JSON.stringify(seedBlob));
  const statePath = path.join(root, 'data', 'quota-state.json');
  if (seedState != null) fs.writeFileSync(statePath, JSON.stringify(seedState));
  return { root, blobPath, statePath, endpointPath: path.join(root, 'api', 'admin', 'quota-limit.js') };
}

function seedTruth(root, overrideLimit) {
  const quotaLimit = require(path.join(root, 'lib', 'quota-limit.js'));
  const today = quotaLimit.getWibDateKey(new Date());
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'data', 'quota-limit.json'), JSON.stringify({
    schemaVersion: 1,
    providerLimit: 10000,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: nowIso,
    providerPeriodUsed: 1000,
    providerPeriodUsedVerifiedAt: nowIso,
    providerPeriodUsedWibDate: today,
    planExpiresAt: '2099-01-01T00:00:00+07:00',
    source: 'provider',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: overrideLimit == null ? { limit: null, actor: null, reason: null, setAt: null } : { limit: overrideLimit, actor: 'u-budi-1', reason: 'prior', setAt: nowIso },
    updatedAt: nowIso
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'quota-state.json'), JSON.stringify({
    date: today, currentDateWIB: today, localUsedToday: 1000, usedToday: 1000,
    upstreamUsedToday: 1000, upstreamDailyLimit: 10000, effectiveDailyLimit: 10000
  }), 'utf8');
  return today;
}

function makeResObj() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader() { return null; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
}

function adminReq(body, token) {
  const req = new http.IncomingMessage(new (require('net').Socket)());
  req.method = 'POST';
  req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + token, 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.body = body;
  return req;
}

/* ========================================================================== */
/* Part A — P0 regression negatives (real source)                             */
/* ========================================================================== */

test('P0-01 fresh provider 12752 / used 13084 / override 50000 -> BLOCK consumptive (limit capped 12752)', () => {
  const { A, root } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 13084, '2026-11-08T05:00:00Z'), {
      override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-08T04:00:00Z' }
    })
  );
  try {
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY, upstreamUsedToday: 13084 } });
    assert(t.ok === true, 'limit+usage known');
    assert(t.limit === 12752, 'override capped at provider, got ' + t.limit);
    assert(t.remaining === 0 && t.remaining < 1, 'consumptive request of 1 is BLOCKED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P0-01 stale provider snapshot + override 50000 -> BLOCK (LIMIT_STALE, no capacity)', () => {
  const staleIso = new Date(NOW.getTime() - 27 * 3600 * 1000).toISOString();
  const { A, root } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 13084, staleIso), {
      override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-08T04:00:00Z' }
    })
  );
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === false && lim.source === 'stale' && lim.limit === null, 'stale+override fails closed, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P0-01 unknown provider + override 50000 -> BLOCK (LIMIT_UNKNOWN)', () => {
  const { A, root } = makeAuthoritySandbox({ source: 'unknown', override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-08T04:00:00Z' } });
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === false && lim.source === 'unknown' && lim.limit === null, 'unknown cannot become capacity, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P0-01 LOWER override MAY restrict (10000 < 12752 -> effective 10000)', () => {
  const { A, root } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 5000, '2026-11-08T05:00:00Z'), { override: { limit: 10000, actor: 'admin', reason: 'op cap', setAt: '2026-11-08T04:00:00Z' } })
  );
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === true && lim.limit === 10000 && lim.source === 'manual', 'lower override restricts, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* Part C — Lockfile regression (worker snapshot cannot clobber admin override) */
/* ========================================================================== */

test('S2-lock: setProviderLimit (worker snapshot) is lock-guarded (busy lock -> ok:false)', () => {
  const { A, root, blobPath } = makeAuthoritySandbox(freshBlob(18080, 0, '2026-11-08T05:00:00Z'));
  try {
    fs.writeFileSync(blobPath + '.lock', String(process.pid));
    const r = A.setProviderLimit({ now: NOW, used: 5000 });
    assert(r.ok === false, 'foreign lock must fail closed, got ' + JSON.stringify(r));
    assert(/LIMIT_LOCK_BUSY/.test(String(r.error)), 'reason LIMIT_LOCK_BUSY, got ' + r.error);
  } finally {
    try { fs.unlinkSync(blobPath + '.lock'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S2-lock: setOverride is lock-guarded (busy lock -> ok:false, no change)', () => {
  const { A, root, blobPath } = makeAuthoritySandbox(freshBlob(18080, 0, '2026-11-08T05:00:00Z'));
  try {
    fs.writeFileSync(blobPath + '.lock', String(process.pid));
    const r = A.setOverride({ now: NOW, limit: 9000, actor: 'u-admin', reason: 'race' });
    assert(r.ok === false && /LIMIT_LOCK_BUSY/.test(String(r.error)), 'override must fail on busy lock, got ' + JSON.stringify(r));
    // No change persisted.
    const blob = A.readLimitBlob().blob;
    assert(blob.override && blob.override.limit == null, 'override not applied under busy lock, got ' + JSON.stringify(blob.override));
  } finally {
    try { fs.unlinkSync(blobPath + '.lock'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S2-lock: worker usage-only sync PRESERVES a prior admin override (no clobber)', () => {
  const { A, root } = makeAuthoritySandbox(
    Object.assign(freshBlob(18080, 2000, '2026-11-08T05:00:00Z'), { override: { limit: 9000, actor: 'u-admin', reason: 'cap', setAt: '2026-11-08T04:30:00Z' } })
  );
  try {
    // A later worker snapshot (no new provider limit, only fresh usage) must
    // NOT reset the override.
    const r = A.setProviderLimit({ now: new Date('2026-11-08T05:30:00Z'), used: 7000 });
    assert(r.ok === true, 'worker snapshot persists, got ' + JSON.stringify(r));
    const blob = A.readLimitBlob().blob;
    assert(blob.override && blob.override.limit === 9000, 'admin override preserved, got ' + JSON.stringify(blob.override));
    assert(blob.providerPeriodUsed === 7000, 'usage updated to 7000, got ' + blob.providerPeriodUsed);
    assert(blob.providerLimit === 18080, 'provider limit preserved, got ' + blob.providerLimit);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S2-lock: crash mid-transaction leaves a lock that is stolen only after staleness window', () => {
  const { A, root, blobPath } = makeAuthoritySandbox(freshBlob(18080, 0, '2026-11-08T05:00:00Z'));
  const childScript = path.join(root, 'crash-child.js');
  fs.writeFileSync(childScript, `
    const A = require(${JSON.stringify(path.join(root, 'lib', 'quota-limit.js'))});
    const ok = A.acquireLimitLock();
    process.stdout.write(ok ? 'LOCKED' : 'NOT_LOCKED');
    // crash WITHOUT releasing (simulate process kill).
    process.exit(0);
  `);
  try {
    const res = spawnSync(process.execPath, [childScript], { encoding: 'utf8' });
    assert(res.stdout.indexOf('LOCKED') === 0, 'child acquired the lock, got ' + res.stdout);
    assert(fs.existsSync(blobPath + '.lock'), 'lock file remains after child crash');

    // While the lock is fresh (< 10 s), another writer must be rejected.
    const attempt = A.setOverride({ now: NOW, limit: 8000, actor: 'u-admin', reason: 'recover' });
    assert(attempt.ok === false && /LIMIT_LOCK_BUSY/.test(String(attempt.error)), 'fresh crashed lock fails closed, got ' + JSON.stringify(attempt));

    // Age the lock past the stale threshold -> the next writer may steal it.
    const old = new Date(Date.now() - 11 * 1000);
    fs.utimesSync(blobPath + '.lock', old, old);
    const recover = A.setOverride({ now: NOW, limit: 8000, actor: 'u-admin', reason: 'recover' });
    assert(recover.ok === true, 'stale lock is stolen and the write succeeds, got ' + JSON.stringify(recover));
  } finally {
    try { fs.unlinkSync(blobPath + '.lock'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ========================================================================== */
/* Part B — Admin concurrency & transactional audit (8 scenarios)              */
/* ========================================================================== */

async function main() {
  const secret = 's2-admin-secret-' + Math.random().toString(36).slice(2);
  process.env.SESSION_SECRET = secret;

  const rootSandbox = makeEndpointSandbox();
  const adminSession = require(path.join(rootSandbox.root, 'lib', 'admin-session.js'));
  const adminToken = adminSession.createSessionToken({ userId: 'u-budi-1', username: 'budi', isAdmin: true });

  try {
    await test('B1 two admins SET/SET concurrently -> both succeed, 2 audit records, final=last-writer', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const auditLog = path.join(sb.root, 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      async function set(l) {
        const res = makeResObj();
        await ep(adminReq({ action: 'set', limit: l, reason: 'race set ' + l }, adminToken), res);
        return { code: res.statusCode, body: res.body };
      }
      const [a, b] = await Promise.all([set(7100), set(7200)]);
      assert(a.code === 200 && a.body.success === true, 'mutator A ok, got ' + JSON.stringify(a));
      assert(b.code === 200 && b.body.success === true, 'mutator B ok, got ' + JSON.stringify(b));
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7100 || blob.override.limit === 7200, 'final is one writer, got ' + blob.override.limit);
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 2, 'two audit records, got ' + lines.length);
      const last = JSON.parse(lines[lines.length - 1]);
      assert(blob.override.limit === last.next.overrideLimit, 'final config matches last audit record');
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B2 SET concurrent with CLEAR -> both succeed, 2 audit records, final consistent with last audit', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const auditLog = path.join(sb.root, 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      async function act(body) { const res = makeResObj(); await ep(adminReq(body, adminToken), res); return { code: res.statusCode, body: res.body }; }
      const [a, b] = await Promise.all([
        act({ action: 'set', limit: 5500, reason: 'set while clear' }),
        act({ action: 'clear', reason: 'clear while set' })
      ]);
      assert(a.code === 200 && b.code === 200, 'both succeed, got ' + JSON.stringify([a.code, b.code]));
      const blob = ql.readLimitBlob().blob;
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 2, 'two audit records, got ' + lines.length);
      const last = JSON.parse(lines[lines.length - 1]);
      assert(blob.override.limit === last.next.overrideLimit, 'final config matches last audit record (SET->5500 or CLEAR->null)');
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B3 SET audit-append failure -> 500 + rollback restores prior value', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const blockFile = path.join(sb.root, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(blockFile, 'sub', 'audit.jsonl');
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const res = makeResObj();
      await ep(adminReq({ action: 'set', limit: 6000, reason: 'fail audit' }, adminToken), res);
      assert(res.statusCode === 500 && res.body.rolledBack === true, 'SET audit failure -> 500 rolledBack, got ' + JSON.stringify(res.body));
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 5000, 'prior 5000 restored, got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B4 CLEAR audit-append failure -> 500 + rollback restores prior 5000 (never re-clear)', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const blockFile = path.join(sb.root, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(blockFile, 'sub', 'audit.jsonl');
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const res = makeResObj();
      await ep(adminReq({ action: 'clear', reason: 'fail audit' }, adminToken), res);
      assert(res.statusCode === 500 && res.body.rolledBack === true, 'CLEAR audit failure -> 500 rolledBack, got ' + JSON.stringify(res.body));
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 5000, 'prior 5000 restored (not null), got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B5 persistence failure -> 500, no audit record, no active change', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const auditLog = path.join(sb.root, 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      fs.unlinkSync(sb.blobPath);
      fs.mkdirSync(sb.blobPath); // blob path -> directory => atomic rename write fails
      const ep = require(sb.endpointPath);
      const res = makeResObj();
      await ep(adminReq({ action: 'set', limit: 6000, reason: 'persist fail' }, adminToken), res);
      assert(res.statusCode === 500 && !res.body.success, 'persistence failure -> 500, got ' + JSON.stringify(res.body));
      assert(!fs.existsSync(auditLog), 'no audit record when persistence failed');
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B6 process crash mid-transaction -> lock fail-closed, no torn config; stale steal recovers', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const lockPath = sb.blobPath + '.lock';
      fs.writeFileSync(lockPath, '99999'); // simulate a crashed holder (fresh)
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(sb.root, 'audit.jsonl');
      const ep = require(sb.endpointPath);
      const res = makeResObj();
      await ep(adminReq({ action: 'set', limit: 6000, reason: 'crash' }, adminToken), res);
      assert(res.statusCode === 503, 'held lock -> 503 fail-closed, got ' + res.statusCode);
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 5000, 'config unchanged while lock held, got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B7 audit previous/new exactly match the actual change', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const auditLog = path.join(sb.root, 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const res = makeResObj();
      await ep(adminReq({ action: 'set', limit: 7800, reason: 'diff check' }, adminToken), res);
      assert(res.statusCode === 200 && res.body.success === true, 'set 200');
      const rec = JSON.parse(fs.readFileSync(auditLog, 'utf8').trim().split('\n').pop());
      assert(rec.previous.overrideLimit === 5000, 'previous=5000, got ' + JSON.stringify(rec.previous));
      assert(rec.next.overrideLimit === 7800, 'next=7800, got ' + JSON.stringify(rec.next));
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7800, 'actual config = 7800 matches next, got ' + blob.override.limit);
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('B8 idempotency + error status (duplicate SET ok; invalid -> 400; foreign lock -> 503)', async () => {
      const sb = makeEndpointSandbox();
      seedTruth(sb.root, 5000);
      const auditLog = path.join(sb.root, 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      async function act(body) { const res = makeResObj(); await ep(adminReq(body, adminToken), res); return { code: res.statusCode, body: res.body }; }
      const a = await act({ action: 'set', limit: 7000, reason: 'idem a' });
      const b = await act({ action: 'set', limit: 7000, reason: 'idem b' });
      assert(a.code === 200 && b.code === 200, 'duplicate SET both succeed');
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7000, 'idempotent final value 7000, got ' + blob.override.limit);
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 2, 'two audit records (each request audited), got ' + lines.length);

      const invalid = await act({ action: 'set', limit: -5, reason: 'bad' });
      assert(invalid.code === 400, 'invalid -> 400, got ' + invalid.code);

      const lockPath = sb.blobPath + '.lock';
      fs.writeFileSync(lockPath, '888');
      const busy = await act({ action: 'clear', reason: 'busy clear' });
      assert(busy.code === 503, 'foreign lock -> 503, got ' + busy.code);
      try { fs.unlinkSync(lockPath); } catch (_) {}

      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });
  } finally {
    try { fs.rmSync(rootSandbox.root, { recursive: true, force: true }); } catch (_) {}
    delete process.env.SESSION_SECRET;
    delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' S2 assertions passed\n');
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stdout.write('RUNNER FAILURE: ' + String((err && err.stack) || err) + '\n');
    process.exit(2);
  });