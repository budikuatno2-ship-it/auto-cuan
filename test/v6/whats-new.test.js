'use strict';

/**
 * test/v6/whats-new.test.js
 * ============================================================================
 * V6 (W2a / Feature 13A) — "What's New" vertical slice.
 *
 * Strategy: REAL lib/whats-new-store.js + REAL api/whats-new.js, redirected to
 * a tmpdir via env. Signed session tokens are minted with lib/admin-session
 * (HMAC). No network, no provider, no VPS writes.
 *
 * Covers the 10 mandated scenarios (a)-(j).
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_P = path.join(ROOT, 'lib', 'whats-new-store.js');
const EP_P = path.join(ROOT, 'api', 'whats-new.js');
const SESSION_P = path.join(ROOT, 'lib', 'admin-session.js');
const RUNTIME_P = path.join(ROOT, 'public', 'whats-new-runtime.js');

const SECRET = 'test-secret-whats-new-0123456789';
process.env.SESSION_SECRET = SECRET;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-whatsnew-')); }

function loadModules(tmp) {
  process.env.WHATS_NEW_STORE_PATH = path.join(tmp, 'releases.json');
  process.env.WHATS_NEW_BACKUP_DIR = path.join(tmp, 'backups');
  process.env.WHATS_NEW_ACKS_PATH = path.join(tmp, 'acks.jsonl');
  process.env.WHATS_NEW_AUDIT_PATH = path.join(tmp, 'audit.log.jsonl');
  delete require.cache[require.resolve(STORE_P)];
  delete require.cache[require.resolve(EP_P)];
  delete require.cache[require.resolve(SESSION_P)];
  const store = require(STORE_P);
  const endpoint = require(EP_P);
  const session = require(SESSION_P);
  return { store, endpoint, session };
}

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
  return r;
}

function mockReq(o) {
  const opts = o || {};
  return {
    method: opts.method || 'GET',
    headers: Object.assign({ host: 'localhost', origin: 'http://localhost' }, opts.headers || {}),
    query: opts.query || {},
    body: opts.body || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' }
  };
}

function cookieFor(session, input) {
  const token = session.createSessionToken(input);
  return 'ac_sess=' + token;
}

const ADMIN = { userId: 'admin-1', username: 'budi', isAdmin: true };
const USER = { userId: 'user-1', username: 'alice', isAdmin: false };

async function call(endpoint, req) {
  const res = mockRes();
  await endpoint(req, res);
  return res;
}

test('13A-(a): publish -> GET returns it unacknowledged', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);

  const draft = store.createDraft({ title: 'Rilis V6', summary: 'Ringkasan', items: ['Fitur A', 'Fitur B'] }, { actor: 'budi' });
  assert.equal(draft.ok, true);
  const pub = store.publish(draft.release.release_id, { actor: 'budi' });
  assert.equal(pub.ok, true);

  const res = await call(endpoint, mockReq({ headers: { cookie: cookieFor(session, USER) } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.release);
  assert.equal(res.body.release.title, 'Rilis V6');
  assert.equal(res.body.acknowledged, false);
});

test('13A-(b): ack -> GET returns acknowledged', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  const draft = store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' });
  store.publish(draft.release.release_id, { actor: 'budi' });

  const ackRes = await call(endpoint, mockReq({
    method: 'POST',
    query: { sub: 'ack' },
    headers: { cookie: cookieFor(session, USER) },
    body: { release_id: draft.release.release_id }
  }));
  assert.equal(ackRes.statusCode, 200);
  assert.equal(ackRes.body.already_acknowledged, false);

  const getRes = await call(endpoint, mockReq({ headers: { cookie: cookieFor(session, USER) } }));
  assert.equal(getRes.body.acknowledged, true);
});

test('13A-(c): second ack is idempotent (no duplicate row)', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  const draft = store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' });
  store.publish(draft.release.release_id, { actor: 'budi' });

  const req = () => mockReq({
    method: 'POST', query: { sub: 'ack' },
    headers: { cookie: cookieFor(session, USER) },
    body: { release_id: draft.release.release_id }
  });
  const first = await call(endpoint, req());
  const second = await call(endpoint, req());
  assert.equal(first.body.already_acknowledged, false);
  assert.equal(second.body.already_acknowledged, true);

  const lines = fs.readFileSync(process.env.WHATS_NEW_ACKS_PATH, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one ack row for (user, release)');
});

test('13A-(d): a new release shows again (unacknowledged)', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  const d1 = store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' });
  store.publish(d1.release.release_id, { actor: 'budi' });
  await call(endpoint, mockReq({
    method: 'POST', query: { sub: 'ack' },
    headers: { cookie: cookieFor(session, USER) },
    body: { release_id: d1.release.release_id }
  }));

  const d2 = store.createDraft({ title: 'R2', items: [] }, { actor: 'budi' });
  store.publish(d2.release.release_id, { actor: 'budi' });

  const res = await call(endpoint, mockReq({ headers: { cookie: cookieFor(session, USER) } }));
  assert.equal(res.body.release.title, 'R2');
  assert.equal(res.body.acknowledged, false, 'new release is unacknowledged for this user');
});

test('13A-(e): unauthenticated GET/POST rejected', async () => {
  const tmp = tmpdir();
  const { store, endpoint } = loadModules(tmp);
  const d = store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' });
  store.publish(d.release.release_id, { actor: 'budi' });

  const getRes = await call(endpoint, mockReq({}));
  assert.equal(getRes.statusCode, 401);

  const postRes = await call(endpoint, mockReq({ method: 'POST', query: { sub: 'ack' }, body: { release_id: d.release.release_id } }));
  assert.equal(postRes.statusCode, 401);
});

test('13A-(f): CSRF (cross-origin) ack rejected', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  const d = store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' });
  store.publish(d.release.release_id, { actor: 'budi' });

  const res = await call(endpoint, mockReq({
    method: 'POST', query: { sub: 'ack' },
    headers: { cookie: cookieFor(session, USER), origin: 'http://evil.example', host: 'localhost' },
    body: { release_id: d.release.release_id }
  }));
  assert.equal(res.statusCode, 403);
});

test('13A-(g): admin publish without RBAC rejected', async () => {
  const tmp = tmpdir();
  const { endpoint, session } = loadModules(tmp);

  // Non-admin session attempting an admin action.
  const res = await call(endpoint, mockReq({
    method: 'POST', query: { admin: '1' },
    headers: { cookie: cookieFor(session, USER) },
    body: { action: 'draft', title: 'Hack', items: [] }
  }));
  assert.equal(res.statusCode, 403);

  // No session at all.
  const res2 = await call(endpoint, mockReq({ method: 'POST', query: { admin: '1' }, body: { action: 'draft', title: 'X' } }));
  assert.equal(res2.statusCode, 401);
});

test('13A-(h): version conflict returns 409', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  store.createDraft({ title: 'R1', items: [] }, { actor: 'budi' }); // version -> 1

  const res = await call(endpoint, mockReq({
    method: 'POST', query: { admin: '1' },
    headers: { cookie: cookieFor(session, ADMIN) },
    body: { action: 'draft', title: 'R2', items: [], expectedVersion: 0 }
  }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'VERSION_CONFLICT');
});

test('13A-(i): XSS — release title/summary with <script> is escaped on render', () => {
  const runtime = require(RUNTIME_P);
  const html = runtime.renderReleaseHtml({
    title: '<script>alert(1)</script>',
    summary: 'Ringkasan <img src=x onerror=alert(2)>',
    items: ['<b>butir</b>'],
    published_at_wib: '2026-11-14T10:00:00+07:00'
  });
  assert.ok(!html.includes('<script>'), 'raw <script> must not appear');
  assert.ok(!html.includes('<img'), 'raw <img> must not appear');
  assert.ok(html.includes('\u0026lt;script\u0026gt;'), 'script is escaped');
  assert.ok(html.includes('\u0026lt;img'), 'img is escaped');
  // The static wrapper is still present (renderer works, not just blank).
  assert.ok(html.includes('wn-modal'));
});

test('13A-(j): rollback restores previous published release', async () => {
  const tmp = tmpdir();
  const { store, endpoint, session } = loadModules(tmp);
  const d1 = store.createDraft({ title: 'Rilis Lama', items: ['lama'] }, { actor: 'budi' });
  store.publish(d1.release.release_id, { actor: 'budi' });
  const d2 = store.createDraft({ title: 'Rilis Baru', items: ['baru'] }, { actor: 'budi' });
  store.publish(d2.release.release_id, { actor: 'budi' });

  // Latest is now Rilis Baru.
  let res = await call(endpoint, mockReq({ headers: { cookie: cookieFor(session, USER) } }));
  assert.equal(res.body.release.title, 'Rilis Baru');

  // Rollback to the first release via the admin endpoint.
  const rb = await call(endpoint, mockReq({
    method: 'POST', query: { admin: '1' },
    headers: { cookie: cookieFor(session, ADMIN) },
    body: { action: 'rollback', release_id: d1.release.release_id }
  }));
  assert.equal(rb.statusCode, 200);
  assert.equal(rb.body.release.title, 'Rilis Lama');
  assert.equal(rb.body.release.rollback_of, d1.release.release_id);

  res = await call(endpoint, mockReq({ headers: { cookie: cookieFor(session, USER) } }));
  assert.equal(res.body.release.title, 'Rilis Lama', 'rollback restores the previous published release');
});
