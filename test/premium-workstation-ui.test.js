'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('premium workstation stylesheet is loaded after the base theme', () => {
  const html = read('public/index.html');
  const themeAt = html.indexOf('/ui-theme.css?v=');
  const premiumAt = html.indexOf('/premium-workstation.css?v=20260818-v1');
  assert.ok(themeAt > 0, 'base UI theme link missing');
  assert.ok(premiumAt > themeAt, 'premium workstation layer must load after ui-theme.css');
  assert.equal((html.match(/premium-workstation\.css\?v=20260818-v1/g) || []).length, 1);
});

test('premium workstation keeps a restrained trading UI contract', () => {
  const css = read('public/premium-workstation.css');
  assert.match(css, /--pw-bg:\s*#070a0f/);
  assert.match(css, /--pw-accent:\s*#2dd4a3/);
  assert.match(css, /\.landing-gradient-text[\s\S]*background:\s*none\s*!important/);
  assert.match(css, /\.dashboard-hero::before/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('premium workstation CSS is presentation-only', () => {
  const css = read('public/premium-workstation.css');
  assert.doesNotMatch(css, /fetch\s*\(/i);
  assert.doesNotMatch(css, /supabase/i);
  assert.doesNotMatch(css, /telegram/i);
  assert.doesNotMatch(css, /daytrade_score|swing_score|entry_price|stop_loss|take_profit/i);
});

test('premium workstation asset is cacheable while API no-store remains intact', () => {
  const config = JSON.parse(read('vercel.json'));
  const api = (config.headers || []).find((row) => row.source === '/api/(.*)');
  const premium = (config.headers || []).find((row) => row.source === '/premium-workstation.css');
  assert.ok(api, 'API cache rule missing');
  assert.ok(premium, 'premium workstation cache rule missing');
  const apiCache = api.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  const premiumCache = premium.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
  assert.match(apiCache, /no-store/);
  assert.match(premiumCache, /public/);
  assert.doesNotMatch(premiumCache, /no-store/);
});
