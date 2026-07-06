'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  sanitizeTop5ResponseForAudience,
  isTop5PreviewOrProvisionalRow
} = sectorHot.__test;

test('public Top 5 sanitizer removes internal diagnostics and raw details', () => {
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: true,
    top5_source: 'locked_rows',
    top5: [{
      ticker: 'BBRI',
      raw_payload: { secret: true },
      detail: { raw: true },
      sample_rejected: [{ ticker: 'BAD' }],
      top_rejection_reasons: ['internal'],
      stageByTicker: { BBRI: { debug: true } },
      debug_notes: 'debug',
      internal_notes: 'internal',
      preview_diagnostics: { leak: true }
    }],
    picks: [{ ticker: 'BBRI', raw_payload: { secret: true } }]
  }, { allowAdminPreview: false });

  for (const row of payload.top5.concat(payload.picks)) {
    assert.equal(row.ticker, 'BBRI');
    for (const key of ['raw_payload', 'detail', 'sample_rejected', 'top_rejection_reasons', 'stageByTicker', 'debug_notes', 'internal_notes', 'preview_diagnostics']) {
      assert.equal(Object.hasOwn(row, key), false, key + ' leaked');
    }
  }
});

test('public Top 5 sanitizer removes preview and provisional rows plus admin preview blocks', () => {
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: false,
    top5_source: 'provisional_candidates',
    web_provisional: true,
    top5: [
      { ticker: 'LOCKED', publication_status: 'locked' },
      { ticker: 'PREV', is_preview: true },
      { ticker: 'PROV', is_provisional: true },
      { ticker: 'ADMIN', visibility: 'admin_preview' }
    ],
    admin_next_top5_preview: [{ ticker: 'NEXT', is_preview: true }],
    admin_next_top5_excluded_preview: [{ ticker: 'DROP', excluded_reason: 'guard' }],
    admin_next_top5_preview_count: 1,
    admin_next_top5_preview_note: 'admin only',
    admin_gate_calibration_summary: { signal_count: 1, radar_count: 2, hard_reject_count: 3 }
  }, { allowAdminPreview: false });

  assert.deepEqual(payload.top5.map((r) => r.ticker), ['LOCKED']);
  assert.equal(payload.top5_source, 'awaiting_locked_rows');
  assert.equal(payload.web_provisional, false);
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_preview'), false);
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_excluded_preview'), false);
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_preview_note'), false);
  assert.equal(Object.hasOwn(payload, 'admin_gate_calibration_summary'), false);
});

test('missing locked public Top 5 returns safe empty state, not provisional fallback', () => {
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: false,
    top5_source: 'provisional_candidates',
    web_provisional: true,
    top5: [{ ticker: 'TEMP', is_provisional: true }],
    picks: [{ ticker: 'TEMP', is_provisional: true }],
    update_note: 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.'
  }, { allowAdminPreview: false });

  assert.deepEqual(payload.top5, []);
  assert.deepEqual(payload.picks, []);
  assert.equal(payload.top5_source, 'awaiting_locked_rows');
  assert.equal(payload.web_provisional, false);
  assert.match(payload.update_note, /Top 5 final/);
});

test('admin Top 5 sanitizer can keep backend-gated preview with clear labels', () => {
  assert.equal(isTop5PreviewOrProvisionalRow({ is_preview: true }), true);
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: false,
    top5_source: 'provisional_candidates',
    web_provisional: true,
    admin_next_top5_preview: [{ ticker: 'NEXT', is_preview: true, raw_payload: { secret: true } }]
  }, { allowAdminPreview: true });

  assert.equal(payload.admin_next_top5_preview.length, 1);
  assert.equal(payload.admin_next_top5_preview[0].preview_label, 'Preview');
  assert.equal(payload.admin_next_top5_preview[0].provisional_label, 'Provisional');
  assert.equal(payload.admin_next_top5_preview[0].publication_status, 'provisional');
  assert.equal(Object.hasOwn(payload.admin_next_top5_preview[0], 'raw_payload'), false);
});


test('admin Top 5 sanitizer can keep safe calibration summary counts', () => {
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: false,
    admin_gate_calibration_summary: { signal_count: 1, radar_count: 2, hard_reject_count: 3, sample_rejected: [{ ticker: 'BAD' }] }
  }, { allowAdminPreview: true });

  assert.equal(payload.admin_gate_calibration_summary.signal_count, 1);
  assert.equal(payload.admin_gate_calibration_summary.radar_count, 2);
  assert.equal(payload.admin_gate_calibration_summary.hard_reject_count, 3);
});
