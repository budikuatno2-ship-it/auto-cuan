'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const radar =
  require('../lib/intraday-fast-watcher-radar-publisher');

const confirmed =
  require('../lib/intraday-fast-watcher-publisher');

function stateItem(status, sourceStatus) {
  return {
    active: true,
    status,
    source_status:
      sourceStatus || 'EARLY_RADAR',
    last_watch_score: 75,
    last_publish_score: 70,
    last_reasons: [
      'relative_volume_support'
    ],
    last_observation: {
      current_price: 101,
      entry_low: 98,
      entry_high: 103,
      tp1: 115,
      tp2: 120,
      stop_loss: 95,
      risk_reward: 2,
      relative_volume: 1.5
    },
    last_metrics: {}
  };
}

test(
  'pending candidate remains a priority Radar opportunity',
  () => {
    const plan = radar.planFrom(
      'TEST',
      stateItem('READY_PENDING')
    );

    assert.equal(
      plan.status,
      'RADAR PRIORITAS — 1/2 KONFIRMASI'
    );

    const message =
      radar.buildRadarTelegramMessage(
        [plan],
        '2026-08-05',
        '10:45'
      );

    assert.match(
      message,
      /Peluang sedang menguat/
    );

    assert.match(
      message,
      /baru 1 dari 2 konfirmasi/
    );

    assert.match(
      message,
      /Radar dapat bergerak lebih dulu/
    );
  }
);

test(
  'spike remains visible but explicitly warns against chase',
  () => {
    const item =
      stateItem('SPIKE_RADAR');

    item.last_reasons = [
      'adaptive_advance_chase',
      'spike_detected_informational_only'
    ];

    const plan = radar.planFrom(
      'SPIK',
      item
    );

    assert.equal(
      plan.status,
      'SPIKE TERDETEKSI — JANGAN CHASE'
    );

    assert.match(
      radar.buildRadarTelegramMessage(
        [plan],
        '2026-08-05',
        '10:45'
      ),
      /Momentum sudah bergerak/
    );
  }
);

test(
  'confirmed publisher clearly identifies confirmed signal',
  () => {
    const message =
      confirmed.buildTelegramMessage(
        {
          ticker: 'TEST',
          ready_streak: 2,
          watch_score: 80,
          publish_score: 85,
          observation: {
            current_price: 101,
            entry_low: 98,
            entry_high: 103,
            tp1: 115,
            stop_loss: 95,
            metrics: {}
          }
        },
        '2026-08-05',
        '10:47'
      );

    assert.match(
      message,
      /SIGNAL TERKONFIRMASI/
    );

    assert.match(
      message,
      /aturan 2 dari 3 snapshot/
    );

    assert.doesNotMatch(
      message,
      /berturut-turut/
    );
  }
);

test(
  'Day Trade response separates confirmed and priority Radar counters',
  () => {
    const source = fs.readFileSync(
      'api/sector-hot.js',
      'utf8'
    );

    assert.match(
      source,
      /var confirmedSignalCount/
    );

    assert.match(
      source,
      /var priorityRadarCount/
    );

    assert.match(
      source,
      /confirmed_signal_count/
    );

    assert.match(
      source,
      /priority_radar_count/
    );

    assert.match(
      source,
      /PRIORITY OPPORTUNITY = CONFIRMED SIGNAL \+ PRE-SPIKE RADAR/
    );
  }
);
