'use strict';

/**
 * Tests for report-telegram-outcomes.js
 * Tests the fetchDailyPicks function using REST API (no WebSocket)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Test URL normalization logic (matches implementation)
function normalizeSupabaseUrl(url) {
  return url.replace(/\/rest\/v1\/?$/, '');
}

test('normalizeSupabaseUrl handles base URL without /rest/v1', () => {
  assert.equal(
    normalizeSupabaseUrl('https://test.supabase.co'),
    'https://test.supabase.co'
  );
});

test('normalizeSupabaseUrl handles URL with /rest/v1 trailing slash', () => {
  assert.equal(
    normalizeSupabaseUrl('https://test.supabase.co/rest/v1/'),
    'https://test.supabase.co'
  );
});

test('normalizeSupabaseUrl handles URL with /rest/v1 without trailing slash', () => {
  assert.equal(
    normalizeSupabaseUrl('https://test.supabase.co/rest/v1'),
    'https://test.supabase.co'
  );
});

// Set up env vars BEFORE loading the module
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.DAYS_BACK = '7';

// Clear require cache to ensure fresh load with env vars
delete require.cache[require.resolve('../tools/report-telegram-outcomes.js')];

const { generateReport, formatConsoleReport } = require('../tools/report-telegram-outcomes.js');

test('generateReport computes correct stats from picks', () => {
  const picks = [
    { id: 1, ticker: 'BBRI', date: '2025-01-01', raw_payload: { score: 75, monitor_source: 'daytrade' }, status: 'closed', hit_tp2_at: '2025-01-01T10:00:00Z' },
    { id: 2, ticker: 'BMRI', date: '2025-01-02', raw_payload: { score: 82, monitor_source: 'daytrade' }, status: 'closed', hit_tp1_at: '2025-01-02T10:00:00Z' },
    { id: 3, ticker: 'BBNI', date: '2025-01-03', raw_payload: { score: 45, monitor_source: 'watchlist' }, status: 'open' }
  ];
  
  const stats = generateReport(picks);
  
  assert.equal(stats.total, 3, 'total should be 3');
  assert.equal(stats.bySource.daytrade, 2, 'daytrade count should be 2');
  assert.equal(stats.bySource.watchlist, 1, 'watchlist count should be 1');
});

test('formatConsoleReport does not expose API keys', () => {
  const stats = {
    total: 10,
    bySource: { screener: 8, manual: 2 },
    entryCount: 10,
    tp1Count: 6,
    tp2Count: 4,
    slCount: 3,
    waitingCount: 0,
    runningCount: 0,
    expiredCount: 0,
    entryRate: '100%',
    tp1Rate: '60%',
    tp2Rate: '40%',
    slRate: '30%',
    scoreBuckets: {},
    avgTimeToEntry: 2.5,
    avgTimeToTp1: 4.2,
    avgTimeToTp2: 6.1,
    avgTimeToSl: 3.8,
    outcomesByStatus: { closed: 10 },
    outcomesBySource: {},
    observations: ['Test observation']
  };
  
  const output = formatConsoleReport(stats);
  
  assert.equal(output.includes('TELEGRAM DAILY PICKS - OUTCOME REPORT'), true);
  assert.equal(output.includes('Total monitored picks: 10'), true);
  
  // These should NOT be in the output (secret exposure check)
  assert.equal(output.includes('test-key'), false, 'Should not contain API key');
  assert.equal(output.includes('SUPABASE_SERVICE_ROLE_KEY'), false, 'Should not contain env var name');
});

test('fetchDailyPicks is exported as function', () => {
  // Re-require to check exports
  delete require.cache[require.resolve('../tools/report-telegram-outcomes.js')];
  const exports = require('../tools/report-telegram-outcomes.js');
  
  assert.equal(typeof exports.fetchDailyPicks, 'function', 'fetchDailyPicks should be a function');
  assert.equal(typeof exports.generateReport, 'function', 'generateReport should be a function');
  assert.equal(typeof exports.formatConsoleReport, 'function', 'formatConsoleReport should be a function');
});
test('generateReport includes age averages and expired age buckets by source', () => {
  const { generateReport, formatConsoleReport, formatMarkdownReport } = require('../tools/report-telegram-outcomes.js');
  const now = '2026-07-07T00:00:00Z';
  const daysAgo = (days) => new Date(new Date(now).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const picks = [
      { id: 1, date: daysAgo(0).slice(0, 10), first_sent_at: daysAgo(0), raw_payload: { monitor_source: 'daytrade' }, status: 'EXPIRED' },
      { id: 2, date: daysAgo(2).slice(0, 10), first_sent_at: daysAgo(2), raw_payload: { monitor_source: 'swing_konglo' }, status: 'EXPIRED' },
      { id: 3, date: daysAgo(6).slice(0, 10), first_sent_at: daysAgo(6), raw_payload: { monitor_source: 'swing_nk' }, status: 'EXPIRED' },
      { id: 4, date: daysAgo(1).slice(0, 10), first_sent_at: daysAgo(1), raw_payload: { monitor_source: 'swing_nk' }, status: 'WAITING' }
    ];

  const stats = generateReport(picks, { now });
  assert.equal(stats.ageBySource.daytrade.count, 1);
  assert.equal(stats.expiredAgeBucketsBySource.daytrade['0-1d'], 1);
  assert.equal(stats.expiredAgeBucketsBySource.swing_konglo['2-3d'], 1);
  assert.equal(stats.expiredAgeBucketsBySource.swing_nk['6+d'], 1);

  const consoleOutput = formatConsoleReport(stats);
  const markdownOutput = formatMarkdownReport(stats);
  assert.match(consoleOutput, /AGE BY SOURCE/);
  assert.match(consoleOutput, /Expired 0-1d/);
  assert.match(markdownOutput, /## Age by Source/);
  assert.match(markdownOutput, /Expired 6\+d/);
});
