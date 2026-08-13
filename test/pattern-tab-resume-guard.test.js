'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const guard = require('../public/pattern-tab-resume-guard');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('fresh admin access is preserved across duplicate focus and visibility refreshes', async () => {
  let refreshCalls = 0;
  const original = {
    allowed:true,
    isAllowed() { return this.allowed; },
    refresh() { refreshCalls += 1; return Promise.resolve(true); },
    deny() { this.allowed = false; return false; }
  };
  const stable = guard.createStableGate(original);
  assert.deepEqual(await Promise.all([stable.refresh(true), stable.refresh(true), stable.refresh(false)]), [true, true, true]);
  assert.equal(refreshCalls, 0);
  assert.equal(stable.isAllowed(), true);
});

test('missing access reuses one non-forced server verification instead of cancelling requests', async () => {
  let refreshCalls = 0;
  let resolveRefresh;
  const original = {
    allowed:false,
    isAllowed() { return this.allowed; },
    refresh(force) {
      refreshCalls += 1;
      assert.equal(force, false);
      return new Promise(resolve => { resolveRefresh = () => { this.allowed = true; resolve(true); }; });
    },
    deny() { this.allowed = false; return false; }
  };
  const stable = guard.createStableGate(original);
  const first = stable.refresh(true);
  const second = stable.refresh(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  resolveRefresh();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('the resume guard no longer competes for ownership of level labels', () => {
  // Level text is emitted, direction-correct, by the Pattern renderer. Two
  // modules rewriting the same nodes is what produced the label drift this
  // guard used to paper over, so the rewrite lives in exactly one place now.
  assert.equal(typeof guard.normalizeLevelLabel, 'undefined');
  assert.equal(typeof guard.normalizePatternLevels, 'undefined');
  assert.doesNotMatch(read('public/pattern-tab-resume-guard.js'), /Entry \/ Konfirmasi|Stop Loss \/ Invalidasi/);
});

test('resume guard restores /pattern without scanning, Telegram, DB, or production mutations', () => {
  const source = read('public/pattern-tab-resume-guard.js');
  new vm.Script(source, { filename:'pattern-tab-resume-guard.js' });
  assert.match(source, /pageshow/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /restorePatternPage/);
  assert.match(source, /page\.classList\.remove\('hidden'\)/);
  assert.doesNotMatch(source, /scan\(|\/api\/candles|sendTelegram|telegramNotifier|supabase\.from|createOrder|production_state/i);
});
