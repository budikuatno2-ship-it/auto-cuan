'use strict';

/**
 * Batch 19 — Pemantauan Sesi Bursa Langsung (Live Monitoring)
 *
 * Membuktikan harness observability live-session:
 *   1. Menyusun laporan konsolidasi (session, market_state, keputusan per-path).
 *   2. Gate telegram monitor & fast-watcher SEPAKAT pada instan yang sama.
 *   3. Saat istirahat/closed semua path diblokir dengan alasan jelas.
 *   4. Kill-switch fast-watcher mematikan path meski pasar buka.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLiveSessionReport, parseArgs } = require('../tools/live-session-monitor');

function wibToUtcIso(dateKey, wibTime) {
  const [h, m] = String(wibTime).split(':').map(Number);
  const [y, mo, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 7, m)).toISOString();
}
const THU = '2026-09-17'; // Kamis

test('Batch 19: during an active session both live paths are allowed', () => {
  const r = buildLiveSessionReport(wibToUtcIso(THU, '10:00'), { FAST_WATCHER_LIVE_ENABLED: '1' });
  assert.equal(r.session, 'SESSION_1');
  assert.equal(r.is_market_open, true);
  assert.equal(r.market_state, 'ACTIVE_SESSION');
  assert.equal(r.paths.telegram_monitor.allowed, true);
  assert.equal(r.paths.fast_watcher_guarded_live.allowed, true);
});

test('Batch 19: during the 12:45 WIB break every live path is blocked', () => {
  const r = buildLiveSessionReport(wibToUtcIso(THU, '12:45'), { FAST_WATCHER_LIVE_ENABLED: '1' });
  assert.equal(r.session, 'CLOSED');
  assert.equal(r.is_market_open, false);
  assert.equal(r.market_state, 'MARKET_BREAK');
  assert.equal(r.paths.telegram_monitor.allowed, false);
  assert.equal(r.paths.fast_watcher_guarded_live.allowed, false);
  assert.equal(r.paths.fast_watcher_guarded_live.reason, 'market_closed');
});

test('Batch 19: the two gates agree on every probed instant', () => {
  const probes = ['09:30', '12:45', '14:00', '16:30'];
  for (const t of probes) {
    const r = buildLiveSessionReport(wibToUtcIso(THU, t), { FAST_WATCHER_LIVE_ENABLED: '1' });
    assert.equal(
      r.paths.telegram_monitor.allowed,
      r.paths.fast_watcher_guarded_live.allowed,
      `gates disagree at ${t} WIB`
    );
  }
});

test('Batch 19: fast-watcher kill-switch disables the path even during market hours', () => {
  const r = buildLiveSessionReport(wibToUtcIso(THU, '10:00'), { FAST_WATCHER_LIVE_ENABLED: '0' });
  assert.equal(r.is_market_open, true);
  assert.equal(r.paths.fast_watcher_guarded_live.live_enabled, false);
  assert.equal(r.paths.fast_watcher_guarded_live.allowed, false);
  assert.equal(r.paths.fast_watcher_guarded_live.reason, 'kill_switch_off');
  // Telegram monitor path is unaffected by the fast-watcher switch.
  assert.equal(r.paths.telegram_monitor.allowed, true);
});

test('Batch 19: weekend is fully closed for every path', () => {
  const saturday = '2026-09-19';
  const r = buildLiveSessionReport(wibToUtcIso(saturday, '10:00'), { FAST_WATCHER_LIVE_ENABLED: '1' });
  assert.equal(r.session, 'CLOSED');
  assert.equal(r.is_market_open, false);
  assert.equal(r.paths.telegram_monitor.allowed, false);
  assert.equal(r.paths.fast_watcher_guarded_live.allowed, false);
});

test('Batch 19: parseArgs reads --at and --json', () => {
  const args = parseArgs(['--at', '2026-09-17T03:00:00Z', '--json']);
  assert.equal(args.at, '2026-09-17T03:00:00Z');
  assert.equal(args.json, true);
  assert.equal(parseArgs([]).json, false);
});