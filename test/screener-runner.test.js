'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../tools/run-screener');

test('analyze reports a missing snapshot as the primary diagnosis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  const report = runner.analyze(
    { mode: 'daytrade', dryRun: true, send: false, json: false },
    { rootDir: root, env: {}, now: new Date('2026-09-24T04:00:00Z') }
  );
  assert.equal(report.snapshot_missing, true);
  assert.equal(report.candidate_count, 0);
  assert.equal(report.healthy, false);
  assert.equal(report.reasons.some((r) => r.indexOf('snapshot_missing') === 0), true);
});

test('analyze surfaces no_candidates when the snapshot exists but the mode is empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [], swing: [], updated_at: '2026-09-24'
  }));
  const report = runner.analyze(
    { mode: 'daytrade', dryRun: true, send: false, json: false },
    { rootDir: root, env: {}, now: new Date('2026-09-24T04:00:00Z') }
  );
  assert.equal(report.snapshot_missing, false);
  assert.equal(report.candidate_count, 0);
  assert.equal(report.reasons.some((r) => r.indexOf('no_candidates') === 0), true);
});

test('analyze is healthy when candidates exist and no blocking reason remains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 88 }, { ticker: 'BBRI', score: 80 }],
    updated_at: '2026-09-24'
  }));
  const report = runner.analyze(
    { mode: 'daytrade', dryRun: true, send: false, json: false },
    { rootDir: root, env: {}, now: new Date('2026-09-24T04:00:00Z') }
  );
  assert.equal(report.candidate_count, 2);
  assert.equal(report.healthy, true);
  assert.match(report.message, /BBCA/);
});

test('formatCard renders the top 10 with scores', () => {
  const card = runner.formatCard('swing', [
    { ticker: 'BBCA', score: 91 },
    { ticker: 'BBRI', fusion_score: 77 }
  ], '2026-09-24');
  assert.match(card, /Screener Swing/);
  assert.match(card, /1\. BBCA \(score 91\)/);
  assert.match(card, /2\. BBRI \(score 77\)/);
});

test('main dry-run never sends and returns a non-zero code when empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  let sent = false;
  const out = await runner.main(
    ['node', 'run-screener.js', '--mode=daytrade', '--dry-run'],
    {
      rootDir: root,
      env: {},
      log: () => {},
      notifier: { sendTelegramMessage: async () => { sent = true; return { sent: true }; } }
    }
  );
  assert.equal(sent, false);
  assert.equal(out.exitCode, 2);
});

test('main --send uses skip_market_guard for the after-session recap (same-day fresh snapshot)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-24'
  }));
  let options = null;
  const out = await runner.main(
    ['node', 'run-screener.js', '--mode=daytrade', '--send'],
    {
      rootDir: root,
      // BUG-3C-02: --send requires the snapshot to represent the current WIB
      // trading date. 2026-09-24 (Thursday) matches the fixture's updated_at.
      now: new Date('2026-09-24T04:00:00Z'),
      env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' },
      log: () => {},
      notifier: { sendTelegramMessage: async (_text, opts) => { options = opts; return { sent: true }; } }
    }
  );
  assert.equal(out.exitCode, 0);
  assert.equal(options.skip_market_guard, true);
  assert.equal(out.report.freshness.fresh, true);
});

test('BUG-3C-02: main --send fails closed on a stale snapshot and never calls Telegram', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  // Two sessions old: stale even for the daytrade latest-completed-session rule.
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-22'
  }));
  let sent = false;
  const lines = [];
  const out = await runner.main(
    ['node', 'run-screener.js', '--mode=daytrade', '--send'],
    {
      rootDir: root,
      now: new Date('2026-09-24T04:00:00Z'),
      env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' },
      log: (line) => lines.push(String(line)),
      notifier: { sendTelegramMessage: async () => { sent = true; return { sent: true }; } }
    }
  );
  assert.equal(sent, false, 'stale snapshot must never reach the Telegram notifier');
  assert.equal(out.exitCode, 2);
  assert.equal(out.blocked, 'STALE_SNAPSHOT');
  assert.equal(out.report.freshness.fresh, false);
  assert.equal(out.report.freshness.reason, 'STALE_SNAPSHOT');
  assert.ok(lines.some((l) => l.indexOf('STALE_SNAPSHOT') === 0), 'log must carry the STALE_SNAPSHOT reason');
});

test('BUG-3C-02: daytrade --send accepts the latest completed session (pre-producer morning run)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  // Thursday 09:30 WIB (02:30 UTC) with Wednesday's EOD snapshot: the 19:00 WIB
  // producer for Thursday has not run yet, so Wednesday IS the applicable data.
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-23'
  }));
  let sent = false;
  const out = await runner.main(
    ['node', 'run-screener.js', '--mode=daytrade', '--send'],
    {
      rootDir: root,
      now: new Date('2026-09-24T02:30:00Z'),
      env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' },
      log: () => {},
      notifier: { sendTelegramMessage: async () => { sent = true; return { sent: true }; } }
    }
  );
  assert.equal(out.report.freshness.fresh, true, 'previous session is acceptable for daytrade');
  assert.equal(sent, true, 'the scheduled DayTrade run must not be structurally silenced');
  assert.equal(out.exitCode, 0);
});

test('BUG-3C-02: swing EOD --send still blocks the previous session (the real 2026-10-01 failure)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-screener-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  // Thursday 19:15 WIB (12:15 UTC) with Wednesday's snapshot: exactly the stale
  // broadcast the audit found on 2026-10-01 for the swing runners.
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    swing: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-23'
  }));
  let sent = false;
  const out = await runner.main(
    ['node', 'run-screener.js', '--mode=swing-konglo', '--send'],
    {
      rootDir: root,
      now: new Date('2026-09-24T12:15:00Z'),
      env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' },
      log: () => {},
      notifier: { sendTelegramMessage: async () => { sent = true; return { sent: true }; } }
    }
  );
  assert.equal(sent, false, 'swing EOD must not broadcast a previous-day snapshot');
  assert.equal(out.exitCode, 2);
  assert.equal(out.blocked, 'STALE_SNAPSHOT');
});

test('marketStatus reports a closed market for a weekend', () => {
  const status = runner.marketStatus(new Date('2026-09-26T04:00:00Z')); // Saturday
  assert.equal(status.isOpen, false);
  assert.equal(status.reason, 'weekend');
});

test('marketStatus reports LIVE_MARKET during session 1 on a weekday', () => {
  const status = runner.marketStatus(new Date('2026-09-24T02:30:00Z')); // 09:30 WIB Thursday
  assert.equal(status.isOpen, true);
  assert.equal(status.status, 'LIVE_MARKET');
});
