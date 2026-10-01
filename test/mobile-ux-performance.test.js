'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const dtRuntime = fs.readFileSync(path.join(ROOT, 'public', 'daytrade-runtime.js'), 'utf8');

test('PR 5: Mobile touch targets have minimum 44px height and touch-action manipulation', () => {
  assert.match(theme, /min-height:\s*var\(--ac-control-h-touch,\s*44px\);/);
  assert.match(theme, /touch-action:\s*manipulation;/);
});

test('PR 5: Page content has mobile bottom padding to clear the floating navigation launcher', () => {
  assert.match(theme, /padding-bottom:\s*calc\(var\(--ac-fab-size,\s*56px\)\s*\+\s*var\(--ac-safe-bottom,\s*16px\)\s*\+\s*24px\);/);
});

test('PR 5: Polling timers for all screeners include document.hidden visibility guards', () => {
  // Konglo screener polling
  assert.match(html, /function startScreenerPolling\(\)[\s\S]*?if\s*\(document\.hidden\)\s*return;/);
  // Non-Konglo screener polling
  assert.match(html, /function startNkPolling\(\)[\s\S]*?if\s*\(document\.hidden\)\s*return;/);
  // Day Trade screener polling
  assert.match(dtRuntime, /function startDtPolling\(\)[\s\S]*?if\s*\(document\.hidden\)\s*return;/);
  // Dashboard monitor auto refresh
  assert.match(html, /function startDashboardMonitorAutoRefresh\(\)[\s\S]*?!document\.hidden/);
});

test('PR 5: Card click and modal backdrop listeners are consolidated via centralized event delegation', () => {
  assert.match(html, /CENTRALIZED EVENT DELEGATION MANAGER/);
  assert.match(html, /var dtCard\s*=\s*e\.target\.closest\('\.dt-card-item'\)/);
  assert.match(html, /var kgCard\s*=\s*e\.target\.closest\('\.kg-card-item'\)/);
  assert.match(html, /var nkCard\s*=\s*e\.target\.closest\('\.nk-card-item'\)/);
});
