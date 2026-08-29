'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('api/sector-hot.js', 'utf8');

test('CRON_SECRET is accepted only from Bearer authorization, not query string', () => {
  const start = source.indexOf('function verifyCronSecret(req)');
  const end = source.indexOf('function isWithinNkRunWindow', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /req\.query\.secret|querySecret/);
  assert.match(block, /authorization/);
  assert.match(block, /timingSafeEqual/);
});

test('all 5 cron and management handlers use timing-safe verifyCronSecret rather than string comparison', () => {
  const handlers = [
    'async function handleScreenerRefresh',
    'async function handleRefresh',
    'async function handleCreateScreenerShareLink',
    'async function handleWebTop5HistoryArchive',
    'async function handleDayTradeScreenerRun'
  ];

  for (const handlerName of handlers) {
    const start = source.indexOf(handlerName);
    assert.ok(start !== -1, handlerName + ' must exist in api/sector-hot.js');
    const snippet = source.slice(start, start + 300);
    assert.match(snippet, /verifyCronSecret\(req\)/, handlerName + ' must call verifyCronSecret(req)');
    assert.doesNotMatch(snippet, /!==\s*CRON_SECRET/, handlerName + ' must not do direct string comparison !== CRON_SECRET');
  }
});

