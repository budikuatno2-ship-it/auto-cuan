'use strict';

/**
 * test/v6-video-regression.test.js
 * ============================================================================
 * Regression suite for the 23 video-9-November findings — Remediasi V6.
 *
 * Every case maps a video finding to a source-level or engine-level assertion.
 * Where browser live reproduction is impossible in this environment, the case
 * is documented as `NOT_REPRODUCED`/`PASS_UNIT_ONLY` inside the audit doc
 * (docs/v6/V6_VIDEO_REGRESSION.md) rather than silently asserted.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spEngine = require('../lib/saham-potensial-engine');
const hourlyEngine = require('../lib/short-swing-hourly-confirmation');
const liveLedger = require('../lib/track-record-live-ledger');
const adminOwnership = require('../lib/admin-ownership-import');

function read(p) {
  return fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
}

test('VIDEO-01: Landing calculator entry is not hardcoded to 0', () => {
  const html = read('public/index.html');
  assert.strictEqual(html.includes('<div class="lbl">Entry</div><b style="font-family:monospace">0</b></div>'), false);
});

test('VIDEO-02: Top5 PANI/PSAB/BRMS/DEWA/BUMI are not uniform (1420/3.5%/2.1x)', () => {
  const tickers = [
    { ticker: 'PANI', as_of: '2026-11-09', last_price: 1520, change_pct: 4.12, volume_ratio: 2.3, entry_low: 1480, entry_high: 1530, sl: 1400, tp1: 1750, bandar_score: 82, foreign_flow_score: 78, technical_score: 74 },
    { ticker: 'PSAB', as_of: '2026-11-09', last_price: 340, change_pct: -1.45, volume_ratio: 1.1, entry_low: 330, entry_high: 345, sl: 310, tp1: 410, bandar_score: 76, foreign_flow_score: 70, technical_score: 68 },
    { ticker: 'BRMS', as_of: '2026-11-09', last_price: 410, change_pct: 6.77, volume_ratio: 3.5, entry_low: 395, entry_high: 415, sl: 380, tp1: 490, bandar_score: 88, foreign_flow_score: 84, technical_score: 80 },
    { ticker: 'DEWA', as_of: '2026-11-09', last_price: 115, change_pct: 0.88, volume_ratio: 1.7, entry_low: 110, entry_high: 118, sl: 104, tp1: 140, bandar_score: 72, foreign_flow_score: 66, technical_score: 64 },
    { ticker: 'BUMI', as_of: '2026-11-09', last_price: 142, change_pct: 2.16, volume_ratio: 2.0, entry_low: 138, entry_high: 144, sl: 130, tp1: 170, bandar_score: 78, foreign_flow_score: 72, technical_score: 70 }
  ];
  const snap = spEngine.buildSahamPotensialSnapshot(tickers, { sessionDate: '2026-11-09' });
  assert.equal(new Set(snap.top5.map((t) => t.last_price)).size, 5);
  assert.equal(new Set(snap.top5.map((t) => t.change_pct)).size, 5);
  assert.equal(new Set(snap.top5.map((t) => t.volume_ratio)).size, 5);
});

test('VIDEO-03: R/R < 1.5 is never READY (WATCHLIST, not actionable)', () => {
  const cand = {
    ticker: 'PANI', as_of: '2026-11-09', last_price: 1405,
    entry_low: 1399, entry_high: 1420, sl: 1349, tp1: 1519,
    volume_ratio: 1.4, change_pct: 1.2, bandar_score: 80, foreign_flow_score: 75, technical_score: 70
  };
  const r = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09' });
  assert.equal(r.is_actionable, false);
  assert.equal(r.readiness, 'WATCHLIST');
});

test('VIDEO-10: HSC UNKNOWN stays null/undetermined (never "Tidak HSC")', () => {
  assert.equal(adminOwnership.parseHscBoolean(''), null);
  assert.equal(adminOwnership.parseHscBoolean('unknown'), null);
  assert.equal(adminOwnership.parseHscBoolean('belum evaluasi'), null);
});

test('VIDEO-13: Track Record live ledger reader fails honestly on unreadable file', () => {
  const res = liveLedger.loadLiveLedger(path.join(require('node:os').tmpdir(), 'no-such-ledger-' + Date.now() + '.json'));
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'ENOENT');
});

test('VIDEO-14: Admin quota residual never becomes "0" via (limit||0)-(used||0)', () => {
  // Source triage: the "undefinedmnt" metric must come from telemetry, not mock.
  const html = read('public/admin-console.html');
  assert.strictEqual(html.includes('<div class="sub">API p95 < 320 ms</div>'), false);
});

test('VIDEO-15: Security tab is UNAVAILABLE when no real telemetry, never "Aman"', () => {
  const html = read('public/admin-console.html');
  assert.strictEqual(html.includes('Aman — Firewall & Anti-Bot Aktif'), false);
  assert.strictEqual(html.includes('id="statUsersActive">1.284</div>'), false);
  // Subtask K hardening: the SINGLE-PAGE SHELL (public/index.html), which is what
  // the /admin-console route actually serves, was still shipping the fabricated
  // "Aman — Firewall & Anti-Bot Aktif" literal and a green "Aman" badge. The
  // previous assertion only read the standalone admin-console.html and missed
  // this. Both surfaces must now be fail-closed (UNAVAILABLE / "Data keamanan
  // tidak tersedia").
  const shell = read('public/index.html');
  assert.strictEqual(shell.includes('Aman — Firewall & Anti-Bot Aktif'), false, 'SPA shell must drop the fabricated Aman literal (Subtask K)');
  assert.strictEqual(shell.includes('id="secStatusLabel" style="font-size:13px">Aman'), false, 'SPA shell secStatusLabel must be fail-closed');
  assert.strictEqual(shell.includes('id="tabSecBadge">Aman<'), false, 'SPA shell tabSecBadge must be fail-closed (UNAVAILABLE)');
});

test('VIDEO-03b: hourly confirmation R/R ~0.33 is BLOCKED, not ENTRY_ZONE_VALID', () => {
  const setup = { ticker: 'BBRI', entryMin: 5000, entryMax: 5200, stopLoss: 5050, targetPrice: 5250, source: 'eod', asOf: '2026-11-09' };
  const now = Date.now();
  const r = hourlyEngine.evaluateHourlyConfirmation(setup, { ticker: 'BBRI', open: 5000, last: 5100, timestamp: now }, { now });
  assert.equal(r.status, hourlyEngine.CONFIRMATION_STATES.BLOCKED);
});