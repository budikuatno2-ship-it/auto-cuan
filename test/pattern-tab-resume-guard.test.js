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

test('Pattern level labels expose Entry and Stop Loss while preserving TP1 and TP2', () => {
  assert.equal(guard.normalizeLevelLabel('Konfirmasi'), 'Entry / Konfirmasi');
  assert.equal(guard.normalizeLevelLabel('Invalidasi'), 'Stop Loss / Invalidasi');
  assert.equal(guard.normalizeLevelLabel('TP1'), 'TP1');
  assert.equal(guard.normalizeLevelLabel('TP2'), 'TP2');
});

test('resume guard restores /pattern without scanning, Telegram, DB, or production mutations', () => {
  const source = read('public/pattern-tab-resume-guard.js');
  new vm.Script(source, { filename:'pattern-tab-resume-guard.js' });
  assert.match(source, /pageshow/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /restorePatternPage/);
  assert.match(source, /page\.classList\.remove\('hidden'\)/);
  assert.match(source, /Entry \/ Konfirmasi/);
  assert.match(source, /Stop Loss \/ Invalidasi/);
  assert.doesNotMatch(source, /scan\(|\/api\/candles|sendTelegram|telegramNotifier|supabase\.from|createOrder|production_state/i);
});
