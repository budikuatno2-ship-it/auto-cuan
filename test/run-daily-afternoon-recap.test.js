'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const recapRunner = require('../tools/run-daily-afternoon-recap');

test('parseArgs defaults to dry-run mode and null date', () => {
  const opts = recapRunner.parseArgs([]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.send, false);
  assert.equal(opts.date, null);
  assert.equal(opts.chatId, null);
});

test('parseArgs parses --send, --date, and --chat-id flags', () => {
  const opts = recapRunner.parseArgs(['--send', '--date=2026-09-04', '--chat-id=-100123456']);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.send, true);
  assert.equal(opts.date, '2026-09-04');
  assert.equal(opts.chatId, '-100123456');
});

test('parseArgs respects --dry-run flag overrides', () => {
  const opts = recapRunner.parseArgs(['--send', '--dry-run']);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.send, false);
});

test('loadEnvFile reads KEY=VALUE pairs safely', () => {
  const tmpFile = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
  fs.writeFileSync(tmpFile, 'TEST_AC_VAR=hello_autocuan\n# comment\nTEST_AC_QUOTED="quoted_val"\n');
  try {
    const loaded = recapRunner.loadEnvFile(tmpFile);
    assert.equal(loaded, true);
    assert.equal(process.env.TEST_AC_VAR, 'hello_autocuan');
    assert.equal(process.env.TEST_AC_QUOTED, 'quoted_val');
  } finally {
    delete process.env.TEST_AC_VAR;
    delete process.env.TEST_AC_QUOTED;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('main executes in fallback mode when DB credentials are not present', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const res = await recapRunner.main(['--dry-run', '--date=2026-09-04']);
    assert.equal(res.dry_run, true);
    assert.equal(res.fallback, true);
    assert.match(res.message, /REKAP SORE PERFORMA SINYAL AUTO-CUAN/);
    assert.match(res.message, /Jumat, 4 September 2026/);
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});
