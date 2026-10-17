'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vpsFetcher = require('../lib/vps-data-fetcher.js');
const constants = require('../lib/daily-market-context-constants.js');
const ecosystem = require('../ecosystem.config.js');

test('FIX-11: VPS_DATA_API_BASE defaults to http://127.0.0.1:3001 and not trycloudflare', () => {
  assert.equal(typeof vpsFetcher.getVpsDataApiBase, 'function');
  const base = vpsFetcher.getVpsDataApiBase();
  assert.equal(base, 'http://127.0.0.1:3001', 'Default VPS bridge base URL must be http://127.0.0.1:3001');
  assert.doesNotMatch(base, /trycloudflare\.com/, 'Must not point to dead trycloudflare URL');
});

test('FIX-11: ecosystem.config.js preserves 5 apps and injects VPS_DATA_API_BASE=http://127.0.0.1:3001', () => {
  assert.ok(Array.isArray(ecosystem.apps));
  assert.equal(ecosystem.apps.length, 5, 'Must keep exactly 5 PM2 apps');

  const appNames = ecosystem.apps.map(a => a.name);
  assert.deepEqual(appNames, [
    'autocuan-web',
    'auto-cuan-vps-api',
    'autocuan-bot',
    'autocuan-web-tunnel',
    'autocuan-verify-bot'
  ]);

  const webApp = ecosystem.apps.find(a => a.name === 'autocuan-web');
  assert.equal(webApp.env.VPS_DATA_API_BASE, 'http://127.0.0.1:3001');

  const botApp = ecosystem.apps.find(a => a.name === 'autocuan-bot');
  assert.equal(botApp.env.VPS_DATA_API_BASE, 'http://127.0.0.1:3001');
});

test('FIX-11: HISTORY_RETENTION_TRADING_SESSIONS defaults to 650 sessions for MA200 coverage', () => {
  assert.equal(constants.HISTORY_RETENTION_TRADING_SESSIONS, 650, 'History retention must be 650 sessions');
});
