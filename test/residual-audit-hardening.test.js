'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const securityGuard = require('../lib/security-guard');
const uploader = require('../tools/upload-ai-eval-shards');
const supervisor = require('../tools/ai-eval-once-supervisor');

test('security guard defaults to enforce and admin fail-closed in production', async () => {
  const env = { NODE_ENV: 'production' };
  assert.equal(securityGuard.getMode(env), 'enforce');
  assert.equal(securityGuard.shouldFailClosedAdmin(env), true);
  assert.equal(securityGuard.getPublicStatus(env).enforcement, true);

  const guard = await securityGuard.beginLogin({
    env,
    username: 'budi',
    req: { headers: {}, socket: {} },
    db: null
  });
  assert.equal(guard.context.adminTarget, true);
  assert.equal(guard.deny, true);
  assert.equal(guard.httpStatus, 503);
});

test('security guard preserves explicit maintenance overrides and configurable admin identity', () => {
  assert.equal(securityGuard.getMode({ NODE_ENV: 'production', SECURITY_GUARD_MODE: 'shadow' }), 'shadow');
  assert.equal(securityGuard.getMode({ NODE_ENV: 'test' }), 'off');
  assert.equal(securityGuard.shouldFailClosedAdmin({ NODE_ENV: 'production', SECURITY_GUARD_FAIL_CLOSED_ADMIN: '0' }), false);
  assert.equal(securityGuard.getPrimaryAdminUsername({ PRIMARY_ADMIN_USERNAME: ' Owner ' }), 'owner');
  const context = securityGuard.buildContext(
    { headers: {}, socket: {} },
    'OWNER',
    { PRIMARY_ADMIN_USERNAME: 'owner' }
  );
  assert.equal(context.adminTarget, true);
});

test('manifest reader self-heals duplicate shard indexes and keeps the latest row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-manifest-'));
  const file = path.join(dir, 'manifest.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ shard_index: 0, file: 'results-000000.jsonl.gz', sha256: 'a' }),
    JSON.stringify({ shard_index: 1, file: 'results-000001-old.jsonl.gz', sha256: 'old' }),
    JSON.stringify({ shard_index: 1, file: 'results-000001.jsonl.gz', sha256: 'new' })
  ].join('\n') + '\n');

  const rows = uploader.readJsonl(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].sha256, 'new');
  const persisted = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(persisted.length, 2);
  assert.match(persisted[1], /"sha256":"new"/);
});

test('AI eval supervisor claims a run through the atomic database RPC before spawn', async () => {
  const previousFetch = global.fetch;
  let observed = null;
  global.fetch = async function (url, options) {
    observed = { url: String(url), options };
    return { ok: true, status: 200, async text() { return 'true'; } };
  };
  try {
    const claimed = await supervisor.claimRun('00000000-0000-4000-8000-000000000001');
    assert.equal(claimed, true);
    assert.match(observed.url, /\/rest\/v1\/rpc\/claim_ai_eval_run$/);
    assert.equal(observed.options.method, 'POST');
    assert.deepEqual(JSON.parse(observed.options.body), { p_run_id: '00000000-0000-4000-8000-000000000001' });
  } finally {
    global.fetch = previousFetch;
  }
});
