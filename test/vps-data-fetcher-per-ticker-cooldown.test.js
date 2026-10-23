'use strict';

// B2 (22 Oct 2026) — root cause of the `vps_local_cache_stale` flood (52,278
// lines): the bridge cooldown was a SINGLE process-global timestamp. When one
// ticker's HTTP probe timed out, `lastHttpBridgeFailure` was set and EVERY other
// ticker then skipped the bridge for a full 60s, each falling through to an
// out-of-window local snapshot labelled `vps_local_cache_stale`. The `else`
// branch that ran on a failed probe wrote no reason, so the blackout was silent.
//
// This fixes that by (a) keying the cooldown per ticker, (b) raising the probe
// timeout to 8s, and (c) logging a rate-limited reason with ticker + kind +
// duration. These tests pin the invariants with no network access.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fetcher = require('../lib/vps-data-fetcher');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vps-data-fetcher.js'), 'utf8');

test('B2: the bridge probe timeout was raised from 3s to 8s', () => {
  assert.equal(fetcher.HTTP_BRIDGE_TIMEOUT_MS, 8000);
  // A cold-tunnel handshake near 2.5s used to abort; the source must not still
  // hard-code the old 3000ms ceiling for the live-price probe.
  assert.doesNotMatch(SOURCE, /broker-summary\?ticker=\$\{encodeURIComponent\(clean\)\}&date=latest`,\s*3000/);
});

test('B2: a failure on ONE ticker does not mute the bridge for ANOTHER ticker', () => {
  fetcher.__resetMemoryCaches();
  const now = Date.now();
  fetcher.__noteHttpBridgeFailure('BBCA', now);
  // The failing ticker is muted...
  assert.equal(fetcher.__httpBridgeInCooldown('BBCA', now + 1000), true);
  // ...but every other ticker is untouched (this is the regression guard).
  assert.equal(fetcher.__httpBridgeInCooldown('BBRI', now + 1000), false);
  assert.equal(fetcher.__httpBridgeInCooldown('TLKM', now + 1000), false);
});

test('B2: a ticker cooldown expires after the window and resets cleanly', () => {
  fetcher.__resetMemoryCaches();
  const now = Date.now();
  fetcher.__noteHttpBridgeFailure('MEDC', now);
  assert.equal(fetcher.__httpBridgeInCooldown('MEDC', now + fetcher.HTTP_BRIDGE_COOLDOWN_MS - 1), true);
  assert.equal(fetcher.__httpBridgeInCooldown('MEDC', now + fetcher.HTTP_BRIDGE_COOLDOWN_MS + 1), false);
  fetcher.__resetMemoryCaches();
  assert.equal(fetcher.__httpBridgeInCooldown('MEDC', now + 1), false);
  assert.equal(fetcher.__httpBridgeStateSize(), 0);
});

test('B2: the source keys the cooldown per ticker and never references the old global', () => {
  assert.match(SOURCE, /httpBridgeInCooldown\(clean,/);
  assert.match(SOURCE, /noteHttpBridgeFailure\(clean,/);
  // Both the no-data and the throw branches must record a reason.
  assert.match(SOURCE, /logFetchDegradation\(clean, `bridge_no_data/);
  assert.match(SOURCE, /logFetchDegradation\(clean, `bridge_error/);
  // The global blackout variable must be gone entirely.
  assert.doesNotMatch(SOURCE, /lastHttpBridgeFailure/);
});
