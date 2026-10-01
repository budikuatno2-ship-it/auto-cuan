'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../lib/idx-suspension-guard');
const refresh = require('../tools/refresh-idx-suspensions');
const transition = require('../lib/fca-transition-2026');

function writeState(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  guard.resetCache();
}

test('stale suspension remains blocking while stale opening becomes UNKNOWN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspension-guard-'));
  const state = path.join(dir, 'state.json');
  const fetchedAt = '2026-10-01T02:00:00.000Z';
  writeState(state, {
    source: 'fixture',
    fetched_at: fetchedAt,
    by_ticker: {
      BBCA: { ticker: 'BBCA', status: 'SUSPENDED', event_at: fetchedAt },
      WIKA: { ticker: 'WIKA', status: 'ACTIVE', event_at: fetchedAt }
    }
  });

  const staleNow = new Date('2026-10-01T08:30:00.000Z');
  assert.equal(guard.getTickerState('BBCA', { statePath: state, now: staleNow }).status, 'SUSPENDED');
  assert.equal(guard.getTickerState('BBCA', { statePath: state, now: staleNow }).authoritative, true);

  const wika = guard.getTickerState('WIKA', { statePath: state, now: staleNow });
  assert.equal(wika.status, 'UNKNOWN');
  assert.equal(wika.authoritative, false);
  assert.equal(wika.stale_status, 'ACTIVE');
});

test('refresh parser applies timestamped opening, conservative suspend, and ignores unsafe untimestamped opening', () => {
  const validTickers = new Set(['BBCA', 'WIKA', 'TLKM']);
  const previous = {
    fetched_at: '2026-09-30T12:00:00.000Z',
    by_ticker: {
      WIKA: {
        ticker: 'WIKA',
        status: 'SUSPENDED',
        event_at: '2026-09-25T00:00:00+07:00',
        source: 'fixture'
      }
    }
  };
  const rows = [
    { Code: 'WIKA', Title: 'Pembukaan Suspensi WIKA', Date: '2026-09-30T09:00:00+07:00' },
    { Code: 'BBCA', Title: 'Suspensi Perdagangan BBCA' },
    { Code: 'TLKM', Title: 'Pembukaan Suspensi TLKM' }
  ];

  const out = refresh.applyEvents(previous, rows, {
    fetchedAt: '2026-10-01T01:00:00.000Z',
    validTickers
  });

  assert.equal(out.byTicker.WIKA.status, 'ACTIVE');
  assert.equal(out.byTicker.BBCA.status, 'SUSPENDED');
  assert.equal(out.byTicker.TLKM, undefined);
  assert.equal(out.skippedUnsafeOpening, 1);
});

test('fresh official suspension blocks ordinary ticker and fresh opening can reactivate a static suspended exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspension-transition-'));
  const state = path.join(dir, 'state.json');
  const fetchedAt = new Date().toISOString();
  process.env.AUTO_CUAN_SUSPENSION_STATE_PATH = state;

  writeState(state, {
    source: 'fixture',
    fetched_at: fetchedAt,
    by_ticker: {
      BBCA: { ticker: 'BBCA', status: 'SUSPENDED', event_at: fetchedAt },
      WIKA: { ticker: 'WIKA', status: 'ACTIVE', event_at: fetchedAt }
    }
  });

  assert.equal(transition.hasExplicitSuspensionSignal({ ticker: 'BBCA', board: 'UTAMA' }), true);
  assert.equal(
    transition.isEligibleContinuousAuctionRow({ ticker: 'BBCA', board: 'UTAMA', is_active: true, is_fca: false }),
    false
  );

  assert.equal(transition.isAuthoritativelyReactivated('WIKA'), true);
  assert.equal(
    transition.isEligibleContinuousAuctionRow({ ticker: 'WIKA', board: 'PENGEMBANGAN', is_active: true, is_fca: false }),
    true
  );

  delete process.env.AUTO_CUAN_SUSPENSION_STATE_PATH;
  guard.resetCache();
});
