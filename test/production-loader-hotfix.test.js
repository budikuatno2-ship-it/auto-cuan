'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('every inline script in the production page parses', () => {
  let count = 0;
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    count += 1;
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${count} must parse`);
  }
  assert.ok(count > 0);
});

test('startup always has a public landing fallback and a bounded watchdog', () => {
  assert.match(html, /function renderStartupFallback\(\)/);
  assert.match(html, /catch \(_\) \{[\s\S]{0,180}renderStartupFallback\(\)/);
  assert.match(html, /finally \{[\s\S]{0,120}initialLoader/);
  assert.match(html, /setTimeout\(function\(\) \{ if \(document\.getElementById\('initialLoader'\)\) renderStartupFallback\(\); \}, 4500\)/);
  assert.match(html, /Beberapa fitur sementara tidak tersedia\./);
});

test('unprovisioned subscription controls fail closed without startup requests', () => {
  assert.match(html, /id="subscriptionTelegramLink"[^>]*disabled/);
  assert.match(html, /id="subscriptionTrialActivate"[^>]*disabled/);
  assert.match(html, /Fitur langganan sedang disiapkan\./);
  assert.doesNotMatch(html.slice(html.indexOf('function safeRequestId')), /subscription-trial-activate[\s\S]{0,500}crypto\.randomUUID\(\)/);
  assert.match(html, /function safeRequestId\(\) \{ return generateDeviceUuid\(\); \}/);
  assert.match(html, /AbortController/);
  assert.match(html, /response\.ok/);
  assert.match(html, /application\/json/);
});

test('critical DOM ids are unique and api endpoint boundary remains unchanged', () => {
  for (const id of ['initialLoader', 'landingPage', 'dashboardScreen', 'blockedScreen', 'maintenanceScreen']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must be unique`);
  }
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length, 12);
  assert.equal((html.match(/id="deleteUser/gi) || []).length, 0, 'no Delete User control');
});
