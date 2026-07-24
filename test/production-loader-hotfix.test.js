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

test('startup fallback is bounded and only runs while the loader remains visible', () => {
  assert.match(html, /function renderStartupFallback\s*\(\)/);
  assert.match(html, /catch \(_\) \{[\s\S]{0,180}renderStartupFallback\(\)/);
  assert.match(html, /setTimeout\(function\(\) \{ var loader = document\.getElementById\('initialLoader'\); if \(loader && !loader\.classList\.contains\('hidden'\)\) renderStartupFallback\(\); \}, 4500\)/);
  assert.match(html, /Beberapa fitur sementara tidak tersedia\./);
});

test('top-level views and core authenticated navigation remain mutually exclusive', () => {
  for (const id of ['initialLoader', 'landingPage', 'dashboardScreen', 'blockedScreen', 'maintenanceScreen']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must be unique`);
  }
  for (const page of ['sektor', 'screener', 'portofolio']) {
    assert.match(html, new RegExp(`navigateTo\\('${page}'\\)`));
  }
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length, 12);
});

test('cancelled subscription UI, startup calls, and routes are absent', () => {
  for (const retired of ['page-subscription', 'openSubscriptionPage', 'voucher', 'premiumAccessState', 'data-premium-nav', 'subscription-plans', 'premium-access-status']) {
    assert.equal(html.toLowerCase().includes(retired.toLowerCase()), false, `${retired} must be absent`);
  }
  assert.doesNotMatch(html, />\s*Langganan\s*</);
  assert.doesNotMatch(html, /premium-access-status/);
});

test('obsolete browser block state is cleared rather than enforced', () => {
  assert.match(html, /function clearLegacyDeviceBlock\(\)/);
  assert.match(html, /localStorage\.removeItem\('autocuan_blocked_until'\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\('autocuan_blocked_until'/);
});
