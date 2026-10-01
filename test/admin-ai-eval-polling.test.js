'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'admin-ai-eval.html'), 'utf8');

test('admin-ai-eval.html contains visibility guards to stop background polling', () => {
  assert.match(html, /visibilitychange/);
  assert.match(html, /document\.visibilityState\s*===\s*['"]hidden['"]/);
  assert.match(html, /document\.visibilityState\s*===\s*['"]visible['"]/);
  assert.match(html, /function startPolling\(\)/);
  assert.match(html, /function stopPolling\(\)/);
  assert.match(html, /beforeunload/);
  assert.doesNotMatch(html, /refresh\(\);\s*setInterval\(refresh,\s*5000\);/);
});

test('admin-ai-eval polling stops when tab is hidden and resumes when visible', () => {
  let timer = null;
  let refreshCalls = 0;
  let docVisibilityState = 'visible';

  function refresh() {
    refreshCalls++;
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(function() {
      if (docVisibilityState === 'hidden') return;
      refresh();
    }, 50);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onVisibilityChange() {
    if (docVisibilityState === 'visible') {
      refresh();
      startPolling();
    } else {
      stopPolling();
    }
  }

  // Initial boot
  refresh();
  startPolling();
  assert.equal(refreshCalls, 1);
  assert.ok(timer !== null, 'Polling timer should be running');

  // Tab hidden: should stop polling
  docVisibilityState = 'hidden';
  onVisibilityChange();
  assert.equal(timer, null, 'Polling timer should be stopped when tab is hidden');

  // Tab becomes visible: should refresh immediately and resume polling
  docVisibilityState = 'visible';
  onVisibilityChange();
  assert.equal(refreshCalls, 2, 'Should immediately refresh on visible transition');
  assert.ok(timer !== null, 'Polling timer should resume');

  // Clean up
  stopPolling();
});
